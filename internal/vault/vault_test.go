package vault

import (
	"path/filepath"
	"testing"
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
