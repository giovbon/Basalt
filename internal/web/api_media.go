package web

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

type MediaHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewMediaHandler(cfg *config.Config, v *vault.Vault) *MediaHandler {
	return &MediaHandler{
		cfg:   cfg,
		vault: v,
	}
}

func (h *MediaHandler) GetMedia(w http.ResponseWriter, r *http.Request) {
	mediaPath := r.PathValue("path")
	fullPath := h.vault.FullPath(mediaPath)

	if !h.vault.ValidatePathSecurity(fullPath) {
		RespondError(w, http.StatusForbidden, "Access denied")
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		RespondError(w, http.StatusNotFound, "File not found")
		return
	}

	ext := strings.ToLower(filepath.Ext(fullPath))
	allowed := vault.AllMediaExtensions()
	if _, ok := allowed[ext]; !ok {
		RespondError(w, http.StatusBadRequest, "Not an allowed media file")
		return
	}

	http.ServeFile(w, r, fullPath)
}

var allowedMIMETypes = map[string]string{
	// Images
	"image/jpeg": "image",
	"image/jpg":  "image",
	"image/png":  "image",
	"image/gif":  "image",
	"image/webp": "image",
	// Audio
	"audio/mpeg":  "audio",
	"audio/mp3":   "audio",
	"audio/wav":   "audio",
	"audio/wave":  "audio",
	"audio/x-wav": "audio",
	"audio/ogg":   "audio",
	"audio/m4a":   "audio",
	"audio/x-m4a": "audio",
	"audio/mp4":   "audio",
	// Video
	"video/mp4":                "video",
	"video/webm":               "video",
	"video/quicktime":          "video",
	"video/x-msvideo":          "video",
	// Document
	"application/pdf":          "document",
	"application/x-pdf":        "document",
	"application/octet-stream": "binary",
}

func (h *MediaHandler) UploadMedia(w http.ResponseWriter, r *http.Request) {
	// Parse multipart up to 128 MB in memory
	if err := r.ParseMultipartForm(128 * 1024 * 1024); err != nil {
		RespondError(w, http.StatusBadRequest, "Failed to parse form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		RespondError(w, http.StatusBadRequest, "File is required")
		return
	}
	defer file.Close()

	notePath := r.FormValue("note_path")

	fileData, err := io.ReadAll(file)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Failed to read uploaded file")
		return
	}

	contentType := strings.ToLower(header.Header.Get("Content-Type"))
	if idx := strings.Index(contentType, ";"); idx != -1 {
		contentType = contentType[:idx]
	}
	contentType = strings.TrimSpace(contentType)

	mediaCategory, ok := allowedMIMETypes[contentType]
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowedExts := vault.AllMediaExtensions()

	if !ok {
		// Fallback checking extension
		if _, hasExt := allowedExts[ext]; !hasExt {
			RespondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid file type. Allowed: images, audio (mp3), video (mp4), PDF. Got: %s", contentType))
			return
		}
		mediaCategory = vault.GetMediaType(header.Filename)
	}

	var maxSize int64
	switch mediaCategory {
	case "image":
		maxSize = h.cfg.UploadMaxImage
	case "audio":
		maxSize = h.cfg.UploadMaxAudio
	case "video":
		maxSize = h.cfg.UploadMaxVideo
	case "document":
		maxSize = h.cfg.UploadMaxPdf
	default:
		maxSize = h.cfg.UploadMaxImage
	}

	if int64(len(fileData)) > maxSize {
		RespondError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File size exceeds maximum allowed of %dMB", maxSize/(1024*1024)))
		return
	}

	savedPath, err := h.vault.SaveUploadedImage(notePath, header.Filename, fileData)
	if err != nil || savedPath == "" {
		RespondError(w, http.StatusInternalServerError, "Failed to save file")
		return
	}

	extType := vault.GetMediaType(savedPath)
	if extType == "" {
		extType = mediaCategory
	}

	var markdownLink string
	cleanFilename := filepath.Base(savedPath)
	if extType == "image" {
		markdownLink = fmt.Sprintf("![%s](%s)", cleanFilename, savedPath)
	} else {
		markdownLink = fmt.Sprintf("[%s](%s)", cleanFilename, savedPath)
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success":       true,
		"path":          savedPath,
		"filename":      cleanFilename,
		"markdown_link": markdownLink,
		"media_type":    extType,
	})
}

func (h *MediaHandler) MoveMedia(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.OldPath == "" || payload.NewPath == "" {
		RespondError(w, http.StatusBadRequest, "Both oldPath and newPath required")
		return
	}

	success, errMsg := h.vault.MoveNote(payload.OldPath, payload.NewPath)
	if !success {
		status := http.StatusInternalServerError
		if strings.Contains(errMsg, "Source note does not exist") {
			status = http.StatusNotFound
		} else if strings.Contains(errMsg, "already exists at") {
			status = http.StatusConflict
		} else if strings.Contains(errMsg, "Invalid") {
			status = http.StatusBadRequest
		}
		RespondError(w, status, errMsg)
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"oldPath": payload.OldPath,
		"newPath": payload.NewPath,
		"message": "Media moved successfully",
	})
}
