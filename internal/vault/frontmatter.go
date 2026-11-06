package vault

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// OutlineItem is one heading of a markdown note, as shown in the TOC panel.
type OutlineItem struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Slug  string `json:"slug"`
	Line  int    `json:"line"`
}

// FrontmatterField is one key/value pair of a note's frontmatter.
type FrontmatterField struct {
	Key   string
	Value any
}

// Frontmatter is a note's leading YAML block as an ordered list of pairs.
// It serializes to a JSON object that preserves the declaration order of the
// note, so the metadata panel does not reshuffle its fields between saves
// (a plain map[string]any would marshal in random order).
type Frontmatter []FrontmatterField

// MarshalJSON emits an object with the pairs in slice order. A nil slice
// means "no frontmatter" and must stay JSON null, which the frontend reads
// as the absence of metadata.
func (fm Frontmatter) MarshalJSON() ([]byte, error) {
	if fm == nil {
		return []byte("null"), nil
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, f := range fm {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(f.Key)
		if err != nil {
			return nil, err
		}
		val, err := json.Marshal(f.Value)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(val)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// Len reports the number of fields (frontend parity helper for emptiness
// checks done server-side).
func (fm Frontmatter) Len() int { return len(fm) }

var headingRE = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)

// frontmatterBounds locates the leading YAML block in lines (already split on
// "\n"). Blank lines before the opening delimiter and a UTF-8 BOM are
// tolerated, matching the other frontmatter readers. openIdx/closeIdx are the
// indices of the opening and closing "---" lines.
func frontmatterBounds(lines []string) (openIdx, closeIdx int, found bool) {
	trimmedLine := func(line string) string {
		return strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
	}

	openIdx = 0
	for openIdx < len(lines) && trimmedLine(lines[openIdx]) == "" {
		openIdx++
	}
	if openIdx == len(lines) || trimmedLine(lines[openIdx]) != "---" {
		return 0, 0, false
	}
	for i := openIdx + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return openIdx, i, true
		}
	}
	return 0, 0, false
}

// splitFrontmatter returns the YAML lines between the opening and closing
// "---", plus the note body that follows the block. ok is false when the note
// has no (complete) frontmatter. This is the single scanner used by tag
// parsing, frontmatter decoding, export and the outline extractor.
func splitFrontmatter(content string) (fmLines []string, body string, ok bool) {
	// Windows editors often leave a BOM in front; it is not whitespace, so
	// TrimSpace alone would make the first-line check fail.
	content = strings.TrimPrefix(content, "\ufeff")
	trimmed := strings.TrimSpace(content)
	lines := strings.Split(trimmed, "\n")

	open, close, found := frontmatterBounds(lines)
	if !found {
		return nil, "", false
	}
	return lines[open+1 : close], strings.Join(lines[close+1:], "\n"), true
}

// StripFrontmatter removes a note's leading YAML block (used by HTML export,
// which renders the body only). Returns content unchanged when there is no
// complete frontmatter.
func StripFrontmatter(content string) string {
	if _, body, ok := splitFrontmatter(content); ok {
		return body
	}
	return content
}

// ParseTags extracts tags from a note's YAML frontmatter.
//
// Supported shapes (key matched case-insensitively, "tags" or "tag"):
//
//	tags: [a, b]
//	tags: a
//	tags:
//	  - a
//
// It tolerates a UTF-8 BOM and blank lines before the opening "---" (common
// in files saved by Windows editors) and strips quotes around values, so the
// same note parses identically no matter which editor wrote it.
func ParseTags(content string) []string {
	fmLines, _, ok := splitFrontmatter(content)
	if !ok {
		return []string{}
	}

	var rawTags []string
	inTagsList := false

	// Normalize one raw tag value: trim, drop surrounding quotes, lowercase.
	cleanTag := func(t string) string {
		t = strings.ToLower(strings.TrimSpace(t))
		if len(t) >= 2 {
			if q := t[0]; (q == '"' || q == '\'') && t[len(t)-1] == q {
				t = strings.TrimSpace(t[1 : len(t)-1])
			}
		}
		return t
	}

	for _, line := range fmLines {
		stripped := strings.TrimSpace(line)

		if !inTagsList {
			key, rest, hasKey := strings.Cut(stripped, ":")
			if !hasKey {
				continue
			}
			key = strings.ToLower(strings.TrimSpace(key))
			if key != "tags" && key != "tag" {
				continue
			}

			rest = strings.TrimSpace(rest)
			if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				for _, p := range strings.Split(rest[1:len(rest)-1], ",") {
					if t := cleanTag(p); t != "" {
						rawTags = append(rawTags, t)
					}
				}
				break
			} else if rest != "" {
				if t := cleanTag(rest); t != "" {
					rawTags = append(rawTags, t)
				}
				break
			}
			inTagsList = true
			continue
		}

		// Inside a multiline "tags:" block.
		if strings.HasPrefix(stripped, "-") {
			if t := cleanTag(strings.TrimPrefix(stripped, "-")); t != "" {
				rawTags = append(rawTags, t)
			}
		} else if stripped != "" && !strings.HasPrefix(stripped, "#") {
			break
		}
	}

	// Unique & sort
	tagMap := make(map[string]struct{})
	for _, t := range rawTags {
		tagMap[t] = struct{}{}
	}
	result := make([]string, 0, len(tagMap))
	for t := range tagMap {
		result = append(result, t)
	}
	sort.Strings(result)
	return result
}

