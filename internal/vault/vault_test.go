package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"notediscovery/internal/search"
)

func TestGetBacklinksIncludesHeadingAnchoredWikilinks(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)

	if err := v.SaveNote("nota tal.md", "# Cap 1\n\nBody.\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("source.md", "See [[nota tal#Cap 1]] and [[nota tal#Other|alias]].\n"); err != nil {
		t.Fatal(err)
	}

	backlinks := v.GetBacklinks("nota tal.md")
	if len(backlinks) != 1 {
		t.Fatalf("backlinks = %#v, want one item", backlinks)
	}
	if backlinks[0].Path != "source.md" {
		t.Fatalf("backlink path = %q, want source.md", backlinks[0].Path)
	}
	if len(backlinks[0].References) != 2 {
		t.Fatalf("references = %#v, want two anchored links", backlinks[0].References)
	}
}

func TestResolveWikilinkIgnoresHeadingAnchor(t *testing.T) {
	r := NewLinkResolver([]string{"target.md", "folder/note.md"})

	if got := r.ResolveWikilink("target#Cap 1", ""); got != "target.md" {
		t.Fatalf("ResolveWikilink(target#Cap 1) = %q, want target.md", got)
	}
	if got := r.ResolveWikilink("note#Intro", "folder"); got != "folder/note.md" {
		t.Fatalf("ResolveWikilink(note#Intro) = %q, want folder/note.md", got)
	}
	if got := r.ResolveWikilink("#Cap 1", ""); got != "" {
		t.Fatalf("ResolveWikilink(#Cap 1) = %q, want empty", got)
	}
}

func TestGetAttachmentDirDoesNotNestAttachments(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "vault")
	v := New(root)

	tests := []struct {
		notePath string
		want     string
	}{
		{"", filepath.Join(root, "_attachments")},
		{"note.md", filepath.Join(root, "_attachments")},
		{"Projects/note.md", filepath.Join(root, "Projects", "_attachments")},
		{"_attachments/note.md", filepath.Join(root, "_attachments")},
		{"Projects/_attachments/note.md", filepath.Join(root, "Projects", "_attachments")},
		{"Projects/_attachments/sub/note.md", filepath.Join(root, "Projects", "_attachments", "sub")},
	}

	for _, tt := range tests {
		if got := v.GetAttachmentDir(tt.notePath); got != tt.want {
			t.Errorf("GetAttachmentDir(%q) = %q, want %q", tt.notePath, got, tt.want)
		}
	}
}

// TestGetFoldedContentCachesAndFollowsEdits covers the search fast path: the
// fold is accent/case-free, served from the index, and tracks edits made
// outside the app once the file's (mtime, size) change.
func TestGetFoldedContentCachesAndFollowsEdits(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("nota.md", "O coração\n"); err != nil {
		t.Fatal(err)
	}

	folded, err := v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(folded, "coracao") {
		t.Errorf("folded = %q, want accent-free lowercase text", folded)
	}

	again, err := v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if again != folded {
		t.Errorf("second fold = %q, want cached %q", again, folded)
	}

	// External rewrite (different size): the fold must follow the new bytes.
	edited := "A CORACAO maior\n"
	if err := os.WriteFile(filepath.Join(dir, "nota.md"), []byte(edited), 0644); err != nil {
		t.Fatal(err)
	}
	folded, err = v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := search.FoldContent(edited); folded != want {
		t.Errorf("fold after edit = %q, want %q", folded, want)
	}
}

// TestGetBacklinksMarkdownRelativeAndTruncation exercises the indexed-link
// path: markdown links resolve relative to the reading note, references keep
// line order (wikilink before markdown on the same line) and are capped at3.
func TestGetBacklinksMarkdownRelativeAndTruncation(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("folder/target.md", "# T\n"); err != nil {
		t.Fatal(err)
	}
	source := "line1 [[target]]\n" +
		"line2 [t](target.md) and [[target#Head]]\n" +
		"line3 [[target]]\n"
	if err := v.SaveNote("folder/source.md", source); err != nil {
		t.Fatal(err)
	}

	backlinks := v.GetBacklinks("folder/target.md")
	if len(backlinks) != 1 {
		t.Fatalf("backlinks = %#v, want one item", backlinks)
	}
	refs := backlinks[0].References
	if len(refs) != 3 {
		t.Fatalf("references = %#v, want exactly 3 (capped)", refs)
	}
	want := []struct {
		line int
		typ  string
	}{{1, "wikilink"}, {2, "wikilink"}, {2, "markdown"}}
	for i, w := range want {
		if refs[i].LineNumber != w.line || refs[i].Type != w.typ {
			t.Errorf("refs[%d] = line %d/%s, want line %d/%s", i, refs[i].LineNumber, refs[i].Type, w.line, w.typ)
		}
	}
	if refs[0].Context != "line1 [[target]]" {
		t.Errorf("context = %q, want %q", refs[0].Context, "line1 [[target]]")
	}
}

