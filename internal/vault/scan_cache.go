package vault

import (
	"io/fs"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// scanCacheTTL bounds how long a walk result may be served without touching
// the filesystem. Writes made through the app patch or invalidate the cache
// immediately, so the TTL only governs changes made *outside* the app (another
// editor, git checkout, sync tool). Tests lower it to observe external edits
// without waiting.
var scanCacheTTL = 2 * time.Second

// scanSnapshot is an immutable projection of one directory walk. Writers
// replace the whole snapshot (copy-on-write) instead of mutating the slices in
// place, so a caller may keep iterating a snapshot after releasing the vault
// lock while a save patches the cache. Derived views (tag counts, the backlink
// reverse index) are built lazily once per snapshot and cached behind lazyMu.
type scanSnapshot struct {
	all     []NoteRecord // notes and media, sorted by MTime descending
	notes   []NoteRecord // notes only, same order
	folders []string     // sorted

	resolver *LinkResolver

	lazyMu  sync.Mutex
	tags    map[string]int
	linkIdx *backlinkIndex
}

// scanCache holds the last directory walk so listings, tags, search, stats and
// the graph do not re-walk the whole tree on every request. The .md files stay
// the source of truth: the snapshot is a cheap projection of them, refreshed by
// every app write and at most scanCacheTTL behind for external edits.
type scanCache struct {
	mu    sync.Mutex
	valid bool // a walk has been stored
	stale bool // an app write requires a fresh walk
	at    time.Time
	snap  *scanSnapshot
}

// current returns the snapshot when it is still usable within ttl. The caller
// receives a read-only view: the slices are never mutated after publication.
func (c *scanCache) current(ttl time.Duration) *scanSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.valid || c.stale || c.snap == nil || time.Since(c.at) >= ttl {
		return nil
	}
	return c.snap
}

// store publishes a fresh walk result and returns the new snapshot. The walk
// slices are owned by the cache from this point on; ScanNotes hands them out as
// read-only views.
func (c *scanCache) store(notes []NoteRecord, folders []string) *scanSnapshot {
	sortNotesByMTime(notes)
	snap := newSnapshot(notes, folders, nil)

	c.mu.Lock()
	c.snap = snap
	c.valid = true
	c.stale = false
	c.at = time.Now()
	c.mu.Unlock()
	return snap
}

// invalidate forces the next scan to walk the tree again. Used after
// structural changes (moves, folder operations, media uploads) where patching
// the snapshot would be more code than the single walk it saves.
func (c *scanCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stale = true
}

// noteSaved patches the snapshot after SaveNote wrote a note, so the next
// listing/search sees the change without a walk. Non-markdown writes fall back
// to invalidate() instead of patching.
func (c *scanCache) noteSaved(rec NoteRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.valid || c.snap == nil {
		return
	}
	if !strings.EqualFold(filepath.Ext(rec.Path), ".md") {
		c.stale = true
		return
	}

	all := make([]NoteRecord, len(c.snap.all))
	copy(all, c.snap.all)
	idx := -1
	for i := range all {
		if all[i].Path == rec.Path {
			idx = i
			break
		}
	}
	resolver := c.snap.resolver
	if idx >= 0 {
		all[idx] = rec
	} else {
		all = append(all, rec)
		// A new path invalidates the resolver's path/name maps.
		resolver = nil
	}
	sortNotesByMTime(all)
	c.snap = newSnapshot(all, addFolders(c.snap.folders, rec.Folder), resolver)
}

// noteDeleted removes a note from the snapshot. The folder list is untouched:
// a walk keeps reporting directories even when they become empty.
func (c *scanCache) noteDeleted(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.valid || c.snap == nil {
		return
	}
	all := make([]NoteRecord, 0, len(c.snap.all))
	for _, n := range c.snap.all {
		if n.Path != path {
			all = append(all, n)
		}
	}
	c.snap = newSnapshot(all, c.snap.folders, nil)
}

