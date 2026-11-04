package vault

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Content caching bounds. A single note larger than contentCacheMaxBytes is
// still listed and searched (its content is read on demand), it is just not
// kept in memory. The *Budget caps the total bytes the index is willing to
// hold for each payload; when a budget fills up the least recently used
// payload is evicted (LRU) instead of the cache being disabled, so a large
// vault degrades gradually rather than falling off a cliff.
//
// foldCacheBudget holds the accent-folded copy of note text used by search.
// It is budgeted separately from content because search only needs the folded
// text of *every* note, while snippets (and everything else) only need the
// original content of the few notes that match.
var (
	contentCacheMaxBytes int64 = 2 << 20  // 2 MiB per note
	contentCacheBudget   int64 = 64 << 20 // 64 MiB total
	foldCacheMaxBytes    int64 = 2 << 20  // 2 MiB per note
	foldCacheBudget      int64 = 64 << 20 // 64 MiB total
)

// LinkOcc is one link occurrence inside a note, captured when the note is
// indexed (so backlinks and the graph never re-scan note text per request).
// Target holds the raw link as written: for wikilinks the text after "#"
// truncation, for markdown links the full destination (fragment included).
type LinkOcc struct {
	Target  string
	Line    int
	Type    string // "wikilink" or "markdown"
	Context string // surrounding text window, exactly as backlinks showed it
}

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

	// Accent-folded lowercase copy of content, used by search (notes only).
	folded    string
	hasFolded bool

	// Link occurrences extracted at index time (notes only). hasLinks tells
	// "extracted, none found" apart from "never extracted".
	wikiLinks []LinkOcc
	mdLinks   []LinkOcc
	hasLinks  bool

	// Recency counters for the two eviction pools, in Index.tick units.
	usedContent atomic.Int64
	usedFold    atomic.Int64

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
// carries its own mutex because readers run concurrently under RLock. The one
// exception is the persistence loop, which reads a self-consistent copy via
// snapshot() under ix.mu only — it never needs v.mu, so a save can run while
// requests keep serving.
type Index struct {
	mu      sync.RWMutex
	entries map[string]*indexEntry

	// dirty records that entries changed since the last successful disk
	// write; the persistence loop flushes only while it is set.
	dirty atomic.Bool

	// contentBytes is the total size of cached note contents.
	contentBytes int64

	// foldedBytes is the total size of cached folded texts.
	foldedBytes int64

	// tick is a monotonic counter used as the LRU clock.
	tick atomic.Int64
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

	wiki, md := extractOutLinks(content)

	ix.mu.Lock()
	defer ix.mu.Unlock()

	if old := ix.entries[rel]; old != nil {
		ix.releaseEntryLocked(old)
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
		// Links are extracted once here (and on every content refresh) so
		// backlinks/graph queries never have to re-parse note text.
		wikiLinks: wiki,
		mdLinks:   md,
		hasLinks:  true,
	}
	e.usedContent.Store(ix.tick.Add(1))
	e.usedFold.Store(ix.tick.Add(1))

	if int64(len(content)) <= contentCacheMaxBytes {
		ix.makeContentRoomLocked(int64(len(content)), rel)
		if ix.contentBytes+int64(len(content)) <= contentCacheBudget {
			e.hasContent = true
			ix.contentBytes += int64(len(content))
		} else {
			e.content = ""
		}
	} else {
		e.content = ""
	}
	ix.entries[rel] = e
	ix.dirty.Store(true)
	return tags
}

// putMedia stores the index entry of a media file (metadata only).
func (ix *Index) putMedia(rel, name, folder, mediaType string, mtime time.Time, size int64) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if old, ok := ix.entries[rel]; ok {
		ix.releaseEntryLocked(old)
	}
	ix.entries[rel] = &indexEntry{
		mtime:  mtime,
		size:   size,
		name:   name,
		folder: folder,
		typ:    mediaType,
	}
	ix.dirty.Store(true)
}

// releaseEntryLocked drops both cached payloads of an entry and returns their
// bytes to the budgets. Callers must hold ix.mu and must discard or fully
// refresh the entry afterwards: its content and folded text are only valid for
// the (mtime, size) they were read from.
func (ix *Index) releaseEntryLocked(e *indexEntry) {
	if e.hasContent {
		ix.contentBytes -= int64(len(e.content))
		e.hasContent = false
		e.content = ""
	}
	if e.hasFolded {
		ix.foldedBytes -= int64(len(e.folded))
		e.hasFolded = false
		e.folded = ""
	}
	e.hasLinks = false
	e.wikiLinks = nil
	e.mdLinks = nil
}

