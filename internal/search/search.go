package search

import (
	"html"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var nfdTransformer = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)))

// Fold lowers the text and removes combining accents (NFD decomposition).
func Fold(text string) string {
	lowered := strings.ToLower(text)
	result, _, err := transform.String(nfdTransformer, lowered)
	if err != nil {
		return lowered
	}
	return result
}

// Span represents a match start and end index in the original string.
type Span struct {
	Start int
	End   int
}

// isASCIIContent reports whether every byte of s is a 7-bit ASCII byte. It is
// the same predicate FoldedMatchSpansWithCount uses to pick its fast path, so
// FoldContent and the span extractor always fold text the same way.
func isASCIIContent(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= unicode.MaxASCII {
			return false
		}
	}
	return true
}

// foldNonASCII folds content (lowercase + strip combining marks), handling
// maximal ASCII runs in bulk: NFD decomposition and mark stripping are no-ops
// on ASCII and strings.ToLower folds ASCII byte-wise, so folding a run at once
// is byte-identical to folding each of its runes — only the accented runes pay
// the full per-rune Fold pipeline.
//
// When origins is non-nil it receives one entry per byte of the folded output
// holding the content byte offset of the rune that byte came from — the
// mapping FoldedMatchSpansWithCount needs to report spans in the original
// content.
//
// FoldContent passes nil and FoldedMatchSpansWithCount passes a slice, so both
// callers are guaranteed to search in byte-identical folded text.
func foldNonASCII(content string, origins *[]int) string {
	var foldedBuilder strings.Builder
	foldedBuilder.Grow(len(content))
	i := 0
	for i < len(content) {
		if content[i] < utf8.RuneSelf {
			// ASCII run: fold it in one ToLower call. Each ASCII byte is one
			// rune and ToLower preserves the length, so origins stays aligned.
			j := i + 1
			for j < len(content) && content[j] < utf8.RuneSelf {
				j++
			}
			run := strings.ToLower(content[i:j])
			foldedBuilder.WriteString(run)
			if origins != nil {
				for k := 0; k < len(run); k++ {
					*origins = append(*origins, i+k)
				}
			}
			i = j
			continue
		}
		r, size := utf8.DecodeRuneInString(content[i:])
		f := Fold(string(r))
		foldedBuilder.WriteString(f)
		if origins != nil {
			for k := 0; k < len(f); k++ {
				*origins = append(*origins, i)
			}
		}
		i += size
	}
	return foldedBuilder.String()
}

// FoldContent returns the accent-folded, lowercased form of content: the exact
// text FoldedMatchSpansWithCount matches the folded query against. Callers
// cache it so a search only folds each note once instead of once per query.
func FoldContent(content string) string {
	if content == "" {
		return ""
	}
	if !isASCIIContent(content) {
		return foldNonASCII(content, nil)
	}
	return strings.ToLower(content)
}

// FoldedMatchSpans finds foldedQuery in content and returns up to limit (start, end)
// byte spans in the original content. A non-positive limit means "no limit".
func FoldedMatchSpans(content string, foldedQuery string, limit int) []Span {
	spans, _ := FoldedMatchSpansWithCount(content, foldedQuery, limit)
	return spans
}

// FoldedMatchSpansWithCount is FoldedMatchSpans plus the total number of
// occurrences in content. The total can be larger than len(spans) when limit
// is positive, which lets callers show "showing N of M" without collecting
// every snippet. If content is ASCII, it avoids per-character mapping.
func FoldedMatchSpansWithCount(content string, foldedQuery string, limit int) ([]Span, int) {
	if foldedQuery == "" || len(content) == 0 {
		return nil, 0
	}

	if isASCIIContent(content) {
		folded := strings.ToLower(content)
		var spans []Span
		total := 0
		pos := strings.Index(folded, foldedQuery)
		for pos != -1 {
			total++
			end := pos + len(foldedQuery)
			if limit <= 0 || len(spans) < limit {
				spans = append(spans, Span{Start: pos, End: end})
			}
			pos = strings.Index(folded[end:], foldedQuery)
			if pos != -1 {
				pos += end
			}
		}
		return spans, total
	}

	// Fold with origins: folded byte -> content byte offset of its origin
	// rune. That mapping alone is enough to report spans, so no per-note rune
	// table has to be built (it used to cost two slices the size of content).
	var origins []int
	folded := foldNonASCII(content, &origins)

	var spans []Span
	total := 0
	pos := strings.Index(folded, foldedQuery)
	for pos != -1 {
		total++
		endPos := pos + len(foldedQuery)

		if limit <= 0 || len(spans) < limit {
			startByte := origins[pos]
			// Step over the last matched rune, then keep any combining
			// accents attached to it in the span.
			_, size := utf8.DecodeRuneInString(content[origins[endPos-1]:])
			endByte := origins[endPos-1] + size
			for endByte < len(content) {
				r, sz := utf8.DecodeRuneInString(content[endByte:])
				if !unicode.Is(unicode.Mn, r) {
					break
				}
				endByte += sz
			}

			spans = append(spans, Span{Start: startByte, End: endByte})
		}

		pos = strings.Index(folded[endPos:], foldedQuery)
		if pos != -1 {
			pos += endPos
		}
	}

	return spans, total
}

// EscapeHTML escapes special characters with Python html.escape parity (including &#x27;)
func EscapeHTML(s string) string {
	escaped := html.EscapeString(s)
	// Go html.EscapeString converts ' to &#39;, Python html.escape uses &#x27;
	return strings.ReplaceAll(escaped, "&#39;", "&#x27;")
}

type SearchMatch struct {
	LineNumber int    `json:"line_number"`
	Column     int    `json:"column"`
	Context    string `json:"context"`
}

type SearchResult struct {
	Name         string        `json:"name"`
	Path         string        `json:"path"`
	Folder       string        `json:"folder"`
	Matches      []SearchMatch `json:"matches"`
	TotalMatches int           `json:"total_matches"`
}

// ExtractSnippet builds the HTML snippet with <mark class="search-highlight">.
// It also returns the 1-based line and column (in runes) of the match start.
func ExtractSnippet(content string, span Span) (lineNum int, column int, snippet string) {
	start := span.Start
	end := span.End

	contextStart := start - 15
	if contextStart < 0 {
		contextStart = 0
	}
	// Do not slice through the middle of a multi-byte rune.
	for contextStart > 0 && !utf8.RuneStart(content[contextStart]) {
		contextStart--
	}
	contextEnd := end + 15
	if contextEnd > len(content) {
		contextEnd = len(content)
	}
	for contextEnd < len(content) && !utf8.RuneStart(content[contextEnd]) {
		contextEnd++
	}

	before := EscapeHTML(strings.ReplaceAll(content[contextStart:start], "\n", " "))
	after := EscapeHTML(strings.ReplaceAll(content[end:contextEnd], "\n", " "))
	matchedClean := EscapeHTML(strings.ReplaceAll(content[start:end], "\n", " "))

	snippet = before + `<mark class="search-highlight">` + matchedClean + `</mark>` + after
	if contextStart > 0 {
		snippet = "..." + snippet
	}
	if contextEnd < len(content) {
		snippet = snippet + "..."
	}

	lineStart := strings.LastIndex(content[:start], "\n") + 1
	lineNum = strings.Count(content[:start], "\n") + 1
	column = utf8.RuneCountInString(content[lineStart:start]) + 1
	return lineNum, column, snippet
}
