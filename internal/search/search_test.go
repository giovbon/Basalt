package search

import (
	"strings"
	"testing"
)

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

// TestFoldContentMatchesSpanExtraction pins the invariant search relies on:
// the cached FoldContent text gates which notes get their spans extracted, so
// it must agree with FoldedMatchSpansWithCount in both directions — a miss
// here would silently drop results, a hit would waste extraction work.
func TestFoldContentMatchesSpanExtraction(t *testing.T) {
	cases := []struct{ content, query string }{
		{"coração e CORACAO", "coracao"},
		{"CAFÉ com açúcar", "cafe"},
		{"plain ASCII text", "ascii"},
		{"texto acentuado: ção", "cao"},
		{"açaí, pão, êxtase", "acai"},
		{"sem acento nenhhum", "nenhum"},
		{"decomposed a\u0301 pair", "apair"},
		{"İstanbul", "istanbul"},
		{"ΣΤΙΓΜΑ στιγμα", "stigma"},
		{"mixed ÇASE and caSes", "cases"},
	}
	for _, tc := range cases {
		foldedQuery := Fold(tc.query)
		foldedContent := FoldContent(tc.content)
		_, total := FoldedMatchSpansWithCount(tc.content, foldedQuery, 0)

		if strings.Contains(foldedContent, foldedQuery) && total == 0 {
			t.Errorf("FoldContent(%q) contains Fold(%q) but extractor found no match", tc.content, tc.query)
		}
		if !strings.Contains(foldedContent, foldedQuery) && total > 0 {
			t.Errorf("FoldContent(%q) misses Fold(%q) but extractor found %d matches", tc.content, tc.query, total)
		}
	}
}

// referenceFold folds rune by rune, the way foldNonASCII worked before it
// learned to batch ASCII runs. Batching must not change a single byte of the
// output, so this pins FoldContent against the naive implementation.
func referenceFold(content string) string {
	var b strings.Builder
	for _, r := range content {
		b.WriteString(Fold(string(r)))
	}
	return b.String()
}

func TestFoldContentMatchesPerRuneReference(t *testing.T) {
	cases := []string{
		"",
		"plain ASCII text 123",
		"CAFÉ com açúcar",
		"história, música e não",
		"decomposed a\u0301 pair",
		"İstanbul ﬁ ligature Straße",
		"στιγμα ΣΤΙΓΜΑ",
		"tabs\tand\nnewlines\r\nmixed",
		"mix ÇASE caSes around âccents",
		"standalone combining \u0301 mark",
		"edge: àéîõü at end",
	}
	for _, content := range cases {
		got, want := FoldContent(content), referenceFold(content)
		if got != want {
			t.Errorf("FoldContent(%q) = %q, want per-rune reference %q", content, got, want)
		}
	}
}

// TestSpansBoundariesPinByteOffsets checks the span mapping rewrite: spans
// must start at the origin rune's byte offset, step over the last matched
// rune, and swallow combining marks that belong to it — no further.
func TestSpansBoundariesPinByteOffsets(t *testing.T) {
	tests := []struct {
		name    string
		content string
		query   string
		want    Span // Start < 0 means "no match expected"
	}{
		{"precomposed accent at end of match", "café!!", "cafe", Span{0, 5}},
		{"trailing combining mark stays in span", "cafe\u0301!!", "cafe", Span{0, 6}},
		{"match starts after accent", "olá café", "cafe", Span{5, 10}},
		{"ligature does not decompose (no NFKD)", "ﬁne", "in", Span{-1, -1}},
		{"standalone mark folds to nothing", "x\u0301y", "xy", Span{0, 4}},
		{"ascii content uses direct offsets", "foo bar foo", "foo", Span{0, 3}},
	}
	for _, tt := range tests {
		spans := FoldedMatchSpans(tt.content, Fold(tt.query), 1)
		if tt.want.Start < 0 {
			if len(spans) != 0 {
				t.Errorf("%s: spans = %#v, want no match", tt.name, spans)
			}
			continue
		}
		if len(spans) != 1 || spans[0] != tt.want {
			t.Errorf("%s: spans = %#v, want [%d,%d]", tt.name, spans, tt.want.Start, tt.want.End)
		}
	}
}
