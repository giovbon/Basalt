package web

import (
	"net/http/httptest"
	"testing"
)

func TestParsePaginationParamsClampsLimit(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/notes?limit=100000&offset=3", nil)

	limit, offset := ParsePaginationParams(r)

	if limit == nil || *limit != MaxPageSize {
		t.Fatalf("limit = %v, want %d", limit, MaxPageSize)
	}
	if offset != 3 {
		t.Errorf("offset = %d, want 3", offset)
	}
}

func TestParsePaginationParamsRejectsNegatives(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/notes?limit=-1&offset=-5", nil)

	limit, offset := ParsePaginationParams(r)

	if limit != nil {
		t.Errorf("limit = %v, want nil", limit)
	}
	if offset != 0 {
		t.Errorf("offset = %d, want 0", offset)
	}
}
