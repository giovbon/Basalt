package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

type FoldersHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewFoldersHandler(cfg *config.Config, v *vault.Vault) *FoldersHandler {
	return &FoldersHandler{
		cfg:   cfg,
		vault: v,
	}
}

type CreateFolderPayload struct {
	Path string `json:"path"`
}

func (h *FoldersHandler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	var payload CreateFolderPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	folderPath := strings.TrimSpace(payload.Path)
	if folderPath == "" {
		RespondError(w, http.StatusBadRequest, "Folder path required")
		return
	}

	conflict := h.vault.FolderNameConflict(folderPath)
	if conflict != "" && strings.ToLower(vault.NormalizedRelPath(conflict)) != strings.ToLower(vault.NormalizedRelPath(folderPath)) {
		RespondError(w, http.StatusConflict, fmt.Sprintf("A folder already exists at: %s", conflict))
		return
	}

	if !h.vault.CreateFolder(folderPath) {
		RespondError(w, http.StatusInternalServerError, "Failed to create folder")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"path":    folderPath,
		"message": "Folder created successfully",
	})
}

type FolderMovePayload struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

func (h *FoldersHandler) MoveFolder(w http.ResponseWriter, r *http.Request) {
	var payload FolderMovePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.OldPath == "" || payload.NewPath == "" {
		RespondError(w, http.StatusBadRequest, "Both oldPath and newPath required")
		return
	}

	if err := h.vault.MoveFolder(payload.OldPath, payload.NewPath); err != nil {
		RespondError(w, statusForVaultError(err), err.Error())
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"oldPath": payload.OldPath,
		"newPath": payload.NewPath,
		"message": "Folder moved successfully",
	})
}

func (h *FoldersHandler) RenameFolder(w http.ResponseWriter, r *http.Request) {
	var payload FolderMovePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.OldPath == "" || payload.NewPath == "" {
		RespondError(w, http.StatusBadRequest, "Both oldPath and newPath required")
		return
	}

	if err := h.vault.MoveFolder(payload.OldPath, payload.NewPath); err != nil {
		RespondError(w, statusForVaultError(err), err.Error())
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"oldPath": payload.OldPath,
		"newPath": payload.NewPath,
		"message": "Folder renamed successfully",
	})
}

func (h *FoldersHandler) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	folderPath := r.PathValue("path")
	if folderPath == "" {
		RespondError(w, http.StatusBadRequest, "Folder path required")
		return
	}

	if err := h.vault.DeleteFolder(folderPath); err != nil {
		RespondError(w, statusForVaultError(err), err.Error())
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"path":    folderPath,
		"message": "Folder deleted successfully",
	})
}
