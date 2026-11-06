package web

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
)

type ErrorResponse struct {
	Detail string `json:"detail"`
}

func RespondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func RespondError(w http.ResponseWriter, status int, message string) {
	RespondJSON(w, status, ErrorResponse{Detail: message})
}

func SafeErrorMessage(err error, userMessage string, debug bool) string {
	if err == nil {
		return userMessage
	}
	details := fmt.Sprintf("%T: %v", err, err)
	log.Printf("ERROR: %s", details)
	if debug {
		return details
	}
	return userMessage
}

func ParsePaginationParams(r *http.Request) (*int, int) {
	query := r.URL.Query()
	var limit *int
	if limitStr := query.Get("limit"); limitStr != "" {
		if val, err := strconv.Atoi(limitStr); err == nil && val >= 0 {
			if val > MaxPageSize {
				val = MaxPageSize
			}
			limit = &val
		}
	}
	offset := 0
	if offsetStr := query.Get("offset"); offsetStr != "" {
		if val, err := strconv.Atoi(offsetStr); err == nil && val >= 0 {
			offset = val
		}
	}
	return limit, offset
}
