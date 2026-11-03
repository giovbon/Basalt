package web

import (
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
