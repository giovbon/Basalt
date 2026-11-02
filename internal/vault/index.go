package vault

import (
	"strings"
	"sync"
	"time"
)

// Content caching bounds. A single note larger than contentCacheMaxBytes is
// still listed and searched (its content is read on demand), it is just not
// kept in memory. contentCacheBudget caps the total bytes of note content the
// index is willing to hold so a very large vault degrades to "tags only"
// instead of ballooning the process.
const (
	contentCacheMaxBytes = 2 << 20  // 2 MiB per note
	contentCacheBudget   = 64 << 20 // 64 MiB total
)

// indexEntry mirrors the on-disk state of a single vault file. Entries are
// only trusted while (mtime, size) still match the filesystem, so edits made
// outside the app (another editor, git checkout, sync tool) are picked up on
// the next scan without any watcher.
type indexEntry struct {
	mtime time.Time
	size  int64

	// Record fields, valid for both notes and media files.
	name   string // stem without extension
	folder string
	typ    string // "note" or media type

	// Parsed frontmatter tags (notes only).
	tags []string

	// CRLF-normalized content (notes only, subject to the bounds above).
	content    string
	hasContent bool

	// True for markdown notes; media entries carry no tags/content.
	isNote bool
}

func (e *indexEntry) matches(mtime time.Time, size int64) bool {
	return e.mtime.Equal(mtime) && e.size == size
}

// Index is an in-memory mirror of the vault that avoids re-reading every note
// on each request. ScanNotes still walks the directory tree (stat is cheap and
// required to notice new/deleted files), but only files whose (mtime, size)
// changed are read and re-parsed.
//
// All Index methods are called while the owning Vault holds its lock; Index
// carries its own mutex because readers run concurrently under RLock.
type Index struct {
	mu      sync.RWMutex
	entries map[string]*indexEntry

	// contentBytes is the total size of cached note contents.
	contentBytes int64
}

func newIndex() *Index {
	return &Index{entries: make(map[string]*indexEntry)}
}

// get returns the cached entry for rel and reports whether it still matches
// the filesystem state observed by the caller.
func (ix *Index) get(rel string, mtime time.Time, size int64) (*indexEntry, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	e, ok := ix.entries[rel]
	if !ok || !e.matches(mtime, size) {
		return nil, false
	}
	return e, true
}

// putNote stores (or refreshes) the index entry of a markdown note, caching
// its content when it fits the memory bounds. The record fields (name,
// folder) are derived from the vault-relative path. Returns the parsed tags.
func (ix *Index) putNote(rel string, mtime time.Time, size int64, content string) []string {
	// Same normalization GetNoteContent applies, so cached bytes and disk
	// reads are interchangeable.
	content = strings.ReplaceAll(content, "\r\n", "\n")
	tags := ParseTags(content)

	name := rel
	folder := ""
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		name = rel[i+1:]
		folder = rel[:i]
	}
	if j := strings.LastIndex(name, "."); j > 0 {
		name = name[:j]
	}

	ix.mu.Lock()
	defer ix.mu.Unlock()

	old := ix.entries[rel]
	if old != nil && old.hasContent {
		ix.contentBytes -= int64(len(old.content))
	}

	e := &indexEntry{
		mtime:   mtime,
		size:    size,
		name:    name,
		folder:  folder,
		typ:     "note",
		tags:    tags,
		isNote:  true,
		content: content,
	}
	if int64(len(content)) <= contentCacheMaxBytes && ix.contentBytes+int64(len(content)) <= contentCacheBudget {
		e.hasContent = true
		ix.contentBytes += int64(len(content))
	} else {
		e.content = ""
	}
	ix.entries[rel] = e
	return tags
}

// putMedia stores the index entry of a media file (metadata only).
func (ix *Index) putMedia(rel, name, folder, mediaType string, mtime time.Time, size int64) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if old, ok := ix.entries[rel]; ok && old.hasContent {
		ix.contentBytes -= int64(len(old.content))
	}
	ix.entries[rel] = &indexEntry{
		mtime:  mtime,
		size:   size,
		name:   name,
		folder: folder,
		typ:    mediaType,
	}
}

// cacheContent records note content read outside a scan (e.g. GetNoteContent)
// so subsequent searches do not hit the disk again. Creates the entry when the
// file was never scanned. No-op when the file grew past the per-note bound or
// the total budget is exhausted.
func (ix *Index) cacheContent(rel string, mtime time.Time, size int64, content string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	e, ok := ix.entries[rel]
	if ok && !e.isNote {
		return
	}
	if ok && e.hasContent {
		if e.matches(mtime, size) {
			return
		}
		// Stale entry (external edit): drop the old content before refreshing.
		ix.contentBytes -= int64(len(e.content))
		e.hasContent = false
		e.content = ""
	}
	if int64(len(content)) > contentCacheMaxBytes || ix.contentBytes+int64(len(content)) > contentCacheBudget {
		return
	}
	if !ok {
		name := rel
		folder := ""
		if i := strings.LastIndex(rel, "/"); i >= 0 {
			name = rel[i+1:]
			folder = rel[:i]
		}
		if j := strings.LastIndex(name, "."); j > 0 {
			name = name[:j]
		}
		e = &indexEntry{mtime: mtime, size: size, name: name, folder: folder, typ: "note", isNote: true}
		ix.entries[rel] = e
	} else {
		e.mtime = mtime
		e.size = size
	}
	e.content = content
	e.hasContent = true
	ix.contentBytes += int64(len(content))
}

// cachedContent returns the cached content of rel when the entry still
// matches the observed filesystem state.
func (ix *Index) cachedContent(rel string, mtime time.Time, size int64) (string, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	e, ok := ix.entries[rel]
	if !ok || !e.matches(mtime, size) || !e.isNote || !e.hasContent {
		return "", false
	}
	return e.content, true
}

// drop removes a single entry.
func (ix *Index) drop(rel string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if e, ok := ix.entries[rel]; ok {
		if e.hasContent {
			ix.contentBytes -= int64(len(e.content))
		}
		delete(ix.entries, rel)
	}
}

// dropPrefix removes every entry under a folder path ("" drops everything the
// caller marked, i.e. used after folder delete/move).
func (ix *Index) dropPrefix(prefix string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for k, e := range ix.entries {
		if prefix == "" || k == prefix || (len(k) > len(prefix) && k[:len(prefix)] == prefix && k[len(prefix)] == '/') {
			if e.hasContent {
				ix.contentBytes -= int64(len(e.content))
			}
			delete(ix.entries, k)
		}
	}
}

// prune drops entries for files that no longer exist. seen holds every
// vault-relative path the last walk encountered.
func (ix *Index) prune(seen map[string]struct{}) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for k, e := range ix.entries {
		if _, ok := seen[k]; !ok {
			if e.hasContent {
				ix.contentBytes -= int64(len(e.content))
			}
			delete(ix.entries, k)
		}
	}
}
