package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
	"notediscovery/internal/vault"
)

func newTestRouter(t *testing.T, allowedOrigins []string, authEnabled bool) *Server {
	t.Helper()
	cfg := &config.Config{
		App: config.AppConfig{
			Name:    "Basalt",
			Version: "1.0.0",
		},
		Server: config.ServerConfig{
			AllowedOrigins: allowedOrigins,
		},
		Authentication: config.AuthenticationConfig{
			Enabled: authEnabled,
		},
	}
	v := vault.New(t.TempDir())
	sess := session.NewManager("test-secret", "", "", 3600, authEnabled)
	return NewServer(cfg, v, sess, fstest.MapFS{})
}

func TestCORSPresentsVaryOrigin(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Origin") {
		t.Errorf("Vary = %q, want it to contain Origin", got)
	}
}

func TestCORSWildcard(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Error("Access-Control-Allow-Credentials should not be set for wildcard origin")
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("Access-Control-Allow-Methods is missing")
	}
}

func TestCORSExactOrigin(t *testing.T) {
	s := newTestRouter(t, []string{"https://app.example"}, false)

	// Allowed origin is reflected and credentials are allowed.
	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://app.example")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Errorf("Access-Control-Allow-Origin = %q, want reflected origin", got)
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Error("Access-Control-Allow-Credentials = missing, want true")
	}

	// Disallowed origin gets no Access-Control-Allow-Origin.
	req2 := httptest.NewRequest("GET", "/health", nil)
	req2.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	s.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec2.Code)
	}
	if rec2.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("Access-Control-Allow-Origin = non-empty, want empty for disallowed origin")
	}
}

func TestSecurityHeaders(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Errorf("X-Frame-Options = %q, want SAMEORIGIN", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
		t.Errorf("Referrer-Policy = %q, want strict-origin-when-cross-origin", got)
	}
}

func TestHealthPublicWithAuthEnabled(t *testing.T) {
	for _, path := range []string{"/health", "/api/health"} {
		s := newTestRouter(t, []string{"*"}, true)

		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
		}
	}
}

func TestProtectedAPIReturns401WithoutSession(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, true)

	req := httptest.NewRequest("GET", "/api/notes", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
