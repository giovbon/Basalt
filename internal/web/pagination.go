package web

import "math"

// MaxPageSize bounds the number of items a single request may ask for. The
// previous implementation accepted any non-negative limit, which let a client
// request an effectively unlimited (and unbounded cost) page.
const MaxPageSize = 1000

type PaginationInfo struct {
	Limit   *int `json:"limit"`
	Offset  int  `json:"offset"`
	Total   int  `json:"total"`
	HasMore bool `json:"has_more"`
}

type PaginatedList[T any] struct {
	Items      []T
	Pagination *PaginationInfo
}

func clampLimit(lim int) int {
	if lim < 0 {
		return 0
	}
	if lim > MaxPageSize {
		return MaxPageSize
	}
	return lim
}

// Paginate applies limit and offset slicing with Python-identical semantics.
func Paginate[T any](items []T, limit *int, offset int) PaginatedList[T] {
	total := len(items)
	if limit == nil {
		return PaginatedList[T]{
			Items:      items,
			Pagination: nil,
		}
	}

	lim := clampLimit(*limit)
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}

	// Compute the end with a subtraction instead of offset+lim: summing two
	// caller-controlled ints can overflow into a negative index and panic.
	end := total
	if lim < total-offset {
		end = offset + lim
	}

	hasMore := end < total
	return PaginatedList[T]{
		Items: items[offset:end],
		Pagination: &PaginationInfo{
			Limit:   &lim,
			Offset:  offset,
			Total:   total,
			HasMore: hasMore,
		},
	}
}

// pageWindow returns the [start, end) range of a paginated request without
// doing arithmetic that can overflow. When limit is nil, end is math.MaxInt so
// callers can iterate the whole collection.
func pageWindow(limit *int, offset int) (start, end int) {
	if offset < 0 {
		offset = 0
	}
	if limit == nil {
		return offset, math.MaxInt
	}
	lim := clampLimit(*limit)
	if lim > math.MaxInt-offset {
		return offset, math.MaxInt
	}
	return offset, offset + lim
}
