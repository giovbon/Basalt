package web

import (
	"reflect"
	"testing"
)

func ptrInt(v int) *int { return &v }

func TestPaginate(t *testing.T) {
	items := []string{"a", "b", "c", "d", "e"}

	tests := []struct {
		name        string
		items       []string
		limit       *int
		offset      int
		wantItems   []string
		wantNilPage bool
		wantLimit   *int
		wantOffset  int
		wantTotal   int
		wantHasMore bool
	}{
		{
			name:        "nil limit returns everything with no pagination info",
			items:       items,
			limit:       nil,
			offset:      0,
			wantItems:   items,
			wantNilPage: true,
		},
		{
			name:        "offset beyond total clamps and returns empty page",
			items:       items,
			limit:       ptrInt(10),
			offset:      100,
			wantItems:   []string{},
			wantOffset:  5,
			wantTotal:   5,
			wantHasMore: false,
		},
		{
			name:        "limit zero returns empty page but still reports total",
			items:       items,
			limit:       ptrInt(0),
			offset:      0,
			wantItems:   []string{},
			wantLimit:   ptrInt(0),
			wantOffset:  0,
			wantTotal:   5,
			wantHasMore: true,
		},
		{
			name:        "first page",
			items:       items,
			limit:       ptrInt(2),
			offset:      0,
			wantItems:   []string{"a", "b"},
			wantLimit:   ptrInt(2),
			wantOffset:  0,
			wantTotal:   5,
			wantHasMore: true,
		},
		{
			name:        "middle page",
			items:       items,
			limit:       ptrInt(2),
			offset:      2,
			wantItems:   []string{"c", "d"},
			wantLimit:   ptrInt(2),
			wantOffset:  2,
			wantTotal:   5,
			wantHasMore: true,
		},
		{
			name:        "last page",
			items:       items,
			limit:       ptrInt(2),
			offset:      4,
			wantItems:   []string{"e"},
			wantLimit:   ptrInt(2),
			wantOffset:  4,
			wantTotal:   5,
			wantHasMore: false,
		},
		{
			name:        "limit past end returns remainder",
			items:       items,
			limit:       ptrInt(100),
			offset:      3,
			wantItems:   []string{"d", "e"},
			wantLimit:   ptrInt(100),
			wantOffset:  3,
			wantTotal:   5,
			wantHasMore: false,
		},
		{
			name:        "negative limit clamps to zero",
			items:       items,
			limit:       ptrInt(-5),
			offset:      0,
			wantItems:   []string{},
			wantLimit:   ptrInt(0),
			wantOffset:  0,
			wantTotal:   5,
			wantHasMore: true,
		},
		{
			name:        "negative offset clamps to zero",
			items:       items,
			limit:       ptrInt(2),
			offset:      -3,
			wantItems:   []string{"a", "b"},
			wantLimit:   ptrInt(2),
			wantOffset:  0,
			wantTotal:   5,
			wantHasMore: true,
		},
		{
			name:        "empty slice",
			items:       []string{},
			limit:       ptrInt(2),
			offset:      0,
			wantItems:   []string{},
			wantLimit:   ptrInt(2),
			wantOffset:  0,
			wantTotal:   0,
			wantHasMore: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Paginate(tt.items, tt.limit, tt.offset)

			if !reflect.DeepEqual(got.Items, tt.wantItems) {
				t.Errorf("Items = %v, want %v", got.Items, tt.wantItems)
			}

			if tt.wantNilPage {
				if got.Pagination != nil {
					t.Error("Pagination = non-nil, want nil")
				}
				return
			}

			if got.Pagination == nil {
				t.Fatal("Pagination = nil, want non-nil")
			}
			if got.Pagination.Total != tt.wantTotal {
				t.Errorf("Total = %d, want %d", got.Pagination.Total, tt.wantTotal)
			}
			if got.Pagination.Offset != tt.wantOffset {
				t.Errorf("Offset = %d, want %d", got.Pagination.Offset, tt.wantOffset)
			}
			if got.Pagination.HasMore != tt.wantHasMore {
				t.Errorf("HasMore = %v, want %v", got.Pagination.HasMore, tt.wantHasMore)
			}
			if tt.wantLimit != nil {
				if got.Pagination.Limit == nil || *got.Pagination.Limit != *tt.wantLimit {
					t.Errorf("Limit = %v, want %v", got.Pagination.Limit, tt.wantLimit)
				}
			}
		})
	}
}

// MaxInt used to make offset+limit overflow to MinInt and panic in the slice
// expression. The limit must be clamped before any arithmetic.
func TestPaginateClampsOverflowingLimit(t *testing.T) {
	items := []string{"a", "b", "c"}
	maxInt := int(^uint(0) >> 1)

	got := Paginate(items, ptrInt(maxInt), 1)

	if !reflect.DeepEqual(got.Items, []string{"b", "c"}) {
		t.Errorf("Items = %v, want [b c]", got.Items)
	}
	if got.Pagination == nil {
		t.Fatal("Pagination = nil")
	}
	if got.Pagination.Limit == nil || *got.Pagination.Limit != MaxPageSize {
		t.Errorf("Limit = %v, want %d", got.Pagination.Limit, MaxPageSize)
	}
	if got.Pagination.HasMore {
		t.Error("HasMore = true, want false")
	}
}

func TestPageWindowClampsOverflowingLimit(t *testing.T) {
	maxInt := int(^uint(0) >> 1)

	start, end := pageWindow(ptrInt(maxInt), 5)
	if start != 5 || end != 5+MaxPageSize {
		t.Errorf("pageWindow = [%d,%d), want [5,%d)", start, end, 5+MaxPageSize)
	}

	// An offset near MaxInt must saturate instead of wrapping negative.
	start, end = pageWindow(ptrInt(10), maxInt-5)
	if start != maxInt-5 || end != maxInt {
		t.Errorf("pageWindow = [%d,%d), want [%d,%d)", start, end, maxInt-5, maxInt)
	}
}
