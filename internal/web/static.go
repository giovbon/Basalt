package web

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"

	"notediscovery/internal/config"
)

// staticAsset is one file served by ServeStatic. data/gzipData and their
// ETags are computed once per process; after that a request only picks the
// representation and writes it, with no read, compression or hashing.
type staticAsset struct {
	data        []byte
	gzipData    []byte
	contentType string
	etag        string
	gzipETag    string
}

type StaticHandler struct {
	cfg      *config.Config
	assetsFS fs.FS

	index    *staticAsset
	indexErr error

	assets sync.Map // filePath -> *staticAsset
}

func NewStaticHandler(cfg *config.Config, assetsFS fs.FS) *StaticHandler {
	h := &StaticHandler{
		cfg:      cfg,
		assetsFS: assetsFS,
	}
	// The shell is rendered from config that never changes after startup, so
	// do the replacements, locale inlining, gzip and hashing once instead of on
	// every SPA navigation.
	h.index, h.indexErr = buildIndex(assetsFS, cfg)
	return h
}

// makeAsset snapshots data for serving, pre-compressing and hashing the two
// representations once.
func makeAsset(data []byte, contentType string) *staticAsset {
	asset := &staticAsset{
		data:        data,
		contentType: contentType,
		etag:        shortETag(data, ""),
	}
	if contentType == "" || !isCompressibleContentType(contentType) {
		return asset
	}

	var buf bytes.Buffer
	gz, err := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	if err != nil {
		return asset
	}
	if _, err := gz.Write(data); err != nil {
		return asset
	}
	if err := gz.Close(); err != nil {
		return asset
	}
	asset.gzipData = buf.Bytes()
	asset.gzipETag = shortETag(asset.gzipData, "-gzip")
	return asset
}

func shortETag(data []byte, suffix string) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf(`"%s%s"`, hex.EncodeToString(sum[:])[:16], suffix)
}

func buildIndex(assetsFS fs.FS, cfg *config.Config) (*staticAsset, error) {
	data, err := fs.ReadFile(assetsFS, "frontend/index.html")
	if err != nil {
		return nil, err
	}

	content := string(data)
	content = RenderAppNameHTML(content, cfg.App.Name)
	content = strings.ReplaceAll(content, "__APP_VERSION__", url.QueryEscape(cfg.App.Version))
	content = strings.ReplaceAll(content, "__DEFAULT_THEME__", cfg.UI.DefaultTheme)

	// Inline the shipped locale's translations (see __PRELOADED_TRANSLATIONS__
	// in index.html) so the document arrives with its translations already
	// embedded instead of the page issuing a synchronous XHR before Alpine
	// initializes.
	content = renderPreloadedTranslations(assetsFS, content)

	return makeAsset([]byte(content), "text/html; charset=utf-8"), nil
}

func RenderAppNameHTML(content string, appName string) string {
	escaped := htmlEscape(appName)
	return strings.ReplaceAll(content, "__APP_NAME__", escaped)
}

func (h *StaticHandler) ServeIndex(w http.ResponseWriter, r *http.Request) {
	if h.indexErr != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	serveAsset(w, r, h.index, "no-cache")
}

// renderPreloadedTranslations replaces the __PRELOADED_TRANSLATIONS__ placeholder
// in index.html with the pt-BR locale JSON (the only shipped locale; the page is
// already lang="pt-BR"). json.Marshal HTML-escapes <, > and & inside
// strings, so even a translation containing a closing script tag cannot break
// out of the embedding <script> block. On any error the placeholder becomes an
// empty object, keeping Alpine's translations an object so t() can walk it.
func renderPreloadedTranslations(assetsFS fs.FS, content string) string {
	var translations any
	if data, err := fs.ReadFile(assetsFS, "locales/pt-BR.json"); err == nil {
		if err := json.Unmarshal(data, &translations); err != nil {
			translations = nil
		}
	}
	if translations == nil {
		translations = map[string]any{}
	}
	encoded, err := json.Marshal(translations)
	if err != nil {
		encoded = []byte("{}")
	}
	return strings.ReplaceAll(content, "__PRELOADED_TRANSLATIONS__", string(encoded))
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

	asset, err := h.loadAsset(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// Caching strategy: immutable if has ?v= or is mermaid vendor chunk
	isVersioned := r.URL.Query().Get("v") != "" || strings.Contains(relPath, "vendor/mermaid/chunks/")
	if isVersioned {
		serveAsset(w, r, asset, "public, max-age=31536000, immutable")
		return
	}
	serveAsset(w, r, asset, "no-cache")
}

// loadAsset reads and prepares a static file the first time it is requested.
// Vendor chunks are numerous and large, so precompressing every one at startup
// would delay boot; the sync.Map makes the cost a one-off per file.
func (h *StaticHandler) loadAsset(filePath string) (*staticAsset, error) {
	if cached, ok := h.assets.Load(filePath); ok {
		return cached.(*staticAsset), nil
	}

	data, err := fs.ReadFile(h.assetsFS, filePath)
	if err != nil {
		return nil, err
	}
	asset := makeAsset(data, staticContentType(path.Ext(filePath)))
	actual, _ := h.assets.LoadOrStore(filePath, asset)
	return actual.(*staticAsset), nil
}

func staticContentType(ext string) string {
	switch ext {
	case ".js", ".mjs":
		return "application/javascript"
	case ".map":
		return "application/json"
	case ".css":
		return "text/css; charset=utf-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".svg":
		return "image/svg+xml"
	case ".json":
		return "application/json"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	}
	// Preserve the Content-Type net/http used to sniff for the remaining
	// asset types (.html, .md, .ico, ...). Sniffing no longer happens because
	// serveAsset writes the header explicitly.
	return mime.TypeByExtension(ext)
}

// serveAsset writes asset with the most specific encoding the client accepts.
// The ETag identifies the representation, so a validated gzip response is not
// confused with the identity one.
func serveAsset(w http.ResponseWriter, r *http.Request, asset *staticAsset, cacheControl string) {
	body := asset.data
	etag := asset.etag
	// Representation selection depends only on Accept-Encoding. HEAD must
	// advertise the same ETag/Content-Encoding a GET would use; net/http
	// suppresses the body on its own.
	if asset.gzipData != nil && acceptsGzipEncoding(r.Header.Get("Accept-Encoding")) {
		body = asset.gzipData
		etag = asset.gzipETag
		w.Header().Set("Content-Encoding", "gzip")
	}

	if asset.contentType != "" {
		w.Header().Set("Content-Type", asset.contentType)
	}
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("ETag", etag)

	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (h *StaticHandler) CatchAll(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/static/") {
		http.NotFound(w, r)
		return
	}
	h.ServeIndex(w, r)
}