// addFolders returns a folders slice that also lists folder and its parents,
// mirroring what the next walk would report for a note saved into a freshly
// created folder. The input slice is never mutated.
func addFolders(folders []string, folder string) []string {
	if folder == "" {
		return folders
	}
	segments := strings.Split(folder, "/")
	out := folders
	copied := false
	for i := 1; i <= len(segments); i++ {
		p := strings.Join(segments[:i], "/")
		if !slices.Contains(out, p) {
			if !copied {
				out = append([]string(nil), out...)
				copied = true
			}
			out = append(out, p)
		}
	}
	if copied {
		sort.Strings(out)
	}
	return out
}

// makeNoteRecord builds the listing record for a note the app just wrote,
// deriving the same fields ScanNotes derives from the walk.
func makeNoteRecord(rel string, info fs.FileInfo, tags []string) NoteRecord {
	name := strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel))
	folder := filepath.Dir(rel)
	if folder == "." {
		folder = ""
	} else {
		// filepath.Dir emits the platform separator; records are kept in slash
		// form everywhere so folder paths are cross-platform equal.
		folder = strings.ReplaceAll(folder, "\\", "/")
	}
	return NoteRecord{
		Name:     name,
		Path:     rel,
		Folder:   folder,
		Modified: FormatTime(info.ModTime()),
		Size:     info.Size(),
		Type:     "note",
		Tags:     tags,
		MTime:    float64(info.ModTime().UnixNano()) / 1e9,
		modTime:  info.ModTime(),
	}
}

// newSnapshot builds the derived views of a walk result. resolver is reused
// when the note path set did not change (content-only saves); otherwise it is
// built from the notes in this snapshot.
func newSnapshot(all []NoteRecord, folders []string, resolver *LinkResolver) *scanSnapshot {
	notes := make([]NoteRecord, 0, len(all))
	for _, n := range all {
		if n.Type == "note" {
			notes = append(notes, n)
		}
	}
	if resolver == nil {
		resolver = NewLinkResolver(scanNotePaths(notes))
	}
	return &scanSnapshot{
		all:      all,
		notes:    notes,
		folders:  folders,
		resolver: resolver,
	}
}

// scanNotePaths returns the vault-relative path of every note record.
func scanNotePaths(notes []NoteRecord) []string {
	out := make([]string, 0, len(notes))
	for _, n := range notes {
		if n.Type == "note" {
			out = append(out, n.Path)
		}
	}
	return out
}

// sortNotesByMTime orders records newest first. Path breaks ties so pagination
// is deterministic when two files share an mtime.
func sortNotesByMTime(notes []NoteRecord) {
	sort.Slice(notes, func(i, j int) bool {
		if notes[i].MTime == notes[j].MTime {
			return notes[i].Path < notes[j].Path
		}
		return notes[i].MTime > notes[j].MTime
	})
}

// tagCounts returns a copy of the tag histogram for this snapshot. The copy
// keeps callers from mutating the cached map.
func (s *scanSnapshot) tagCounts() map[string]int {
	s.lazyMu.Lock()
	defer s.lazyMu.Unlock()

	if s.tags == nil {
		counts := make(map[string]int)
		for _, n := range s.notes {
			for _, tag := range n.Tags {
				counts[tag]++
			}
		}
		s.tags = counts
	}

	out := make(map[string]int, len(s.tags))
	for tag, count := range s.tags {
		out[tag] = count
	}
	return out
}

// backlinks lazily builds (once) the reverse link index for this snapshot.
// links reads the occurrences recorded in the vault index.
func (s *scanSnapshot) backlinks(links func(string) ([]LinkOcc, []LinkOcc)) *backlinkIndex {
	s.lazyMu.Lock()
	defer s.lazyMu.Unlock()

	if s.linkIdx == nil {
		s.linkIdx = buildBacklinkIndex(s.notes, links)
	}
	return s.linkIdx
}
