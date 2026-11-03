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