// makeContentRoomLocked evicts least-recently-used content (never excludeRel)
// until need more bytes fit in contentCacheBudget. No-op when they already fit.
func (ix *Index) makeContentRoomLocked(need int64, excludeRel string) {
	ix.makeRoomLocked(&ix.contentBytes, contentCacheBudget, need, excludeRel,
		func(e *indexEntry) bool { return e.hasContent },
		func(e *indexEntry) int64 { return e.usedContent.Load() },
		func(e *indexEntry) {
			ix.contentBytes -= int64(len(e.content))
			e.hasContent = false
			e.content = ""
		},
	)
}

// makeFoldRoomLocked is makeContentRoomLocked for the folded-text pool.
func (ix *Index) makeFoldRoomLocked(need int64, excludeRel string) {
	ix.makeRoomLocked(&ix.foldedBytes, foldCacheBudget, need, excludeRel,
		func(e *indexEntry) bool { return e.hasFolded },
		func(e *indexEntry) int64 { return e.usedFold.Load() },
		func(e *indexEntry) {
			ix.foldedBytes -= int64(len(e.folded))
			e.hasFolded = false
			e.folded = ""
		},
	)
}

// evictionSampleSize bounds how many entries one eviction pass inspects.
//
// Eviction is sampled instead of exact on purpose: the recency counters live in
// atomics so cache hits can stay under RLock (many concurrent readers, no list
// mutation), which rules out keeping an intrusive LRU list. Sorting the whole
// index on every insert is the alternative, and that is O(n log n) per note —
// with a vault bigger than the cache budget it turns a scan into hours.
// Sampling keeps eviction O(1) and is the standard approximation (Redis does
// the same); a payload evicted slightly later than the true oldest is replaced
// on demand anyway.
const evictionSampleSize = 64

// makeRoomLocked frees bytes from pool until need more bytes fit budget,
// dropping recently-unsampled payloads first. has reports whether an entry
// still carries the payload and drop reclaims one entry's payload.
func (ix *Index) makeRoomLocked(pool *int64, budget, need int64, excludeRel string, has func(*indexEntry) bool, recency func(*indexEntry) int64, drop func(*indexEntry)) {
	for *pool+need > budget {
		e := ix.oldestSampledLocked(excludeRel, has, recency)
		if e == nil {
			// Nothing left to evict: the caller sees the budget still
			// exceeded and drops the payload it was trying to store.
			return
		}
		drop(e)
	}
}

// oldestSampledLocked returns the least recently used entry carrying a payload
// among a bounded random sample of the index, or nil when no entry qualifies.
// Iteration over a Go map starts at a random bucket, so the first
// evictionSampleSize candidates are an unbiased sample.
func (ix *Index) oldestSampledLocked(excludeRel string, has func(*indexEntry) bool, recency func(*indexEntry) int64) *indexEntry {
	var oldest *indexEntry
	var oldestOrder int64
	examined := 0
	for rel, e := range ix.entries {
		if rel == excludeRel || !has(e) {
			continue
		}
		if order := recency(e); oldest == nil || order < oldestOrder {
			oldest, oldestOrder = e, order
		}
		if examined++; examined >= evictionSampleSize {
			break
		}
	}
	return oldest
}

// cacheContent records note content read outside a scan (e.g. GetNoteContent)
// so subsequent searches do not hit the disk again. Creates the entry when the
// file was never scanned. Because a refreshed entry makes the next scan skip
// the file, tags and links are refreshed together with the bytes; only the
// content payload itself is dropped when it grows past the per-note bound or
// the budget cannot free enough room (LRU eviction), in which case the entry
// still serves metadata and the content is read on demand.
func (ix *Index) cacheContent(rel string, mtime time.Time, size int64, content string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	e, ok := ix.entries[rel]
	if ok && !e.isNote {
		return
	}
	stale := ok && !e.matches(mtime, size)
	if ok && e.hasContent && !stale {
		return
	}

	name := rel
	folder := ""
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		name = rel[i+1:]
		folder = rel[:i]
	}
	if j := strings.LastIndex(name, "."); j > 0 {
		name = name[:j]
	}

	if !ok {
		e = &indexEntry{mtime: mtime, size: size, name: name, folder: folder, typ: "note", isNote: true}
		ix.entries[rel] = e
	} else {
		if stale {
			// External edit: cached content/folded text belong to old bytes.
			ix.releaseEntryLocked(e)
		}
		e.mtime = mtime
		e.size = size
		e.name = name
		e.folder = folder
	}
	if !e.hasLinks {
		e.tags = ParseTags(content)
		e.wikiLinks, e.mdLinks = extractOutLinks(content)
		e.hasLinks = true
		// Every path that reached this point either created the entry or
		// (stale) released it — releaseEntryLocked clears hasLinks — so the
		// persisted fields changed. A plain content-cache hit on an intact
		// entry returns above and stays clean.
		ix.dirty.Store(true)
	}

	if int64(len(content)) > contentCacheMaxBytes {
		return
	}
	ix.makeContentRoomLocked(int64(len(content)), rel)
	if ix.contentBytes+int64(len(content)) > contentCacheBudget {
		return
	}
	e.content = content
	e.hasContent = true
	ix.contentBytes += int64(len(content))
	e.usedContent.Store(ix.tick.Add(1))
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
	e.usedContent.Store(ix.tick.Add(1))
	return e.content, true
}

