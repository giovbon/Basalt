package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

type NotesHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewNotesHandler(cfg *config.Config, v *vault.Vault) *NotesHandler {
	return &NotesHandler{
		cfg:   cfg,
		vault: v,
	}
}

type ListNotesResponse struct {
	Notes      []vault.NoteRecord `json:"notes"`
	Folders    []string           `json:"folders"`
	Pagination *PaginationInfo    `json:"pagination,omitempty"`
}

func (h *NotesHandler) ListNotes(w http.ResponseWriter, r *http.Request) {
	notes, folders, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to scan notes", h.cfg.Server.Debug))
		return
	}

	// Always sort notes by path.lower()
	sort.Slice(notes, func(i, j int) bool {
		return strings.ToLower(notes[i].Path) < strings.ToLower(notes[j].Path)
	})

	limit, offset := ParsePaginationParams(r)
	paginated := Paginate(notes, limit, offset)

	if paginated.Items == nil {
		paginated.Items = []vault.NoteRecord{}
	}
	if folders == nil {
		folders = []string{}
	}

	resp := ListNotesResponse{
		Notes:      paginated.Items,
		Folders:    folders,
		Pagination: paginated.Pagination,
	}
	RespondJSON(w, http.StatusOK, resp)
}

type GetNoteResponse struct {
	Path      string               `json:"path"`
	Content   string               `json:"content"`
	Hash      string               `json:"hash"`
	Metadata  vault.NoteMetadata   `json:"metadata"`
	Backlinks []vault.BacklinkItem `json:"backlinks,omitempty"`
}

func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	content, err := h.vault.GetNoteContent(notePath)
	if err != nil {
		if os.IsNotExist(err) {
			RespondError(w, http.StatusNotFound, "Note not found")
			return
		}
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to load note", h.cfg.Server.Debug))
		return
	}

	storedHash := vault.ContentHash(content)
	meta := h.vault.CreateNoteMetadata(notePath)

	resp := GetNoteResponse{
		Path:     notePath,
		Content:  content,
		Hash:     storedHash,
		Metadata: meta,
	}

	if r.URL.Query().Get("include_backlinks") == "true" {
		resp.Backlinks = h.vault.GetBacklinks(notePath)
	}

	RespondJSON(w, http.StatusOK, resp)
}

type SaveNotePayload struct {
	Content  string `json:"content"`
	BaseHash string `json:"base_hash"`
}

type SaveNoteResponse struct {
	Success bool   `json:"success"`
	Path    string `json:"path"`
	Message string `json:"message"`
	Content string `json:"content"`
	Hash    string `json:"hash"`
}

type ConflictHashResponse struct {
	Detail string `json:"detail"`
	Hash   string `json:"hash"`
}

func (h *NotesHandler) SaveNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	// Python quirk: with_suffix('.md') when not ending in .md
	if !strings.HasSuffix(notePath, ".md") {
		notePath = notePath + ".md"
	}

	// Refuse clashes
	conflict := h.vault.NoteNameConflict(notePath)
	if conflict != "" && strings.ToLower(vault.NormalizedRelPath(conflict)) != strings.ToLower(vault.NormalizedRelPath(notePath)) {
		RespondError(w, http.StatusConflict, fmt.Sprintf("A note already exists at: %s", notePath))
		return
	}
	if vault.PathHasHash(notePath) && !h.vault.NoteExistsExact(notePath) {
		RespondError(w, http.StatusBadRequest, "Note name cannot contain '#'")
		return
	}

	var payload SaveNotePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	existingContent, err := h.vault.GetNoteContent(notePath)
	isNewNote := (err != nil)

	// Optimistic concurrency check
	if payload.BaseHash != "" && !isNewNote {
		currentHash := vault.ContentHash(existingContent)
		if currentHash != payload.BaseHash {
			RespondJSON(w, http.StatusConflict, ConflictHashResponse{
				Detail: "Note changed on disk since it was loaded",
				Hash:   currentHash,
			})
			return
		}
	}

	if err := h.vault.SaveNote(notePath, payload.Content); err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to save note")
		return
	}

	msg := "Note saved successfully"
	if isNewNote {
		msg = "Note created successfully"
	}

	RespondJSON(w, http.StatusOK, SaveNoteResponse{
		Success: true,
		Path:    notePath,
		Message: msg,
		Content: payload.Content,
		Hash:    vault.ContentHash(payload.Content),
	})
}

func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	if !h.vault.DeleteNote(notePath) {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"path":    notePath,
		"message": "Note deleted successfully",
	})
}

type ReplacePayload struct {
	Path   string  `json:"path"`
	OldStr *string `json:"old_str"`
	NewStr *string `json:"new_str"`
}

func (h *NotesHandler) ReplaceInNote(w http.ResponseWriter, r *http.Request) {
	var payload ReplacePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.Path == "" {
		RespondError(w, http.StatusBadRequest, "path is required")
		return
	}
	if payload.OldStr == nil || *payload.OldStr == "" {
		RespondError(w, http.StatusBadRequest, "old_str is required")
		return
	}
	if payload.NewStr == nil {
		RespondError(w, http.StatusBadRequest, "new_str is required (use an empty string to delete)")
		return
	}

	content, err := h.vault.GetNoteContent(payload.Path)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	oldStr := *payload.OldStr
	newStr := *payload.NewStr

	occurrences := strings.Count(content, oldStr)
	if occurrences == 0 {
		RespondError(w, http.StatusConflict, "old_str not found in note")
		return
	}
	if occurrences > 1 {
		RespondError(w, http.StatusConflict, fmt.Sprintf("old_str found %d times; include more surrounding text to make it unique", occurrences))
		return
	}

	newContent := strings.Replace(content, oldStr, newStr, 1)
	if err := h.vault.SaveNote(payload.Path, newContent); err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to update note")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"path":    payload.Path,
		"message": "Note updated successfully",
		"hash":    vault.ContentHash(newContent),
	})
}

type MoveNotePayload struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

func (h *NotesHandler) MoveNote(w http.ResponseWriter, r *http.Request) {
	var payload MoveNotePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.OldPath == "" || payload.NewPath == "" {
		RespondError(w, http.StatusBadRequest, "Both oldPath and newPath required")
		return
	}

	// Suffix with .md if missing
	newPath := payload.NewPath
	if !strings.HasSuffix(newPath, ".md") {
		newPath += ".md"
	}

	if vault.PathHasHash(newPath) && !h.vault.NoteExistsExact(newPath) {
		RespondError(w, http.StatusBadRequest, "Note name cannot contain '#'")
		return
	}

	success, errMsg := h.vault.MoveNote(payload.OldPath, newPath)
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
		"newPath": newPath,
		"message": "Note moved successfully",
	})
}
