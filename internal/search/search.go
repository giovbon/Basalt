package search

import (
	"html"
	"strings"
	"unicode"

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
// byte spans in the original content. If content is ASCII, it avoids per-character mapping.
func FoldedMatchSpans(content string, foldedQuery string, limit int) []Span {
	if foldedQuery == "" || len(content) == 0 {
		return nil
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
		pos := strings.Index(folded, foldedQuery)
		for pos != -1 && len(spans) < limit {
			end := pos + len(foldedQuery)
			spans = append(spans, Span{Start: pos, End: end})
			pos = strings.Index(folded[end:], foldedQuery)
			if pos != -1 {
				pos += end
			}
		}
		return spans
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
	pos := strings.Index(folded, foldedQuery)
	for pos != -1 && len(spans) < limit {
		endPos := pos + len(foldedQuery)
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

		pos = strings.Index(folded[endPos:], foldedQuery)
		if pos != -1 {
			pos += endPos
		}
	}

	return spans
}

// EscapeHTML escapes special characters with Python html.escape parity (including &#x27;)
func EscapeHTML(s string) string {
	escaped := html.EscapeString(s)
	// Go html.EscapeString converts ' to &#39;, Python html.escape uses &#x27;
	return strings.ReplaceAll(escaped, "&#39;", "&#x27;")
}

type SearchMatch struct {
	LineNumber int    `json:"line_number"`
	Context    string `json:"context"`
}

type SearchResult struct {
	Name    string        `json:"name"`
	Path    string        `json:"path"`
	Folder  string        `json:"folder"`
	Matches []SearchMatch `json:"matches"`
}

// ExtractSnippet builds the HTML snippet with <mark class="search-highlight">
func ExtractSnippet(content string, span Span) (int, string) {
	start := span.Start
	end := span.End

	contextStart := start - 15
	if contextStart < 0 {
		contextStart = 0
	}
	contextEnd := end + 15
	if contextEnd > len(content) {
		contextEnd = len(content)
	}

	before := EscapeHTML(strings.ReplaceAll(content[contextStart:start], "\n", " "))
	after := EscapeHTML(strings.ReplaceAll(content[end:contextEnd], "\n", " "))
	matchedClean := EscapeHTML(strings.ReplaceAll(content[start:end], "\n", " "))

	snippet := before + `<mark class="search-highlight">` + matchedClean + `</mark>` + after
	if contextStart > 0 {
		snippet = "..." + snippet
	}
	if contextEnd < len(content) {
		snippet = snippet + "..."
	}

	lineNum := strings.Count(content[:start], "\n") + 1
	return lineNum, snippet
}
