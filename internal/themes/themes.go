package themes

import (
	"bufio"
	"io"
	"io/fs"
	"path"
	"strings"
)

type ThemeInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Icon     string `json:"icon"`
	Selected bool   `json:"selected,omitempty"`
}

var themeIcons = map[string]string{
	"light":             "🌞",
	"dark":              "🌙",
	"dracula":           "🧛",
	"nord":              "❄️",
	"monokai":           "🎞️",
	"vue-high-contrast": "💚",
	"cobalt2":           "🌊",
	"vs-blue":           "🔷",
	"gruvbox-dark":      "🟫",
	"matcha-light":      "🍵",
	"hacker":            "🖥️",
	"ubuntu":            "🟠",
	"catppuccin-latte":  "🧋",
	"tokyo-night":       "⛩️",
	"one-dark-pro":      "⚫",
	"synthwave-84":      "🕹️",
}

// titleCase converts "matcha light" to "Matcha Light"
func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])
		}
	}
	return strings.Join(words, " ")
}

// ParseThemeMetadata inspects the CSS comment for @theme-type: light|dark
func ParseThemeMetadata(r io.Reader) string {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.Contains(line, "@theme-type") {
			parts := strings.Split(line, "@theme-type")
			if len(parts) > 1 {
				val := strings.TrimSpace(parts[1])
				val = strings.Trim(val, "* /")
				val = strings.TrimSpace(val)
				if val == "light" || val == "dark" {
					return val
				}
			}
		}
		// Stop reading header after initial comment block
		if strings.Contains(line, "*/") {
			break
		}
	}
	return "dark" // default if not specified
}

// ListThemes returns all themes found under the themes/ directory in fsys
func ListThemes(fsys fs.FS) ([]ThemeInfo, error) {
	entries, err := fs.ReadDir(fsys, "themes")
	if err != nil {
		return nil, err
	}

	var themes []ThemeInfo
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".css") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".css")
		cleanName := strings.ReplaceAll(strings.ReplaceAll(id, "-", " "), "_", " ")
		name := titleCase(cleanName)

		icon := "🎨"
		if ic, ok := themeIcons[id]; ok {
			icon = ic
		}

		themeType := "dark"
		if file, err := fsys.Open(path.Join("themes", entry.Name())); err == nil {
			themeType = ParseThemeMetadata(file)
			file.Close()
		}

		themes = append(themes, ThemeInfo{
			ID: id,
			// Plain text: the settings <select> renders names with x-text, and
			// a native option cannot contain an SVG icon.
			Name: name,
			Type: themeType,
			Icon: icon,
		})
	}
	return themes, nil
}

// GetThemeCSS retrieves the CSS content of a theme ID
func GetThemeCSS(fsys fs.FS, themeID string) (string, error) {
	cleanID := strings.TrimSuffix(themeID, ".css")
	filePath := path.Join("themes", cleanID+".css")
	data, err := fs.ReadFile(fsys, filePath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
