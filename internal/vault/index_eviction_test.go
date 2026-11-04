package vault

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestContentEvictionKeepsBudgetAndMetadata pins the eviction contract: the
// content pool never exceeds its budget, entries that lose their payload keep
// their metadata (they are still listed and searchable), and the oldest
// payloads are the ones dropped.
func TestContentEvictionKeepsBudgetAndMetadata(t *testing.T) {
	oldBudget, oldMax := contentCacheBudget, contentCacheMaxBytes
	t.Cleanup(func() { contentCacheBudget, contentCacheMaxBytes = oldBudget, oldMax })

	content := strings.Repeat("x", 1024)
	contentCacheMaxBytes = int64(len(content))
	contentCacheBudget = int64(5 * len(content))

	ix := newIndex()
	now := time.Now()
	const total = 10
	for i := 0; i < total; i++ {
		ix.putNote(fmt.Sprintf("n-%02d.md", i), now, int64(len(content)), content)
	}

	if ix.contentBytes > contentCacheBudget {
		t.Fatalf("contentBytes = %d, budget = %d", ix.contentBytes, contentCacheBudget)
	}
	if got := len(ix.entries); got != total {
		t.Fatalf("entries = %d, want %d (eviction must not drop metadata)", got, total)
	}
	for i := 0; i < total; i++ {
		e := ix.entries[fmt.Sprintf("n-%02d.md", i)]
		if e == nil {
			t.Fatalf("entry n-%02d.md missing", i)
		}
		// The last five insertions fit in the budget, so they keep their bytes.
		wantContent := i >= 5
		if e.hasContent != wantContent {
			t.Errorf("n-%02d.md hasContent = %v, want %v", i, e.hasContent, wantContent)
		}
	}
}

// TestFoldEvictionKeepsBudget covers the second pool (folded text), which is
// budgeted separately from content.
func TestFoldEvictionKeepsBudget(t *testing.T) {
	oldBudget, oldMax := foldCacheBudget, foldCacheMaxBytes
	t.Cleanup(func() { foldCacheBudget, foldCacheMaxBytes = oldBudget, oldMax })

	folded := strings.Repeat("a", 1024)
	foldCacheMaxBytes = int64(len(folded))
	foldCacheBudget = int64(3 * len(folded))

	ix := newIndex()
	now := time.Now()
	for i := 0; i < 8; i++ {
		rel := fmt.Sprintf("n-%02d.md", i)
		ix.putNote(rel, now, 1, "content")
		ix.putFold(rel, now, 1, folded)
	}

	if ix.foldedBytes > foldCacheBudget {
		t.Fatalf("foldedBytes = %d, budget = %d", ix.foldedBytes, foldCacheBudget)
	}
	if ix.foldedBytes == 0 {
		t.Fatal("folded pool is empty, expected the last insertions to be cached")
	}
	for i := 0; i < 8; i++ {
		if ix.entries[fmt.Sprintf("n-%02d.md", i)] == nil {
			t.Fatalf("entry %d dropped with its payload", i)
		}
	}
}
