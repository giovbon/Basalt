package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"notediscovery/internal/config"
)

func newTestStaticHandler(t *testing.T) *StaticHandler {
	t.Helper()
	assets := fstest.MapFS{
		"frontend/index.html": &fstest.MapFile{Data: []byte(`<html lang="pt-BR"><head><title>__APP_NAME__</title></head><body>__PRELOADED_TRANSLATIONS__</body></html>`)},
		"frontend/app.js":     &fstest.MapFile{Data: []byte(strings.Repeat("console.log('asset');\n", 20))},
		"frontend/style.css":  &fstest.MapFile{Data: []byte(strings.Repeat(".rule { color: red; }\n", 20))},
		"frontend/page.html":  &fstest.MapFile{Data: []byte("<html><body>static page</body></html>")},
		"locales/pt-BR.json":  &fstest.MapFile{Data: []byte(`{"app.title": "Minha Nota", "nav.home": "Início"}`)},
	}
	cfg := &config.Config{
		App: config.AppConfig{
			Name:    "Basalt",
			Version: "1.0.0",
		},
		UI: config.UIConfig{DefaultTheme: "light"},
	}
	return NewStaticHandler(cfg, assets)
}

func TestServeIndexPreloadsTranslations(t *testing.T) {
	h := newTestStaticHandler(t)

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeIndex(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Minha Nota") {
		t.Error("body does not contain preloaded translation (app.title)")
	}
	if strings.Contains(body, "__PRELOADED_TRANSLATIONS__") {
		t.Error("__PRELOADED_TRANSLATIONS__ placeholder was not replaced")
	}
	if !strings.Contains(body, "Basalt") {
		t.Error("__APP_NAME__ was not replaced with Basalt")
	}
	if strings.Contains(body, "__APP_NAME__") {
		t.Error("__APP_NAME__ placeholder was not replaced")
	}
	if strings.Contains(body, "__DEFAULT_THEME__") {
		t.Error("__DEFAULT_THEME__ placeholder was not replaced")
	}
	if strings.Contains(body, "__APP_VERSION__") {
		t.Error("__APP_VERSION__ placeholder was not replaced")
	}
}

func TestServeIndexETag304(t *testing.T) {
	h := newTestStaticHandler(t)

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeIndex(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag set on response")
	}

	req2 := httptest.NewRequest("GET", "/", nil)
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.ServeIndex(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("status = %d, want 304 on If-None-Match match", rec2.Code)
	}
}

// gunzip decodes a single gzip member, failing the test on error.
func gunzip(t *testing.T, data []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("response is not gzip: %v", err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading gzip body: %v", err)
	}
	return out
}

func TestServeStaticGzipAndVersionedCache(t *testing.T) {
	h := newTestStaticHandler(t)

	req := httptest.NewRequest("GET", "/static/app.js?v=0.33.6", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	rec := httptest.NewRecorder()
	h.ServeStatic(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable for a versioned asset", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/javascript") {
		t.Errorf("Content-Type = %q, want application/javascript", got)
	}
	body := string(gunzip(t, rec.Body.Bytes()))
	if !strings.Contains(body, "console.log('asset')") {
		t.Errorf("decoded body = %q, want the original JavaScript", body)
	}

	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on static response")
	}

	req2 := httptest.NewRequest("GET", "/static/app.js?v=0.33.6", nil)
	req2.Header.Set("Accept-Encoding", "gzip")
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.ServeStatic(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("gzip ETag status = %d, want 304", rec2.Code)
	}

	// The identity and gzip representations must not share an ETag, or a
	// validator cached for one could 304 the other.
	identity := httptest.NewRequest("GET", "/static/app.js", nil)
	rec3 := httptest.NewRecorder()
	h.ServeStatic(rec3, identity)
	if got := rec3.Header().Get("ETag"); got == etag || got == "" {
		t.Errorf("identity ETag = %q, want a distinct non-empty value from %q", got, etag)
	}
}

func TestServeStaticUnknownExtensionKeepsContentType(t *testing.T) {
	h := newTestStaticHandler(t)

	req := httptest.NewRequest("GET", "/static/page.html", nil)
	rec := httptest.NewRecorder()
	h.ServeStatic(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", got)
	}
}

// TestGzipHandlerDoesNotRecompressAssets guards the double-compression bug:
// static.go serves assets already gzipped, so the outer gzip middleware must
// leave Content-Encoding: gzip responses untouched.
func TestGzipHandlerDoesNotRecompressAssets(t *testing.T) {
	h := newTestStaticHandler(t)

	staticHandler := gzipHandler(http.HandlerFunc(h.ServeStatic))
	req := httptest.NewRequest("GET", "/static/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	staticHandler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	// A double-compressed body would decompress once into another gzip member
	// and never contain the original JavaScript.
	body := string(gunzip(t, rec.Body.Bytes()))
	if !strings.Contains(body, "console.log('asset')") {
		t.Errorf("decoded body = %q, want the original JavaScript exactly once", body)
	}

	indexHandler := gzipHandler(http.HandlerFunc(h.ServeIndex))
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	indexHandler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("index Content-Encoding = %q, want gzip", got)
	}
	shell := string(gunzip(t, rec.Body.Bytes()))
	if !strings.Contains(shell, "Minha Nota") || strings.Contains(shell, "__PRELOADED_TRANSLATIONS__") {
		t.Errorf("decoded shell = %q, want rendered index.html", shell)
	}
}

// TestStaticETag304HasNoBody ensures the conditional response carries no body.
func TestStaticETag304HasNoBody(t *testing.T) {
	h := newTestStaticHandler(t)

	req := httptest.NewRequest("GET", "/static/style.css", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeStatic(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	req2 := httptest.NewRequest("GET", "/static/style.css", nil)
	req2.Header.Set("Accept-Encoding", "gzip")
	req2.Header.Set("If-None-Match", rec.Header().Get("ETag"))
	rec2 := httptest.NewRecorder()
	h.ServeStatic(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Errorf("304 body length = %d, want 0", rec2.Body.Len())
	}
}
