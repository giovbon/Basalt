package web

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"

	"notediscovery/internal/vault"
)

// markdownRE / wikilink patterns used when converting a note to standalone
// HTML. Wikilinks are rewritten to plain markdown before goldmark sees them,
// mirroring what the live preview renderer does client-side.
var (
	exportFenceRE = regexp.MustCompile("^(?:```|~~~)")
	exportWikiRE  = regexp.MustCompile(`(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
)

// exportMarkdown is goldmark configured to match the app's preview: GFM
// (tables, task lists, strikethrough, linkify), auto heading IDs for
// #anchor links, and raw HTML allowed (the exporter owns the note content;
// the file is meant to be opened locally, like Obsidian's own export).
var exportMarkdown = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

// exportNoteHTML renders note content as the body of a standalone HTML
// export: frontmatter stripped, wikilinks and media links resolved through
// the same LinkResolver the graph uses, then goldmark.
//
// vaultRel is the note's vault-relative path ("" for root-level notes); it
// anchors relative link resolution. media maps lowercase filename -> vault
// path for ![[image.png]] embeds.
func exportNoteHTML(content, vaultRel string, resolver *vault.LinkResolver, media map[string]string) (string, error) {
	sourceFolder := ""
	if i := strings.LastIndex(vaultRel, "/"); i >= 0 {
		sourceFolder = vaultRel[:i]
	}

	md := vault.StripFrontmatter(content)
	md = rewriteExportWikilinks(md, resolver, media, sourceFolder)

	var buf strings.Builder
	if err := exportMarkdown.Convert([]byte(md), &buf); err != nil {
		return "", fmt.Errorf("render markdown: %w", err)
	}
	return buf.String(), nil
}

// rewriteExportWikilinks converts Obsidian-style embeds/links into markdown
// goldmark understands, skipping fenced code blocks (where [[...]] is text).
// Targets that resolve to nothing are left exactly as written.
func rewriteExportWikilinks(md string, resolver *vault.LinkResolver, media map[string]string, sourceFolder string) string {
	lines := strings.Split(md, "\n")
	inFence := false

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if exportFenceRE.MatchString(trimmed) {
			inFence = !inFence
			continue
		}
		if inFence || !strings.Contains(line, "[[") {
			continue
		}

		lines[i] = exportWikiRE.ReplaceAllStringFunc(line, func(match string) string {
			sub := exportWikiRE.FindStringSubmatch(match)
			isEmbed, target, display := sub[1], strings.TrimSpace(sub[2]), strings.TrimSpace(sub[3])

			// Section anchors ride along with the target: [[note#sec]].
			base, anchor := target, ""
			if h := strings.Index(target, "#"); h >= 0 {
				base, anchor = target[:h], target[h:]
			}

			if isEmbed == "!" {
				path, ok := media[strings.ToLower(base)]
				if !ok {
					return match
				}
				alt := display
				if alt == "" {
					alt = base
				}
				return fmt.Sprintf("![%s](%s)", escapeLinkText(alt), "/api/media/"+escapeVaultPath(path))
			}

			resolved := resolver.ResolveWikilink(base, sourceFolder)
			if resolved == "" {
				// Media files are link targets too ([[report.pdf]]): notes win
				// because the resolver ran first, the file itself is the
				// fallback, and the target keeps its extension.
				if path, ok := media[strings.ToLower(base)]; ok {
					text := display
					if text == "" {
						text = base
					}
					return fmt.Sprintf("[%s](/api/media/%s)", escapeLinkText(text), escapeVaultPath(path))
				}
				return match
			}
			text := display
			if text == "" {
				text = base
			}
			return fmt.Sprintf("[%s](/%s%s)", escapeLinkText(text), escapeVaultPath(strings.TrimSuffix(resolved, ".md")), anchor)
		})
	}
	return strings.Join(lines, "\n")
}

// escapeLinkText keeps a wikilink's display text from breaking the generated
// markdown link (brackets and backslashes are the dangerous characters).
func escapeLinkText(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "[", `\[`)
	s = strings.ReplaceAll(s, "]", `\]`)
	return s
}

// escapeVaultPath percent-encodes each path segment so links with spaces
// survive markdown and HTML attribute parsing.
func escapeVaultPath(p string) string {
	segments := strings.Split(p, "/")
	for i, seg := range segments {
		segments[i] = url.PathEscape(seg)
	}
	return strings.Join(segments, "/")
}
