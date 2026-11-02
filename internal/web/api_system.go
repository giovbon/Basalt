package web

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"notediscovery/internal/config"
	"notediscovery/internal/themes"
	"notediscovery/internal/vault"
)

type SystemHandler struct {
	cfg      *config.Config
	vault    *vault.Vault
	assetsFS fs.FS
}

func NewSystemHandler(cfg *config.Config, v *vault.Vault, assetsFS fs.FS) *SystemHandler {
	return &SystemHandler{
		cfg:      cfg,
		vault:    v,
		assetsFS: assetsFS,
	}
}

type AuthStatus struct {
	Enabled bool `json:"enabled"`
}

type ConfigResponse struct {
	Name            string     `json:"name"`
	Version         string     `json:"version"`
	SearchEnabled   bool       `json:"searchEnabled"`
	DemoMode        bool       `json:"demoMode"`
	AlreadyDonated  bool       `json:"alreadyDonated"`
	AutosaveDelayMs int        `json:"autosaveDelayMs"`
	DefaultTheme    string     `json:"defaultTheme"`
	UploadMaxNoteMb int        `json:"uploadMaxNoteMb"`
	Authentication  AuthStatus `json:"authentication"`
}

func (h *SystemHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	resp := ConfigResponse{
		Name:            h.cfg.App.Name,
		Version:         h.cfg.App.Version,
		SearchEnabled:   h.cfg.Search.Enabled,
		DemoMode:        h.cfg.DemoMode,
		AlreadyDonated:  h.cfg.AlreadyDonated,
		AutosaveDelayMs: h.cfg.UI.AutosaveDelayMs,
		DefaultTheme:    h.cfg.UI.DefaultTheme,
		UploadMaxNoteMb: h.cfg.UploadMaxNoteMb,
		Authentication: AuthStatus{
			Enabled: h.cfg.Authentication.Enabled,
		},
	}
	RespondJSON(w, http.StatusOK, resp)
}

func (h *SystemHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, map[string]any{
		"status":  "healthy",
		"app":     h.cfg.App.Name,
		"version": h.cfg.App.Version,
	})
}

func (h *SystemHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	notes, folders, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load stats")
		return
	}

	noteCount := 0
	mediaCount := 0
	var totalSize int64
	var latestMtime float64
	var latestTimeStr *string
	tagSet := make(map[string]struct{})

	for _, n := range notes {
		if n.Type == "note" {
			noteCount++
			for _, t := range n.Tags {
				tagSet[t] = struct{}{}
			}
		} else {
			mediaCount++
		}
		totalSize += n.Size
		if n.MTime > latestMtime {
			latestMtime = n.MTime
			mod := n.Modified
			latestTimeStr = &mod
		}
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"notes_count":      noteCount,
		"folders_count":    len(folders),
		"tags_count":       len(tagSet),
		"media_count":      mediaCount,
		"total_size_bytes": totalSize,
		"last_modified":    latestTimeStr,
		"version":          h.cfg.App.Version,
	})
}

func (h *SystemHandler) GetGraph(w http.ResponseWriter, r *http.Request) {
	includeSys := true
	if val := r.URL.Query().Get("include_system_folders"); val == "false" || val == "0" {
		includeSys = false
	}

	data, err := h.vault.GetGraphData(includeSys)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to build graph")
		return
	}

	RespondJSON(w, http.StatusOK, data)
}

func (h *SystemHandler) ListThemes(w http.ResponseWriter, r *http.Request) {
	allThemes, err := themes.ListThemes(h.assetsFS)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to list themes")
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"themes": allThemes,
	})
}

func (h *SystemHandler) GetThemeCSS(w http.ResponseWriter, r *http.Request) {
	themeID := r.PathValue("id")
	css, err := themes.GetThemeCSS(h.assetsFS, themeID)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Theme not found")
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"css":      css,
		"theme_id": themeID,
	})
}

type LocaleMeta struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Flag string `json:"flag"`
}

func (h *SystemHandler) ListLocales(w http.ResponseWriter, r *http.Request) {
	entries, err := fs.ReadDir(h.assetsFS, "locales")
	if err != nil {
		RespondJSON(w, http.StatusOK, map[string]any{"locales": []LocaleMeta{}})
		return
	}

	var locales []LocaleMeta
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(h.assetsFS, path.Join("locales", entry.Name()))
		if err != nil {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			continue
		}

		code := strings.TrimSuffix(entry.Name(), ".json")
		name := code
		flag := "🌐"

		if metaRaw, ok := parsed["_meta"].(map[string]any); ok {
			if c, ok := metaRaw["code"].(string); ok && c != "" {
				code = c
			}
			if n, ok := metaRaw["name"].(string); ok && n != "" {
				name = n
			}
			if f, ok := metaRaw["flag"].(string); ok && f != "" {
				flag = f
			}
		}

		locales = append(locales, LocaleMeta{
			Code: code,
			Name: name,
			Flag: flag,
		})
	}

	RespondJSON(w, http.StatusOK, map[string]any{"locales": locales})
}

var localeRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func (h *SystemHandler) GetLocale(w http.ResponseWriter, r *http.Request) {
	localeCode := r.PathValue("code")
	if !localeRegex.MatchString(localeCode) {
		RespondError(w, http.StatusBadRequest, "Invalid locale code")
		return
	}

	fileName := path.Join("locales", localeCode+".json")
	data, err := fs.ReadFile(h.assetsFS, fileName)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Locale not found")
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		RespondError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to load locale: %s", err.Error()))
		return
	}

	RespondJSON(w, http.StatusOK, parsed)
}

// Export Note as HTML
func (h *SystemHandler) ExportNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	content, err := h.vault.GetNoteContent(notePath)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	// Resolve wikilinks/media against the whole vault, same as the graph does.
	notes, _, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to scan notes")
		return
	}
	var notePaths []string
	media := make(map[string]string)
	for _, n := range notes {
		if n.Type == "note" {
			notePaths = append(notePaths, n.Path)
			continue
		}
		// Lowercase filename -> vault path, first match wins (mirrors the
		// frontend's media lookup).
		filename := n.Path
		if i := strings.LastIndex(filename, "/"); i >= 0 {
			filename = filename[i+1:]
		}
		filename = strings.ToLower(filename)
		if _, exists := media[filename]; !exists {
			media[filename] = n.Path
		}
	}
	resolver := vault.NewLinkResolver(notePaths)

	rendered, err := exportNoteHTML(content, vault.NormalizedRelPath(notePath), resolver, media)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to render note")
		return
	}

	themeID := r.URL.Query().Get("theme")
	if themeID == "" {
		themeID = h.cfg.UI.DefaultTheme
	}
	css, _ := themes.GetThemeCSS(h.assetsFS, themeID)

	isDownload := r.URL.Query().Get("download") != "false"
	stem := strings.TrimSuffix(filepath.Base(notePath), filepath.Ext(notePath))

	htmlTemplate := `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>%s</title>
  <style>%s</style>
</head>
<body class="markdown-body">
  <article>%s</article>
</body>
</html>`

	body := fmt.Sprintf(htmlTemplate, htmlEscape(stem), css, rendered)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if isDownload {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.html"`, stem))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

var storedArchiveExts = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".avif": {},
	".mp3": {}, ".m4a": {}, ".ogg": {}, ".oga": {}, ".opus": {}, ".flac": {},
	".mp4": {}, ".webm": {}, ".mov": {}, ".mkv": {}, ".avi": {},
	".pdf": {}, ".zip": {}, ".gz": {}, ".bz2": {}, ".xz": {}, ".7z": {}, ".rar": {},
}

func (h *SystemHandler) ArchiveFolder(w http.ResponseWriter, r *http.Request) {
	folderParam := r.URL.Query().Get("folder")
	targetFolder, err := h.vault.ResolveVaultFolder(folderParam)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid folder path")
		return
	}

	files, totalBytes, err := h.vault.CollectFolderFiles(targetFolder)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to collect folder files")
		return
	}

	maxBytes := int64(h.cfg.ArchiveMaxMb) * 1024 * 1024
	if totalBytes > maxBytes {
		RespondError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("Folder is %d MB, which exceeds the %d MB archive limit", totalBytes/(1024*1024), h.cfg.ArchiveMaxMb))
		return
	}

	archiveName := "vault"
	if folderParam != "" {
		archiveName = filepath.Base(folderParam)
	}
	timestamp := time.Now().UTC().Format("2006-01-02-150405")
	downloadFilename := fmt.Sprintf("%s-%s.zip", archiveName, timestamp)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, downloadFilename))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	for _, file := range files {
		rel, err := filepath.Rel(targetFolder, file)
		if err != nil {
			continue
		}
		rel = strings.ReplaceAll(rel, "\\", "/")

		ext := strings.ToLower(filepath.Ext(file))
		method := zip.Deflate
		if _, stored := storedArchiveExts[ext]; stored {
			method = zip.Store
		}

		info, err := os.Stat(file)
		if err != nil {
			continue
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			continue
		}
		header.Name = rel
		header.Method = method

		entryWriter, err := zipWriter.CreateHeader(header)
		if err != nil {
			continue
		}

		f, err := os.Open(file)
		if err != nil {
			continue
		}
		_, _ = io.Copy(entryWriter, f)
		f.Close()
	}
}

func htmlEscape(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#x27;",
	).Replace(s)
}
