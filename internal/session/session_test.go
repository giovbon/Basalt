package session

import (
	"net/http/httptest"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func hashPassword(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	return string(hash)
}

func TestDisabledManagerAlwaysAuthenticated(t *testing.T) {
	m := NewManager("secret", "", "", 3600, false)
	if m.Enabled() {
		t.Error("Enabled() = true, want false")
	}

	for _, path := range []string{"/", "/api/notes", "/health"} {
		req := httptest.NewRequest("GET", path, nil)
		if !m.IsAuthenticated(req) {
			t.Errorf("IsAuthenticated(%s) = false, want true when disabled", path)
		}
	}
}

func TestAPIKeyAuthentication(t *testing.T) {
	m := NewManager("secret", "", "my-api-key", 3600, true)

	bearerReq := httptest.NewRequest("GET", "/", nil)
	bearerReq.Header.Set("Authorization", "Bearer my-api-key")
	if !m.CheckAPIKey(bearerReq) {
		t.Error("CheckAPIKey rejected valid Bearer token")
	}
	if !m.IsAuthenticated(bearerReq) {
		t.Error("IsAuthenticated rejected valid Bearer token")
	}

	xKeyReq := httptest.NewRequest("GET", "/", nil)
	xKeyReq.Header.Set("X-API-Key", "my-api-key")
	if !m.CheckAPIKey(xKeyReq) {
		t.Error("CheckAPIKey rejected valid X-API-Key")
	}
	if !m.IsAuthenticated(xKeyReq) {
		t.Error("IsAuthenticated rejected valid X-API-Key")
	}

	wrongBearer := httptest.NewRequest("GET", "/", nil)
	wrongBearer.Header.Set("Authorization", "Bearer wrong-key")
	if m.CheckAPIKey(wrongBearer) {
		t.Error("CheckAPIKey accepted wrong Bearer token")
	}
	if m.IsAuthenticated(wrongBearer) {
		t.Error("IsAuthenticated accepted wrong Bearer token")
	}

	wrongXKey := httptest.NewRequest("GET", "/", nil)
	wrongXKey.Header.Set("X-API-Key", "wrong-key")
	if m.CheckAPIKey(wrongXKey) {
		t.Error("CheckAPIKey accepted wrong X-API-Key")
	}

	noKey := httptest.NewRequest("GET", "/", nil)
	if m.CheckAPIKey(noKey) || m.IsAuthenticated(noKey) {
		t.Error("request without API key authenticated")
	}

	// No API key configured at all.
	noKeyConfigured := NewManager("secret", "", "", 3600, true)
	if noKeyConfigured.CheckAPIKey(bearerReq) {
		t.Error("CheckAPIKey accepted token with no key configured")
	}
}

func TestVerifyPassword(t *testing.T) {
	hash := hashPassword(t, "secret")
	m := NewManager("secret", hash, "", 3600, true)

	if !m.VerifyPassword("secret") {
		t.Error("VerifyPassword rejected correct password")
	}
	if m.VerifyPassword("Secret") {
		t.Error("VerifyPassword accepted wrong-cased password")
	}
	if m.VerifyPassword("wrong") {
		t.Error("VerifyPassword accepted wrong password")
	}

	noHash := NewManager("secret", "", "", 3600, true)
	if noHash.VerifyPassword("anything") {
		t.Error("VerifyPassword accepted password with no hash configured")
	}
}

func TestCreateSessionCookieSecureFlag(t *testing.T) {
	m := NewManager("secret", "", "", 3600, true)

	cookie := m.CreateSessionCookie(false)
	if cookie.Name != CookieName {
		t.Errorf("cookie name = %q, want %q", cookie.Name, CookieName)
	}
	if cookie.Path != "/" {
		t.Errorf("cookie path = %q, want /", cookie.Path)
	}
	if !cookie.HttpOnly {
		t.Error("cookie should be HttpOnly")
	}
	if cookie.Secure {
		t.Error("cookie created with secure=false should not be Secure")
	}
	if cookie.MaxAge <= 0 {
		t.Errorf("cookie MaxAge = %d, want positive", cookie.MaxAge)
	}

	secureCookie := m.CreateSessionCookie(true)
	if !secureCookie.Secure {
		t.Error("cookie created with secure=true should be Secure")
	}

	// Attach the cookie to an httptest request and verify authentication.
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(cookie)
	if !m.IsAuthenticated(req) {
		t.Error("IsAuthenticated rejected a valid session cookie")
	}
}

func TestTamperedCookieRejected(t *testing.T) {
	m := NewManager("secret", "", "", 3600, true)

	cookie := m.CreateSessionCookie(false)
	cookie.Value = cookie.Value + "tampered"
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(cookie)
	if m.IsAuthenticated(req) {
		t.Error("IsAuthenticated accepted a tampered cookie")
	}

	malformed := m.CreateSessionCookie(false)
	malformed.Value = "not.a.valid.cookie"
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.AddCookie(malformed)
	if m.IsAuthenticated(req2) {
		t.Error("IsAuthenticated accepted a malformed cookie")
	}

	emptyCookie := m.CreateSessionCookie(false)
	emptyCookie.Value = ""
	req3 := httptest.NewRequest("GET", "/", nil)
	req3.AddCookie(emptyCookie)
	if m.IsAuthenticated(req3) {
		t.Error("IsAuthenticated accepted an empty cookie value")
	}
}

func TestClearSessionCookie(t *testing.T) {
	m := NewManager("secret", "", "", 3600, true)

	for _, secure := range []bool{false, true} {
		c := m.ClearSessionCookie(secure)
		if c.Name != CookieName {
			t.Errorf("secure=%v: cookie name = %q, want %q", secure, c.Name, CookieName)
		}
		if c.Path != "/" {
			t.Errorf("secure=%v: cookie path = %q, want /", secure, c.Path)
		}
		if !c.HttpOnly {
			t.Errorf("secure=%v: cookie should be HttpOnly", secure)
		}
		if c.MaxAge >= 0 {
			t.Errorf("secure=%v: MaxAge = %d, want negative (expired)", secure, c.MaxAge)
		}
		if c.Secure != secure {
			t.Errorf("secure=%v: cookie.Secure = %v", secure, c.Secure)
		}
	}
}
