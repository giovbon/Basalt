package vault

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

// watcherScanTTL is the safety-net walk interval while the watcher is
// confirmed healthy: every change already reaches the index through an event,
// so this only bounds the rare event the kernel dropped. Without a healthy
// watcher, scanCacheTTL (2s) applies instead — the behaviour the app had
// before watchers existed.
var watcherScanTTL = 30 * time.Second

// watcherProbeTimeout bounds how long StartWatching waits to see its own
// probe file come back as an event. Filesystems without inotify support
// (WSL's /mnt/c drvfs, some Docker Desktop bind mounts) never deliver it and
// fall back to the plain TTL refresh.
var watcherProbeTimeout = 500 * time.Millisecond

// vaultWatcher mirrors filesystem changes into the index and the listing
// snapshot the moment they happen, instead of waiting for the next walk. It
// turns "an external edit shows up within 2s" into "it shows up on the next
// request", and it also catches the same-mtime/same-size rewrite that stat
// validation alone cannot see.
//
// The .md files stay the source of truth: the watcher only keeps the
// in-memory caches honest, and the scan TTL remains as a safety net for
// whatever an event never reported.
type vaultWatcher struct {
	v       *Vault
	w       *fsnotify.Watcher
	healthy atomic.Bool

	// watched records every directory currently under watch, keyed by the
	// path it was added with. Only the event loop (and the initial probe)
	// touches it, so it needs no lock.
	watched map[string]struct{}
	done    chan struct{}
	exited  chan struct{}
	once    sync.Once
}

// StartWatching begins mirroring filesystem changes into the index. It fails
// (non-fatally for the app) when the filesystem cannot deliver change events:
// the vault then keeps working with the plain scanCacheTTL refresh, which is
// exactly the behaviour it had before watchers existed.
func (v *Vault) StartWatching() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("creating watcher: %w", err)
	}
	vw := &vaultWatcher{
		v:       v,
		w:       w,
		watched: make(map[string]struct{}),
		done:    make(chan struct{}),
		exited:  make(chan struct{}),
	}
	if err := vw.addTree(v.notesDir); err != nil {
		_ = w.Close()
		return fmt.Errorf("watching %q: %w", v.notesDir, err)
	}

	pending, healthy := vw.probe()
	if !healthy {
		// This filesystem never delivered the probe event: run without a
		// watcher rather than pretending events will arrive later.
		_ = w.Close()
		return fmt.Errorf("filesystem %q does not deliver change events (inotify unsupported)", v.notesDir)
	}

	vw.healthy.Store(true) // probe passed: events are flowing
	go vw.loop(pending)

	v.mu.Lock()
	v.watch = vw
	v.mu.Unlock()
	return nil
}

// stop shuts the watcher down and waits for its event loop to exit. It must
// not be called while holding v.mu: the loop takes v.mu (exclusive) per event.
func (vw *vaultWatcher) stop() {
	vw.once.Do(func() {
		close(vw.done)
		_ = vw.w.Close() // closes Events/Errors, unblocking the loop
	})
	<-vw.exited
}

// probe writes a temporary file and waits to see its own event come back,
// proving this filesystem actually delivers events. Events for other paths
// that arrive during the probe are returned so the loop can process them.
func (vw *vaultWatcher) probe() (pending []fsnotify.Event, healthy bool) {
	f, err := os.CreateTemp(vw.v.notesDir, ".basalt-watch-probe-*")
	if err != nil {
		return nil, false
	}
	probePath := f.Name()
	_ = f.Close()
	defer os.Remove(probePath)

	timer := time.NewTimer(watcherProbeTimeout)
	defer timer.Stop()
	for {
		select {
		case ev := <-vw.w.Events:
			if filepath.Clean(ev.Name) == filepath.Clean(probePath) {
				return pending, true
			}
			pending = append(pending, ev)
		case <-vw.w.Errors:
			return pending, false
		case <-timer.C:
			// Events for anything but the probe still prove the channel works.
			return pending, len(pending) > 0
		}
	}
}

// loop drains events queued during the probe and then follows the watcher
// until stop closes it.
func (vw *vaultWatcher) loop(pending []fsnotify.Event) {
	defer close(vw.exited)

	for _, ev := range pending {
		vw.handle(ev)
	}
	for {
		select {
		case <-vw.done:
			return
		case ev, ok := <-vw.w.Events:
			if !ok {
				return
			}
			vw.handle(ev)
		case _, ok := <-vw.w.Errors:
			if !ok {
				return
			}
			// The kernel dropped something (watch queue overflow, race on a
			// removed directory): events can no longer be trusted, so fall
			// back to the plain TTL refresh for the rest of the process life.
			vw.healthy.Store(false)
		}
	}
}

