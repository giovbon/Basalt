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

	isASCII := true
	for i := 0; i < len(content); i++ {
		if content[i] >= unicode.MaxASCII {
			isASCII = false
			break
		}
	}

	if isASCII {
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

	// For Unicode content, track character origin
	var foldedBuilder strings.Builder
	var origins []int

	// Walk runes of content
	runeOffsets := make([]int, 0, len(content))
	runesList := make([]rune, 0, len(content))
	for offset, r := range content {
		runeOffsets = append(runeOffsets, offset)
		runesList = append(runesList, r)
	}
	runeCount := len(runesList)

	for i, r := range runesList {
		f := Fold(string(r))
		foldedBuilder.WriteString(f)
		for j := 0; j < len(f); j++ {
			origins = append(origins, i)
		}
	}
	folded := foldedBuilder.String()

	var spans []Span
	total := 0
	pos := strings.Index(folded, foldedQuery)
	for pos != -1 {
		total++
		endPos := pos + len(foldedQuery)

		if limit <= 0 || len(spans) < limit {
			startRuneIdx := origins[pos]
			endRuneIdx := origins[endPos-1] + 1

			// Keep combining accents with preceding letter
			for endRuneIdx < runeCount && unicode.Is(unicode.Mn, runesList[endRuneIdx]) {
				endRuneIdx++
			}

			startByte := runeOffsets[startRuneIdx]
			var endByte int
			if endRuneIdx < runeCount {
				endByte = runeOffsets[endRuneIdx]
			} else {
				endByte = len(content)
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
