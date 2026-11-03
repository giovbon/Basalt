package vault

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitFor polls cond until it holds, failing the test after a generous
// deadline. Watcher events normally land within milliseconds; the slack only
// absorbs CI scheduling.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// startWatcherVault creates a vault on dir with the watcher running, skipping
// the test when the filesystem cannot deliver change events (drvfs under WSL,
// some Docker Desktop binds). Both scan TTLs are pushed to one hour so every
// observation below can only come from an event, never from a background walk.
func startWatcherVault(t *testing.T, dir string) *Vault {
	t.Helper()

	oldScan, oldWatch := scanCacheTTL, watcherScanTTL
	scanCacheTTL, watcherScanTTL = time.Hour, time.Hour
	t.Cleanup(func() { scanCacheTTL, watcherScanTTL = oldScan, oldWatch })

	v := New(dir)
	if err := v.EnsureDirectories(); err != nil {
		t.Fatal(err)
	}
	if err := v.StartWatching(); err != nil {
		t.Skipf("filesystem does not deliver change events: %v", err)
	}
	t.Cleanup(v.Close)

	if v.watch == nil || !v.watch.healthy.Load() {
		t.Fatal("StartWatching succeeded but no healthy watcher is attached")
	}
	if got := v.scanTTL(); got != watcherScanTTL {
		t.Errorf("scanTTL() = %v, want watcherScanTTL %v with a healthy watcher", got, watcherScanTTL)
	}
	return v
}

// scanPaths returns the note paths a fresh listing reports.
func scanPaths(t *testing.T, v *Vault, includeMedia bool) map[string]struct{} {
	t.Helper()
	notes, _, err := v.ScanNotes(includeMedia)
	if err != nil {
		t.Fatal(err)
	}
	return notePaths(notes)
}

// TestWatcherSeesExternalChanges covers the whole event lifecycle against a
// filesystem that delivers events: create, edit, same-mtime/same-size rewrite,
// new subfolder, media and delete — none of which can reach the caches through
// a walk, because the scan TTL is an hour for the whole test.
func TestWatcherSeesExternalChanges(t *testing.T) {
	dir := t.TempDir()
	v := startWatcherVault(t, dir)

	// Create: the note must appear in the listing without any walk.
	if err := os.WriteFile(filepath.Join(dir, "alpha.md"), []byte("alpha one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "external create to reach the listing", func() bool {
		return hasPath(scanPaths(t, v, false), "alpha.md")
	})

	// Edit that changes size: the index entry must be re-read, so the tags of
	// the new content show up in the listing.
	if err := os.WriteFile(filepath.Join(dir, "alpha.md"),
		[]byte("---\ntags: [watched]\n---\nalpha two\n"), 0644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "external edit to refresh tags", func() bool {
		notes, _, err := v.ScanNotes(false)
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range notes {
			if n.Path == "alpha.md" {
				for _, tag := range n.Tags {
					if tag == "watched" {
						return true
					}
				}
			}
		}
		return false
	})

	// Rewrite preserving both mtime and size — the window stat validation
	// alone can never close. Only the event forces the re-read: without it the
	// cache key still matches the file on disk, so the old bytes keep being
	// served for another scan TTL.
	const (
		edited    = "---\ntags: [watched]\n---\nalpha two\n"
		rewritten = "---\ntags: [watched]\n---\nbeta four\n"
	)
	if len(edited) != len(rewritten) {
		t.Fatalf("test bug: %d-byte edit vs %d-byte rewrite, sizes must match", len(edited), len(rewritten))
	}
	before, err := os.Stat(filepath.Join(dir, "alpha.md"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "alpha.md"), []byte(rewritten), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(dir, "alpha.md"), before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "same-mtime/same-size rewrite to be re-read", func() bool {
		got, err := v.GetNoteContent("alpha.md")
		return err == nil && got == rewritten
	})

	// New subfolder with a note inside: the folder must be watched and listed.
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "nested.md"), []byte("nested\n"), 0644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "new subfolder note to reach the listing", func() bool {
		return hasPath(scanPaths(t, v, false), "sub/nested.md")
	})

	// Media: the snapshot must refresh for includeMedia callers too.
	if err := os.WriteFile(filepath.Join(dir, "pic.png"), []byte("png-bytes"), 0644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "external media file to reach the listing", func() bool {
		return hasPath(scanPaths(t, v, true), "pic.png")
	})

	// Delete: both the listing and the index entry must drop the note, and the
	// content must stop being served from cache.
	if err := os.Remove(filepath.Join(dir, "alpha.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "external delete to leave the listing", func() bool {
		return !hasPath(scanPaths(t, v, false), "alpha.md")
	})
	if _, err := v.GetNoteContent("alpha.md"); err == nil {
		t.Error("GetNoteContent still serves a deleted note")
	}
	v.idx.mu.RLock()
	_, stillIndexed := v.idx.entries["alpha.md"]
	v.idx.mu.RUnlock()
	if stillIndexed {
		t.Error("index still holds an entry for the deleted note")
	}
}

// TestScanTTLFallsBackWithoutWatcher pins the degraded mode: no watcher at
// all, the plain scanCacheTTL applies — the behaviour the app had before
// watchers existed.
func TestScanTTLFallsBackWithoutWatcher(t *testing.T) {
	v := New(t.TempDir())
	if got := v.scanTTL(); got != scanCacheTTL {
		t.Errorf("scanTTL() = %v, want scanCacheTTL %v without a watcher", got, scanCacheTTL)
	}
}