// TestGetBacklinksSeesExternalLinkEdits makes sure link occurrences are
// refreshed when the file changes on disk: a scan re-reads the note and
// re-extracts its links, so backlinks never serve a stale graph for long.
func TestGetBacklinksSeesExternalLinkEdits(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = 0
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("target.md", "# T\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("source.md", "no links here\n"); err != nil {
		t.Fatal(err)
	}
	if got := v.GetBacklinks("target.md"); len(got) != 0 {
		t.Fatalf("backlinks before edit = %#v, want none", got)
	}

	if err := os.WriteFile(filepath.Join(dir, "source.md"), []byte("now [[target]]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	got := v.GetBacklinks("target.md")
	if len(got) != 1 || got[0].Path != "source.md" {
		t.Fatalf("backlinks after edit = %#v, want source.md linking back", got)
	}
	if len(got[0].References) != 1 || got[0].References[0].LineNumber != 1 {
		t.Errorf("references = %#v, want one wikilink on line 1", got[0].References)
	}
}

// TestGetGraphDataFromIndexedLinks checks the graph is built from the links
// recorded at index time, both wikilinks and markdown links.
func TestGetGraphDataFromIndexedLinks(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	for path, content := range map[string]string{
		"target.md": "# T\n",
		"other.md":  "# O\n",
		"source.md": "see [[target]] and [go](other.md)\n",
	} {
		if err := v.SaveNote(path, content); err != nil {
			t.Fatal(err)
		}
	}

	data, err := v.GetGraphData(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Nodes) != 3 {
		t.Errorf("nodes = %d, want 3 (%v)", len(data.Nodes), data.Nodes)
	}
	edges := make(map[string]string, len(data.Edges))
	for _, e := range data.Edges {
		edges[e.Source+" -> "+e.Target] = e.Type
	}
	if edges["source.md -> target.md"] != "wikilink" {
		t.Errorf("wikilink edge = %q, want wikilink (%v)", edges["source.md -> target.md"], edges)
	}
	if edges["source.md -> other.md"] != "markdown" {
		t.Errorf("markdown edge = %q, want markdown (%v)", edges["source.md -> other.md"], edges)
	}
}

// TestCacheBudgetsEvictLRUInsteadOfDisabling pins the behaviour that replaced
// the old cliff: when a pool fills up the least recently used payload is
// evicted and every note stays readable (content falls back to disk), instead
// of the whole cache being switched off.
func TestCacheBudgetsEvictLRUInsteadOfDisabling(t *testing.T) {
	oldContent, oldFold := contentCacheBudget, foldCacheBudget
	contentCacheBudget = 140
	foldCacheBudget = 140
	defer func() {
		contentCacheBudget = oldContent
		foldCacheBudget = oldFold
	}()

	dir := t.TempDir()
	v := New(dir)
	payload := strings.Repeat("x", 50)
	for _, path := range []string{"a.md", "b.md", "c.md"} {
		if err := v.SaveNote(path, payload); err != nil {
			t.Fatal(err)
		}
	}

	if v.idx.contentBytes > contentCacheBudget {
		t.Errorf("contentBytes = %d, over budget %d", v.idx.contentBytes, contentCacheBudget)
	}
	if v.idx.entries["a.md"].hasContent {
		t.Error("a.md should have been evicted (least recently used)")
	}
	if !v.idx.entries["c.md"].hasContent {
		t.Error("c.md should still be cached")
	}

	// Reading the evicted note serves it from disk and evicts the new LRU (b).
	got, err := v.GetNoteContent("a.md")
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Errorf("GetNoteContent = %q, want %q", got, payload)
	}
	if !v.idx.entries["a.md"].hasContent {
		t.Error("a.md should be cached again after being read")
	}
	if v.idx.entries["b.md"].hasContent {
		t.Error("b.md should have been evicted after a.md was read")
	}

	// The fold pool follows the same rules and every note stays foldable.
	for _, path := range []string{"a.md", "b.md", "c.md"} {
		if _, err := v.GetFoldedContent(path); err != nil {
			t.Fatalf("GetFoldedContent(%s): %v", path, err)
		}
	}
	if v.idx.foldedBytes > foldCacheBudget {
		t.Errorf("foldedBytes = %d, over budget %d", v.idx.foldedBytes, foldCacheBudget)
	}
	if v.idx.contentBytes > contentCacheBudget {
		t.Errorf("contentBytes = %d, over budget %d after folding", v.idx.contentBytes, contentCacheBudget)
	}
}
