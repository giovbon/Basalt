package web

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
)

type AuthHandler struct {
	cfg      *config.Config
	session  *session.Manager
	assetsFS fs.FS
}

func NewAuthHandler(cfg *config.Config, sess *session.Manager, assetsFS fs.FS) *AuthHandler {
	return &AuthHandler{
		cfg:      cfg,
		session:  sess,
		assetsFS: assetsFS,
	}
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

	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/login?error=incorrect_password", http.StatusSeeOther)
		return
	}

	password := r.FormValue("password")
	if !h.session.VerifyPassword(password) {
		http.Redirect(w, r, "/login?error=incorrect_password", http.StatusSeeOther)
		return
	}

	cookie := h.session.CreateSessionCookie()
	http.SetCookie(w, cookie)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (h *AuthHandler) LogoutAction(w http.ResponseWriter, r *http.Request) {
	cookie := h.session.ClearSessionCookie()
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