// handle applies one event to the index and the listing snapshot. It takes
// v.mu *exclusively*: ScanNotes hands its walk slices to the snapshot and then
// reads them once more (filter/copy), which is only safe while no event can
// patch the snapshot in between — and, as with every vault mutation, it never
// observes a half-written file from SaveNote.
func (vw *vaultWatcher) handle(ev fsnotify.Event) {
	v := vw.v
	v.mu.Lock()
	defer v.mu.Unlock()

	rel, ok := v.eventRel(ev.Name)
	if !ok {
		return
	}

	if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
		vw.handleGone(ev.Name, rel)
		return
	}
	if ev.Has(fsnotify.Create) {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			// A folder appeared (or a folder rename landed): watch whatever
			// is already inside it and refresh the folder list.
			vw.addTree(ev.Name)
			v.scanCache.invalidate()
			return
		}
	}
	if ev.Has(fsnotify.Write) || ev.Has(fsnotify.Create) {
		vw.handleContent(ev.Name, rel)
		return
	}
	// Chmod-only events carry no content change.
}

// handleGone reacts to a removed or renamed path: files leave the index and
// the snapshot, directories also lose their watches (an inotify watch follows
// the inode, so a moved directory would otherwise keep reporting events under
// its old path).
func (vw *vaultWatcher) handleGone(path, rel string) {
	v := vw.v
	_, wasDir := vw.watched[path]
	vw.removeTree(path)

	if wasDir {
		v.idx.dropPrefix(rel)
		v.scanCache.invalidate()
		return
	}
	v.idx.drop(rel)
	v.scanCache.noteDeleted(rel)
}

// handleContent reacts to a created or written file: markdown notes are
// re-read (stat first, then read — see refreshNote), media only changes the
// listing, and anything the walk ignores is not our concern.
func (vw *vaultWatcher) handleContent(path, rel string) {
	v := vw.v
	if strings.EqualFold(filepath.Ext(rel), ".md") {
		v.refreshNote(rel)
		return
	}
	if GetMediaType(filepath.Base(rel)) == "" {
		return
	}
	v.scanCache.invalidate()
}

// refreshNote re-reads one note after an external change event. The stat is
// taken before the read so the stored (mtime, size) can never be newer than
// the content stored under it: an edit racing the read then only causes a
// redundant re-read later, never stale bytes served as valid. Caller holds
// v.mu (exclusive).
func (v *Vault) refreshNote(rel string) {
	fullPath := v.FullPath(rel)
	if !v.ValidatePathSecurity(fullPath) {
		return
	}
	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		// Deleted between the event and the stat.
		v.idx.drop(rel)
		v.scanCache.noteDeleted(rel)
		return
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return // transient; the next walk retries
	}
	content := strings.ReplaceAll(string(data), "\r\n", "\n")
	tags := v.idx.putNote(rel, info.ModTime(), info.Size(), content)
	v.scanCache.noteSaved(makeNoteRecord(rel, info, tags))
}

// addTree watches root and every directory under it, mirroring the walk's
// rules (dot names and symlinks are skipped, so the watcher never indexes
// what ScanNotes would not list). Only a failure to watch root itself is
// returned: subdirectories are best-effort, with the scan TTL covering any
// directory that could not be added.
func (vw *vaultWatcher) addTree(root string) error {
	base := filepath.Base(filepath.Clean(root))
	if strings.HasPrefix(base, ".") {
		// The walk skips a dot-named root entirely; watching it would only
		// produce events for files that are never listed.
		return nil
	}
	if err := vw.addDir(root); err != nil {
		return err
	}
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == root || !d.IsDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		_ = vw.addDir(path)
		return nil
	})
	return nil
}

func (vw *vaultWatcher) addDir(path string) error {
	if _, ok := vw.watched[path]; ok {
		return nil
	}
	if err := vw.w.Add(path); err != nil {
		return err
	}
	vw.watched[path] = struct{}{}
	return nil
}

// removeTree stops watching path and every recorded directory under it.
func (vw *vaultWatcher) removeTree(path string) {
	prefix := path + string(filepath.Separator)
	for p := range vw.watched {
		if p == path || strings.HasPrefix(p, prefix) {
			_ = vw.w.Remove(p)
			delete(vw.watched, p)
		}
	}
}

// eventRel maps an event path to a vault-relative slash path, rejecting
// anything outside the vault and any path with a dot segment — the same
// files the walk skips — so the watcher never touches what ScanNotes skips.
func (v *Vault) eventRel(name string) (string, bool) {
	rel, err := filepath.Rel(v.notesDir, name)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "." || rel == "" {
		return "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", false
		}
	}
	return rel, true
}

// scanTTL is the freshness budget of the listing snapshot. Immediate events
// patch or invalidate it as they arrive, so the TTL only bounds changes no
// event ever reported. Caller holds v.mu (read).
func (v *Vault) scanTTL() time.Duration {
	if v.watch != nil && v.watch.healthy.Load() {
		return watcherScanTTL
	}
	return scanCacheTTL
}
