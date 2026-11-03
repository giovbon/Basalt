package web

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
)

const (
	maxLoginFailures = 5
	loginWindow      = 15 * time.Minute
	loginBlock       = 15 * time.Minute
)

type loginAttempt struct {
	failures     int
	blockedUntil time.Time
	lastSeen     time.Time
}

type AuthHandler struct {
	cfg      *config.Config
	session  *session.Manager
	assetsFS fs.FS

	mu            sync.Mutex
	loginAttempts map[string]*loginAttempt
}

func NewAuthHandler(cfg *config.Config, sess *session.Manager, assetsFS fs.FS) *AuthHandler {
	return &AuthHandler{
		cfg:           cfg,
		session:       sess,
		assetsFS:      assetsFS,
		loginAttempts: map[string]*loginAttempt{},
	}
}

// clientIP returns the remote host, falling back to RemoteAddr when it is not
// host:port form.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requestIsHTTPS reports whether the request arrived over TLS or via an
// HTTPS reverse proxy (X-Forwarded-Proto).
func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		return false
	}
	firstProto := strings.SplitN(proto, ",", 2)[0]
	return strings.EqualFold(strings.TrimSpace(firstProto), "https")
}

// getLoginAttempt returns the tracked attempt state for the client IP,
// pruning entries that have not been seen within the login window.
func (h *AuthHandler) getLoginAttempt(r *http.Request) *loginAttempt {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	for ip, attempt := range h.loginAttempts {
		if now.Sub(attempt.lastSeen) > time.Hour {
			delete(h.loginAttempts, ip)
		}
	}

	ip := clientIP(r)
	if attempt, ok := h.loginAttempts[ip]; ok {
		if !attempt.blockedUntil.IsZero() && !attempt.blockedUntil.After(now) {
			// The lockout elapsed: start a fresh window.
			attempt.blockedUntil = time.Time{}
			attempt.failures = 0
		}
		// Failures older than the window do not count toward a lockout.
		if attempt.blockedUntil.IsZero() && now.Sub(attempt.lastSeen) > loginWindow {
			attempt.failures = 0
		}
		return attempt
	}
	return &loginAttempt{lastSeen: now}
}

// isLoginBlocked reports whether the client IP is currently blocked from
// further login attempts.
func (h *AuthHandler) isLoginBlocked(r *http.Request) bool {
	attempt := h.getLoginAttempt(r)
	return !attempt.blockedUntil.IsZero() && attempt.blockedUntil.After(time.Now())
}

// recordLoginFailure updates the failure counter and locks the IP out once
// the configured maximum of failures is reached within the window.
func (h *AuthHandler) recordLoginFailure(r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	ip := clientIP(r)
	attempt, ok := h.loginAttempts[ip]
	if !ok {
		attempt = &loginAttempt{lastSeen: now}
		h.loginAttempts[ip] = attempt
	}
	attempt.failures++
	attempt.lastSeen = now
	if attempt.failures >= maxLoginFailures {
		attempt.blockedUntil = now.Add(loginBlock)
		attempt.failures = 0
	}
}

// clearLoginAttempts removes the tracked state after a successful login.
func (h *AuthHandler) clearLoginAttempts(r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.loginAttempts, clientIP(r))
}

func (h *AuthHandler) LoginPageRoute(w http.ResponseWriter, r *http.Request) {
	if !h.session.Enabled() {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	if h.session.IsAuthenticated(r) {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	contentBytes, err := fs.ReadFile(h.assetsFS, "frontend/login.html")
	if err != nil {
		http.Error(w, "login page not found", http.StatusInternalServerError)
		return
	}
	content := string(contentBytes)

	// Inject placeholders
	content = RenderAppNameHTML(content, h.cfg.App.Name)
	content = strings.ReplaceAll(content, "__DEFAULT_THEME__", h.cfg.UI.DefaultTheme)
	// Same server-side translation embedding as the app shell, so the login
	// page no longer needs a synchronous XHR before it renders.
	content = renderPreloadedTranslations(h.assetsFS, content)

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

func (h *AuthHandler) LoginAction(w http.ResponseWriter, r *http.Request) {
	if !h.session.Enabled() {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	if h.isLoginBlocked(r) {
		http.Redirect(w, r, "/login?error=too_many_attempts", http.StatusSeeOther)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/login?error=incorrect_password", http.StatusSeeOther)
		return
	}

	password := r.FormValue("password")
	if !h.session.VerifyPassword(password) {
		h.recordLoginFailure(r)
		http.Redirect(w, r, "/login?error=incorrect_password", http.StatusSeeOther)
		return
	}

	h.clearLoginAttempts(r)

	cookie := h.session.CreateSessionCookie(requestIsHTTPS(r))
	http.SetCookie(w, cookie)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (h *AuthHandler) LogoutAction(w http.ResponseWriter, r *http.Request) {
	cookie := h.session.ClearSessionCookie(requestIsHTTPS(r))
	http.SetCookie(w, cookie)
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (h *AuthHandler) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.session.Enabled() {
			next.ServeHTTP(w, r)
			return
		}

		path := r.URL.Path

		// Public endpoints that bypass authentication
		if path == "/login" ||
			path == "/health" ||
			path == "/api/health" ||
			path == "/manifest.json" ||
			path == "/sw.js" ||
			path == "/api/locales" ||
			strings.HasPrefix(path, "/api/locales/") ||
			strings.HasPrefix(path, "/api/themes/") ||
			strings.HasPrefix(path, "/static/") {
			next.ServeHTTP(w, r)
			return
		}

		if h.session.IsAuthenticated(r) {
			next.ServeHTTP(w, r)
			return
		}

		// Denied
		if strings.HasPrefix(path, "/api/") {
			RespondError(w, http.StatusUnauthorized, "Not authenticated")
			return
		}

		// Page requests redirect to /login
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	})
}
