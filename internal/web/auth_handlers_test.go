package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"golang.org/x/crypto/bcrypt"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
)

func newTestAuthHandler(t *testing.T) *AuthHandler {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		App: config.AppConfig{
			Name: "Basalt",
		},
		Authentication: config.AuthenticationConfig{
			Enabled: true,
		},
	}
	sess := session.NewManager("test-secret", string(hash), "", 3600, true)
	return NewAuthHandler(cfg, sess, fstest.MapFS{})
}

func postLogin(t *testing.T, h *AuthHandler, remoteAddr string, password string, extra ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/login", strings.NewReader("password="+password))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = remoteAddr
	for _, f := range extra {
		f(req)
	}
	rec := httptest.NewRecorder()
	h.LoginAction(rec, req)
	return rec
}

func findCookie(rec *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestLoginLockoutAfterFiveFailures(t *testing.T) {
	h := newTestAuthHandler(t)
	const remote = "203.0.113.9:1234"

	for i := 0; i < 5; i++ {
		rec := postLogin(t, h, remote, "wrong")
		if rec.Code != http.StatusSeeOther {
			t.Errorf("attempt %d: status = %d, want 303", i+1, rec.Code)
			return
		}
		want := "/login?error=incorrect_password"
		if loc := rec.Header().Get("Location"); loc != want {
			t.Errorf("attempt %d: Location = %q, want %q", i+1, loc, want)
			return
		}
	}

	rec := postLogin(t, h, remote, "wrong")
	if rec.Code != http.StatusSeeOther {
		t.Errorf("6th attempt: status = %d, want 303", rec.Code)
		return
	}
	want := "/login?error=too_many_attempts"
	if loc := rec.Header().Get("Location"); loc != want {
		t.Errorf("6th attempt: Location = %q, want %q", loc, want)
	}
}

func TestLoginSuccessFromFreshIP(t *testing.T) {
	h := newTestAuthHandler(t)

	rec := postLogin(t, h, "203.0.113.10:1234", "secret")
	if rec.Code != http.StatusSeeOther {
		t.Errorf("status = %d, want 303", rec.Code)
		return
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Errorf("Location = %q, want /", loc)
	}

	cookie := findCookie(rec, "session")
	if cookie == nil {
		t.Fatal("no session cookie in Set-Cookie")
	}
	if cookie.Secure {
		t.Error("cookie over plain HTTP should not be Secure")
	}
}

func TestLoginSecureCookieWithForwardedProto(t *testing.T) {
	h := newTestAuthHandler(t)

	rec := postLogin(t, h, "203.0.113.11:1234", "secret",
		func(req *http.Request) {
			req.Header.Set("X-Forwarded-Proto", "https")
		})
	if rec.Code != http.StatusSeeOther {
		t.Errorf("status = %d, want 303", rec.Code)
		return
	}

	cookie := findCookie(rec, "session")
	if cookie == nil {
		t.Fatal("no session cookie in Set-Cookie")
	}
	if !cookie.Secure {
		t.Error("cookie with X-Forwarded-Proto: https should be Secure")
	}
}
