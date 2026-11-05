package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGzipHandlerCompressesJSON guards the other side of the Content-Encoding
// check: ordinary handler responses must still be compressed.
func TestGzipHandlerCompressesJSON(t *testing.T) {
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"message":"` + strings.Repeat("x", 200) + `"}`))
	}))

	req := httptest.NewRequest("GET", "/api/config", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	body := string(gunzip(t, rec.Body.Bytes()))
	if !strings.Contains(body, `"ok":true`) {
		t.Errorf("decoded body = %q, want the JSON response", body)
	}
}

// TestGzipHandlerLeavesIdentityAndNotModifiedAlone covers the cases where
// compressing would be wrong or pointless.
func TestGzipHandlerLeavesIdentityAndNotModifiedAlone(t *testing.T) {
	body := strings.Repeat("plain text ", 100)
	h := gzipHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		if r.URL.Path == "/cached" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(body))
	}))

	// No Accept-Encoding: identity.
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("identity Content-Encoding = %q, want empty", got)
	}
	if rec.Body.String() != body {
		t.Errorf("identity body was altered")
	}

	// 304: no body encoding.
	req = httptest.NewRequest("GET", "/cached", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("304 Content-Encoding = %q, want empty", got)
	}
}