// ParseFrontmatter decodes the leading YAML block of a note, preserving the
// order in which keys were declared. Returns nil when the note has no
// frontmatter, it is empty, or it does not parse.
func ParseFrontmatter(content string) Frontmatter {
	fmLines, _, ok := splitFrontmatter(content)
	if !ok || len(fmLines) == 0 {
		return nil
	}
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(strings.Join(fmLines, "\n")), &root); err != nil {
		return nil
	}
	if root.Kind != yaml.DocumentNode || len(root.Content) == 0 {
		return nil
	}
	doc := root.Content[0]
	if doc.Kind != yaml.MappingNode {
		return nil
	}
	fm := make(Frontmatter, 0, len(doc.Content)/2)
	for i := 0; i+1 < len(doc.Content); i += 2 {
		var val any
		if err := doc.Content[i+1].Decode(&val); err != nil {
			continue
		}
		fm = append(fm, FrontmatterField{
			Key:   doc.Content[i].Value,
			Value: normalizeYAMLValue(val),
		})
	}
	if len(fm) == 0 {
		return nil
	}
	return fm
}

// normalizeYAMLValue makes yaml decoding artifacts JSON-friendly. The only
// interesting case is time.Time: date-only timestamps keep their YYYY-MM-DD
// shape so the UI still renders them as local dates, everything else becomes
// an RFC3339 string (which the UI parses as-is).
func normalizeYAMLValue(v any) any {
	switch t := v.(type) {
	case time.Time:
		if t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0 && t.Location() == time.UTC {
			return t.Format("2006-01-02")
		}
		return t.Format(time.RFC3339)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			out[k] = normalizeYAMLValue(vv)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			out[fmt.Sprint(k)] = normalizeYAMLValue(vv)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, vv := range t {
			out[i] = normalizeYAMLValue(vv)
		}
		return out
	default:
		return v
	}
}

// ExtractOutline collects the #..###### headings of content for the TOC
// panel, skipping the frontmatter block and fenced code blocks. Slugs follow
// the GitHub-style rules the frontend used to apply (lowercase, strip
// non-word chars, spaces to dashes) with a counter suffix for duplicates, so
// in-page anchors keep working unchanged.
func ExtractOutline(content string) []OutlineItem {
	outline := []OutlineItem{}
	if content == "" {
		return outline
	}

	lines := strings.Split(content, "\n")
	slugCounts := map[string]int{}
	inCodeBlock := false

	// Start after the frontmatter block when there is one. The indices stay
	// relative to the original content so OutlineItem.Line keeps matching the
	// editor's line numbers.
	start := 0
	if _, closeIdx, ok := frontmatterBounds(lines); ok {
		start = closeIdx + 1
	}

	for i := start; i < len(lines); i++ {
		line := lines[i]

		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inCodeBlock = !inCodeBlock
			continue
		}
		if inCodeBlock {
			continue
		}

		m := headingRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		text := strings.TrimSpace(m[2])
		slug := headingSlug(text)
		if n, seen := slugCounts[slug]; seen {
			slugCounts[slug] = n + 1
			slug = fmt.Sprintf("%s-%d", slug, n+1)
		} else {
			slugCounts[slug] = 0
		}
		outline = append(outline, OutlineItem{
			Level: len(m[1]),
			Text:  text,
			Slug:  slug,
			Line:  i + 1, // 1-indexed, matches the editor's line numbering
		})
	}
	return outline
}

// headingSlug mirrors the frontend's historical slug algorithm: lowercase,
// drop every character outside [a-z0-9_ -], spaces to dashes, collapse
// repeated dashes. ASCII-only, exactly like the regex it replaces.
func headingSlug(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == ' ' || r == '-' {
			b.WriteRune(r)
		}
	}
	out := strings.ReplaceAll(b.String(), " ", "-")
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return out
}

// NoteParsed carries everything derived from a note's content in one pass, so
// handlers can answer load/save requests without the client re-parsing YAML
// or headings.
type NoteParsed struct {
	Tags        []string
	Frontmatter Frontmatter
	Outline     []OutlineItem
}

// ParseNote runs the single content pass shared by every endpoint that needs
// derived note data.
func ParseNote(content string) NoteParsed {
	return NoteParsed{
		Tags:        ParseTags(content),
		Frontmatter: ParseFrontmatter(content),
		Outline:     ExtractOutline(content),
	}
}
