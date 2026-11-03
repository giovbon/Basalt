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

// scanCache holds the last directory walk so listings, tags, search, stats and
// the graph do not re-walk the whole tree on every request. The .md files stay
// the source of truth: the snapshot is a cheap projection of them, refreshed by
// every app write and at most scanCacheTTL behind for external edits.
//
// Callers of Vault.ScanNotes must keep treating the returned slices as their
// own (they sort them in place); get() hands out copies, never the stored ones.
type scanCache struct {
	mu    sync.Mutex
	valid bool // a walk has been stored
	stale bool // an app write requires a fresh walk
	at    time.Time

	notes   []NoteRecord // walk result including media; callers filter
	folders []string     // sorted, like the walk returns them
}

// get returns copies of the cached walk when it is still usable.
func (c *scanCache) get(includeMedia bool) (notes []NoteRecord, folders []string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.valid || c.stale || time.Since(c.at) >= scanCacheTTL {
		return nil, nil, false
	}

	notes = make([]NoteRecord, 0, len(c.notes))
	for _, n := range c.notes {
		if includeMedia || n.Type == "note" {
			notes = append(notes, n)
		}
	}
	folders = make([]string, len(c.folders))
	copy(folders, c.folders)
	return notes, folders, true
}

// store takes ownership of the walk slices and serves them from then on.
func (c *scanCache) store(notes []NoteRecord, folders []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.notes = notes
	c.folders = folders
	c.valid = true
	c.stale = false
	c.at = time.Now()
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

	if !c.valid {
		return
	}
	if !strings.EqualFold(filepath.Ext(rec.Path), ".md") {
		c.stale = true
		return
	}
	if i := slices.IndexFunc(c.notes, func(n NoteRecord) bool { return n.Path == rec.Path }); i >= 0 {
		c.notes[i] = rec
	} else {
		c.notes = append(c.notes, rec)
	}
	c.addFoldersLocked(rec.Folder)
}

// noteDeleted removes a note from the snapshot. The folder list is untouched:
// a walk keeps reporting directories even when they become empty.
func (c *scanCache) noteDeleted(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.valid {
		return
	}
	if i := slices.IndexFunc(c.notes, func(n NoteRecord) bool { return n.Path == path }); i >= 0 {
		c.notes = append(c.notes[:i], c.notes[i+1:]...)
	}
}

// addFoldersLocked ensures folder and its parents are listed, mirroring what
// the next walk would report for a note saved into a freshly created folder.
func (c *scanCache) addFoldersLocked(folder string) {
	if folder == "" {
		return
	}
	segments := strings.Split(folder, "/")
	for i := 1; i <= len(segments); i++ {
		p := strings.Join(segments[:i], "/")
		if !slices.Contains(c.folders, p) {
			c.folders = append(c.folders, p)
			sort.Strings(c.folders)
		}
	}
}

// makeNoteRecord builds the listing record for a note the app just wrote,
// deriving the same fields ScanNotes derives from the walk.
func makeNoteRecord(rel string, info fs.FileInfo, tags []string) NoteRecord {
	name := strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel))
	folder := filepath.Dir(rel)
	if folder == "." {
		folder = ""
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
	}
}
