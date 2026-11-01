package web

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"

	"notediscovery/internal/config"
)

type StaticHandler struct {
	cfg      *config.Config
	assetsFS fs.FS
}

func NewStaticHandler(cfg *config.Config, assetsFS fs.FS) *StaticHandler {
	return &StaticHandler{
		cfg:      cfg,
		assetsFS: assetsFS,
	}
}

func RenderAppNameHTML(content string, appName string) string {
	escaped := htmlEscape(appName)
	return strings.ReplaceAll(content, "__APP_NAME__", escaped)
}

func (h *StaticHandler) ServeIndex(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(h.assetsFS, "frontend/index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}

	content := string(data)
	content = RenderAppNameHTML(content, h.cfg.App.Name)
	content = strings.ReplaceAll(content, "__APP_VERSION__", url.QueryEscape(h.cfg.App.Version))
	content = strings.ReplaceAll(content, "__DEFAULT_THEME__", h.cfg.UI.DefaultTheme)

	hasher := sha256.New()
	hasher.Write([]byte(content))
	etag := fmt.Sprintf(`"%s"`, hex.EncodeToString(hasher.Sum(nil))[:16])

	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}

func (h *StaticHandler) ServeManifest(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(h.assetsFS, "frontend/manifest.json")
	if err != nil {
		http.Error(w, "manifest.json not found", http.StatusNotFound)
		return
	}

	content := string(data)
	jsonEncodedName, _ := json.Marshal(h.cfg.App.Name)
	rawName := string(jsonEncodedName)
	if strings.HasPrefix(rawName, `"`) && strings.HasSuffix(rawName, `"`) {
		rawName = rawName[1 : len(rawName)-1]
	}
	content = strings.ReplaceAll(content, "__APP_NAME__", rawName)

	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}

func (h *StaticHandler) ServeSW(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(h.assetsFS, "frontend/sw.js")
	if err != nil {
		http.Error(w, "sw.js not found", http.StatusNotFound)
		return
	}

	content := string(data)
	content = strings.ReplaceAll(content, "__APP_VERSION__", url.QueryEscape(h.cfg.App.Version))

	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}

func (h *StaticHandler) ServeStatic(w http.ResponseWriter, r *http.Request) {
	relPath := strings.TrimPrefix(r.URL.Path, "/static/")
	filePath := path.Join("frontend", relPath)

	data, err := fs.ReadFile(h.assetsFS, filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// Caching strategy: immutable if has ?v= or is mermaid vendor chunk
	isVersioned := r.URL.Query().Get("v") != "" || strings.Contains(relPath, "vendor/mermaid/chunks/")
	if isVersioned {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}

	// Content-Type by extension
	ext := path.Ext(filePath)
	switch ext {
	case ".js", ".mjs":
		w.Header().Set("Content-Type", "application/javascript")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	case ".json":
		w.Header().Set("Content-Type", "application/json")
	case ".woff2":
		w.Header().Set("Content-Type", "font/woff2")
	case ".woff":
		w.Header().Set("Content-Type", "font/woff")
	case ".ttf":
		w.Header().Set("Content-Type", "font/ttf")
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (h *StaticHandler) CatchAll(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/static/") {
		http.NotFound(w, r)
		return
	}
	h.ServeIndex(w, r)
}
