package web

import (
	"compress/gzip"
	"net/http"
	"strings"
)

// compressiblePrefixes lists response Content-Types whose bodies benefit from
// gzip. Images, fonts and media are already compressed and are excluded.
var compressiblePrefixes = []string{
	"text/",
	"application/javascript",
	"application/json",
	"application/manifest+json",
	"application/xml",
	"image/svg+xml",
}

func isCompressibleContentType(ct string) bool {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	ct = strings.TrimSpace(ct)
	for _, p := range compressiblePrefixes {
		if strings.HasPrefix(ct, p) {
			return true
		}
	}
	return false
}

// gzipHandler compresses text responses when the client advertises gzip
// support. Wrapping the outermost handler covers the SPA shell, static
// assets (app.js, index.html, CSS, vendor libs) and JSON API responses
// alike. Level is the stdlib default (6): a good speed/size trade-off.
// addVary appends token to the response's Vary header, skipping duplicates.
// Multiple values are merged into a single comma-separated header so callers
// that use Header().Get("Vary") still observe the complete list.
func addVary(w http.ResponseWriter, token string) {
	existing := w.Header().Values("Vary")
	for _, value := range existing {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return
			}
		}
	}
	if len(existing) == 0 {
		w.Header().Set("Vary", token)
		return
	}
	w.Header().Set("Vary", strings.Join(append(existing, token), ", "))
}

func gzipHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addVary(w, "Accept-Encoding")

		acceptsGzip := r.Method != http.MethodHead &&
			strings.Contains(strings.ToLower(r.Header.Get("Accept-Encoding")), "gzip")
		if !acceptsGzip {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz       *gzip.Writer
	wroteHdr bool
	compress bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHdr {
		return
	}
	w.wroteHdr = true

	// Only a successful full response carries a body worth compressing.
	// 204/304/redirect responses must not declare Content-Encoding.
	if status == http.StatusOK && isCompressibleContentType(w.Header().Get("Content-Type")) {
		// The body will differ from the advertised uncompressed size.
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Encoding", "gzip")
		w.compress = true
		w.gz = gzip.NewWriter(w.ResponseWriter)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHdr {
		// Mirror net/http's content sniffing so the compression decision
		// sees the same Content-Type the client would get uncompressed.
		if len(p) > 0 && w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", http.DetectContentType(p))
		}
		w.WriteHeader(http.StatusOK)
	}
	if w.compress {
		return w.gz.Write(p)
	}
	return w.ResponseWriter.Write(p)
}

func (w *gzipResponseWriter) close() {
	if w.gz != nil {
		_ = w.gz.Close()
	}
}
