package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const CookieName = "session"

type SessionData struct {
	Authenticated bool  `json:"authenticated"`
	ExpiresAt     int64 `json:"exp"`
}

type Manager struct {
	secretKey     []byte
	passwordHash  string
	apiKey        string
	sessionMaxAge time.Duration
	enabled       bool
}

func NewManager(secretKey string, passwordHash string, apiKey string, sessionMaxAgeSeconds int, enabled bool) *Manager {
	if secretKey == "" {
		secretKey = "insecure_default_key_change_this"
	}
	maxAge := time.Duration(sessionMaxAgeSeconds) * time.Second
	if maxAge <= 0 {
		maxAge = 7 * 24 * time.Hour
	}
	return &Manager{
		secretKey:     []byte(secretKey),
		passwordHash:  passwordHash,
		apiKey:        strings.TrimSpace(apiKey),
		sessionMaxAge: maxAge,
		enabled:       enabled,
	}
}

func (m *Manager) Enabled() bool {
	return m.enabled
}

// VerifyPassword checks plaintext password against bcrypt hash
func (m *Manager) VerifyPassword(plain string) bool {
	if m.passwordHash == "" {
		return false
	}
	err := bcrypt.CompareHashAndPassword([]byte(m.passwordHash), []byte(plain))
	return err == nil
}

// CheckAPIKey verifies whether provided bearer token or X-API-Key matches
func (m *Manager) CheckAPIKey(r *http.Request) bool {
	if m.apiKey == "" {
		return false
	}

	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if subtle.ConstantTimeCompare([]byte(token), []byte(m.apiKey)) == 1 {
			return true
		}
	}

	if xKey := r.Header.Get("X-API-Key"); xKey != "" {
		if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(xKey)), []byte(m.apiKey)) == 1 {
			return true
		}
	}

	return false
}

// CreateSessionCookie signs and creates the session HTTP cookie
func (m *Manager) CreateSessionCookie() *http.Cookie {
	data := SessionData{
		Authenticated: true,
		ExpiresAt:     time.Now().Add(m.sessionMaxAge).Unix(),
	}
	payload, _ := json.Marshal(data)
	b64Payload := base64.RawURLEncoding.EncodeToString(payload)

	mac := hmac.New(sha256.New, m.secretKey)
	mac.Write([]byte(b64Payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	cookieVal := b64Payload + "." + sig

	return &http.Cookie{
		Name:     CookieName,
		Value:    cookieVal,
		Path:     "/",
		MaxAge:   int(m.sessionMaxAge.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   false,
	}
}

// ClearSessionCookie returns an expired cookie
func (m *Manager) ClearSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   false,
	}
}

// IsAuthenticated verifies session cookie or API key
func (m *Manager) IsAuthenticated(r *http.Request) bool {
	if !m.enabled {
		return true
	}

	if m.CheckAPIKey(r) {
		return true
	}

	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}

	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return false
	}

	b64Payload, sig := parts[0], parts[1]

	mac := hmac.New(sha256.New, m.secretKey)
	mac.Write([]byte(b64Payload))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(sig), []byte(expectedSig)) != 1 {
		return false
	}

	payload, err := base64.RawURLEncoding.DecodeString(b64Payload)
	if err != nil {
		return false
	}

	var data SessionData
	if err := json.Unmarshal(payload, &data); err != nil {
		return false
	}

	if !data.Authenticated || time.Now().Unix() > data.ExpiresAt {
		return false
	}

	return true
}
