package search

import "testing"

func TestFoldedMatchSpansWithCountReportsTotalBeyondLimit(t *testing.T) {
	content := "foo bar foo\nfoo"
	spans, total := FoldedMatchSpansWithCount(content, Fold("foo"), 2)
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	if len(spans) != 2 {
		t.Fatalf("len(spans) = %d, want 2", len(spans))
	}
}

func TestExtractSnippetLineAndColumn(t *testing.T) {
	content := "foo bar foo\nfoo"
	line, column, snippet := ExtractSnippet(content, Span{Start: 12, End: 15})
	if line != 2 || column != 1 {
		t.Fatalf("line/column = %d/%d, want 2/1 (snippet %q)", line, column, snippet)
	}
}

func TestFoldedMatchSpansAccentInsensitive(t *testing.T) {
	content := "coração e CORACAO"
	spans, total := FoldedMatchSpansWithCount(content, Fold("coracao"), 0)
	if total != 2 || len(spans) != 2 {
		t.Fatalf("total/spans = %d/%d, want 2/2", total, len(spans))
	}

	line, column, _ := ExtractSnippet(content, spans[1])
	if line != 1 || column != 11 {
		t.Fatalf("line/column = %d/%d, want 1/11", line, column)
	}
}
