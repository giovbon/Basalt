package web

import (
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/search"
	"notediscovery/internal/vault"
)

type TagsSearchHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewTagsSearchHandler(cfg *config.Config, v *vault.Vault) *TagsSearchHandler {
	return &TagsSearchHandler{
		cfg:   cfg,
		vault: v,
	}
}

func (h *TagsSearchHandler) GetAllTags(w http.ResponseWriter, r *http.Request) {
	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load tags")
		return
	}

	tagCounts := make(map[string]int)
	for _, n := range notes {
		for _, tag := range n.Tags {
			tagCounts[tag]++
		}
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"tags": tagCounts,
	})
}

type TagNoteItem struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Folder   string   `json:"folder"`
	Modified string   `json:"modified"`
	Size     int64    `json:"size"`
	Tags     []string `json:"tags"`
}

type GetTagResponse struct {
	Tag        string          `json:"tag"`
	Count      int             `json:"count"`
	Notes      []TagNoteItem   `json:"notes"`
	Pagination *PaginationInfo `json:"pagination,omitempty"`
}

func (h *TagsSearchHandler) GetNotesByTag(w http.ResponseWriter, r *http.Request) {
	tagName := r.PathValue("tag")
	tagLower := strings.ToLower(tagName)

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load tags")
		return
	}

	var matched []TagNoteItem
	for _, n := range notes {
		hasTag := false
		for _, t := range n.Tags {
			if strings.ToLower(t) == tagLower {
				hasTag = true
				break
			}
		}
		if hasTag {
			matched = append(matched, TagNoteItem{
				Name:     n.Name,
				Path:     n.Path,
				Folder:   n.Folder,
				Modified: n.Modified,
				Size:     n.Size,
				Tags:     n.Tags,
			})
		}
	}

	// Python: sorted by path.lower()
	sort.Slice(matched, func(i, j int) bool {
		return strings.ToLower(matched[i].Path) < strings.ToLower(matched[j].Path)
	})

	limit, offset := ParsePaginationParams(r)
	paginated := Paginate(matched, limit, offset)

	if paginated.Items == nil {
		paginated.Items = []TagNoteItem{}
	}

	resp := GetTagResponse{
		Tag:        tagName,
		Count:      len(matched),
		Notes:      paginated.Items,
		Pagination: paginated.Pagination,
	}

	RespondJSON(w, http.StatusOK, resp)
}

type SearchResponse struct {
	Results    []search.SearchResult `json:"results"`
	Query      string                `json:"query"`
	Message    string                `json:"message,omitempty"`
	Pagination *PaginationInfo       `json:"pagination,omitempty"`
}

func (h *TagsSearchHandler) SearchNotes(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Search.Enabled {
		RespondError(w, http.StatusForbidden, "Search is disabled")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   "",
			Message: "No search term provided",
		})
		return
	}

	if len([]rune(query)) < 2 {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   query,
		})
		return
	}

	foldedQuery := search.Fold(query)
	if foldedQuery == "" {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   query,
		})
		return
	}

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to perform search")
		return
	}

	// Python searches candidates sorted by MTime descending
	sort.Slice(notes, func(i, j int) bool {
		return notes[i].MTime > notes[j].MTime
	})

	var results []search.SearchResult
	for _, n := range notes {
		if n.Type != "note" {
			continue
		}
		content, err := h.vault.GetNoteContent(n.Path)
		if err != nil {
			continue
		}

		spans := search.FoldedMatchSpans(content, foldedQuery, 3)
		if len(spans) == 0 {
			continue
		}

		var matches []search.SearchMatch
		for _, sp := range spans {
			lineNum, snippet := search.ExtractSnippet(content, sp)
			matches = append(matches, search.SearchMatch{
				LineNumber: lineNum,
				Context:    snippet,
			})
		}

		folder := filepath.Dir(n.Path)
		if folder == "." {
			folder = ""
		}

		results = append(results, search.SearchResult{
			Name:    n.Name,
			Path:    n.Path,
			Folder:  folder,
			Matches: matches,
		})
	}

	limit, offset := ParsePaginationParams(r)
	paginated := Paginate(results, limit, offset)

	resp := SearchResponse{
		Results:    paginated.Items,
		Query:      query,
		Pagination: paginated.Pagination,
	}

	RespondJSON(w, http.StatusOK, resp)
}
