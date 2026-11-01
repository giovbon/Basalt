package web

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

// Paginate applies limit and offset slicing with Python-identical semantics
func Paginate[T any](items []T, limit *int, offset int) PaginatedList[T] {
	total := len(items)
	if limit == nil {
		return PaginatedList[T]{
			Items:      items,
			Pagination: nil,
		}
	}

	lim := *limit
	if lim < 0 {
		lim = 0
	}
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}

	end := offset + lim
	var paginated []T
	if end > total {
		paginated = items[offset:total]
	} else {
		paginated = items[offset:end]
	}

	hasMore := end < total
	return PaginatedList[T]{
		Items: paginated,
		Pagination: &PaginationInfo{
			Limit:   &lim,
			Offset:  offset,
			Total:   total,
			HasMore: hasMore,
		},
	}
}
