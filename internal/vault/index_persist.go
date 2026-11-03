package vault

import (
	"bytes"
	"encoding/gob"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// indexPersistInterval is how often the background saver checks whether the
// index changed since the last write. Tests lower it to observe a save
// without waiting.
var indexPersistInterval = 10 * time.Second

// indexFileVersion guards the on-disk layout: a file written with a different
// version is discarded and rebuilt from the .md files.
const indexFileVersion = 1

// persistedEntry is the durable projection of indexEntry. Content and folded
// text are deliberately absent: they are large, cheaply derivable from the
// .md files and would only go stale — this file is a cache, never a source of
// truth. (mtime, size) stays the validity key, exactly as in memory, so a
// restored entry is re-read the moment the file on disk differs.
type persistedEntry struct {
	Rel       string
	MTime     time.Time
	Size      int64
	Name      string
	Folder    string
	Typ       string
	Tags      []string
	IsNote    bool
	HasLinks  bool
	WikiLinks []LinkOcc
	MdLinks   []LinkOcc
}

// indexFile is the whole gob document.
type indexFile struct {
	FileVersion int
	Vault       string // absolute notesDir the index belongs to
	SavedAt     time.Time
	Entries     []persistedEntry
}

// indexPersistence is the background saver started by StartIndexPersistence.
type indexPersistence struct {
	path string
	mu   sync.Mutex // serialises writes to path (ticker vs SaveIndexNow)
	stop chan struct{}
	done chan struct{}
	once sync.Once
}

// StartIndexPersistence loads a previously saved index and starts saving it
// back periodically while it is dirty. Loading is best effort and the
// returned error only reports a problem with the file (a missing file is not
// an error): persistence starts either way, because the index is a cache and
// simply rebuilds from the .md files — corrupt and foreign-vault files are
// ignored until the next save overwrites them.
func (v *Vault) StartIndexPersistence(path string) error {
	loadErr := v.loadIndex(path)

	p := &indexPersistence{
		path: path,
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
	v.mu.Lock()
	v.persist = p
	v.mu.Unlock()
	go p.loop(v)
	return loadErr
}

// SaveIndexNow flushes the index to disk immediately instead of waiting for
// the next background tick. It is a no-op when nothing changed since the last
// write.
func (v *Vault) SaveIndexNow() error {
	v.mu.RLock()
	p := v.persist
	v.mu.RUnlock()
	if p == nil {
		return fmt.Errorf("index persistence is not started")
	}
	return p.flush(v)
}

// loadIndex restores the index from path, validating version and vault.
func (v *Vault) loadIndex(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("reading index cache: %w", err)
	}
	var f indexFile
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&f); err != nil {
		return fmt.Errorf("decoding index cache: %w", err)
	}
	if f.FileVersion != indexFileVersion {
		return fmt.Errorf("index cache version %d, want %d", f.FileVersion, indexFileVersion)
	}
	abs, err := filepath.Abs(v.notesDir)
	if err != nil || f.Vault != abs {
		return fmt.Errorf("index cache belongs to another vault (%q)", f.Vault)
	}
	v.idx.restore(f.Entries)
	return nil
}

// flush writes the index when it is dirty. The dirty flag is swapped before
// the snapshot so a mutation landing mid-save keeps the flag set for the next
// round instead of being cleared by a successful write.
func (p *indexPersistence) flush(v *Vault) error {
	if !v.idx.dirty.Swap(false) {
		return nil
	}
	if err := p.save(v); err != nil {
		v.idx.dirty.Store(true) // retry on the next tick or Close
		return err
	}
	return nil
}

// save encodes the index and replaces path atomically (temp file + rename),
// so a crash mid-write leaves the previous complete file in place.
func (p *indexPersistence) save(v *Vault) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	f := indexFile{
		FileVersion: indexFileVersion,
		SavedAt:     time.Now(),
		Entries:     v.idx.snapshot(),
	}
	if abs, err := filepath.Abs(v.notesDir); err == nil {
		f.Vault = abs
	}

	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(f); err != nil {
		return fmt.Errorf("encoding index cache: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(p.path), ".basalt-index-*.tmp")
	if err != nil {
		return fmt.Errorf("writing index cache: %w", err)
	}
	tmpName := tmp.Name()
	_, writeErr := tmp.Write(buf.Bytes())
	closeErr := tmp.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("writing index cache: %w", writeErr)
	}
	if err := os.Rename(tmpName, p.path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("replacing index cache: %w", err)
	}
	return nil
}

// loop saves the index on every tick that found it dirty.
func (p *indexPersistence) loop(v *Vault) {
	defer close(p.done)
	ticker := time.NewTicker(indexPersistInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-ticker.C:
			_ = p.flush(v) // errors keep the flag set; the next tick retries
		}
	}
}

// halt stops the loop and waits for it to exit, so no save can be running
// when the caller performs the final flush.
func (p *indexPersistence) halt() {
	p.once.Do(func() { close(p.stop) })
	<-p.done
}