// cachedFold returns the cached accent-folded text of rel when the entry
// still matches the observed filesystem state.
func (ix *Index) cachedFold(rel string, mtime time.Time, size int64) (string, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	e, ok := ix.entries[rel]
	if !ok || !e.matches(mtime, size) || !e.isNote || !e.hasFolded {
		return "", false
	}
	e.usedFold.Store(ix.tick.Add(1))
	return e.folded, true
}

// putFold caches the folded text of rel. It only attaches to an entry that
// already exists and matches the observed file state: an entry created or
// retimestamped without re-parsing tags/links would make the next scan trust
// incomplete data, so callers must scan (or read) the note first.
func (ix *Index) putFold(rel string, mtime time.Time, size int64, folded string) {
	if folded == "" || int64(len(folded)) > foldCacheMaxBytes {
		return
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()

	e, ok := ix.entries[rel]
	if !ok || !e.isNote || !e.matches(mtime, size) {
		return
	}
	if e.hasFolded {
		ix.foldedBytes -= int64(len(e.folded))
		e.hasFolded = false
		e.folded = ""
	}
	ix.makeFoldRoomLocked(int64(len(folded)), rel)
	if ix.foldedBytes+int64(len(folded)) > foldCacheBudget {
		return
	}
	e.folded = folded
	e.hasFolded = true
	ix.foldedBytes += int64(len(folded))
	e.usedFold.Store(ix.tick.Add(1))
}

// links returns the link occurrences recorded for a note. The slices are
// read-only and safe to share: entries are replaced, never mutated in place.
func (ix *Index) links(rel string) (wiki, md []LinkOcc) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	e, ok := ix.entries[rel]
	if !ok || !e.isNote || !e.hasLinks {
		return nil, nil
	}
	return e.wikiLinks, e.mdLinks
}

// drop removes a single entry.
func (ix *Index) drop(rel string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if e, ok := ix.entries[rel]; ok {
		ix.releaseEntryLocked(e)
		delete(ix.entries, rel)
		ix.dirty.Store(true)
	}
}

// dropPrefix removes every entry under a folder path ("" drops everything the
// caller marked, i.e. used after folder delete/move).
func (ix *Index) dropPrefix(prefix string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	for k, e := range ix.entries {
		if prefix == "" || k == prefix || (len(k) > len(prefix) && k[:len(prefix)] == prefix && k[len(prefix)] == '/') {
			ix.releaseEntryLocked(e)
			delete(ix.entries, k)
			ix.dirty.Store(true)
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
			ix.releaseEntryLocked(e)
			delete(ix.entries, k)
			ix.dirty.Store(true)
		}
	}
}

// snapshot copies the persisted projection of every entry (see persistedEntry)
// under a single read lock, giving the persistence loop a self-consistent view
// without needing the vault lock. Content and folded text are excluded: they
// are the large, cheaply derivable halves of the cache.
func (ix *Index) snapshot() []persistedEntry {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	out := make([]persistedEntry, 0, len(ix.entries))
	for rel, e := range ix.entries {
		out = append(out, persistedEntry{
			Rel:       rel,
			MTime:     e.mtime,
			Size:      e.size,
			Name:      e.name,
			Folder:    e.folder,
			Typ:       e.typ,
			Tags:      e.tags,
			IsNote:    e.isNote,
			HasLinks:  e.hasLinks,
			WikiLinks: e.wikiLinks,
			MdLinks:   e.mdLinks,
		})
	}
	return out
}

// restore replaces the index with the entries read from disk. Content and
// folded text start empty by design (they were never persisted): a restored
// note still needs to be read once before search can match it, but listings,
// tags and backlinks answer immediately. Callers only invoke this on a fresh
// index, right after loading the file and before the first scan.
func (ix *Index) restore(entries []persistedEntry) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	ix.entries = make(map[string]*indexEntry, len(entries))
	ix.contentBytes = 0
	ix.foldedBytes = 0
	for _, p := range entries {
		ix.entries[p.Rel] = &indexEntry{
			mtime:     p.MTime,
			size:      p.Size,
			name:      p.Name,
			folder:    p.Folder,
			typ:       p.Typ,
			tags:      p.Tags,
			isNote:    p.IsNote,
			wikiLinks: p.WikiLinks,
			mdLinks:   p.MdLinks,
			hasLinks:  p.HasLinks,
		}
	}
}
