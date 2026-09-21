package services

import (
	"math"
	"testing"
)

// The four search endpoints narrow (page-1)*perPage to int32 for the SQL OFFSET.
// An unbounded page overflows int32 to a negative offset and 500s the query, so
// normalizeSearchPagination must cap page to keep the offset in int32 range.
func TestNormalizeSearchPaginationPreventsInt32OffsetOverflow(t *testing.T) {
	for _, perPage := range []int{1, 30, 100, 1000} {
		page, resolvedPerPage := normalizeSearchPagination(math.MaxInt32, perPage)
		offset := (page - 1) * resolvedPerPage
		if offset < 0 || offset > math.MaxInt32 {
			t.Fatalf("perPage=%d: offset %d outside int32 range", perPage, offset)
		}
		if int32(offset) < 0 {
			t.Fatalf("perPage=%d: int32(offset)=%d is negative (overflow)", perPage, int32(offset))
		}
	}

	// Normal pages are untouched.
	if page, perPage := normalizeSearchPagination(2, 30); page != 2 || perPage != 30 {
		t.Fatalf("normal pagination altered: page=%d perPage=%d", page, perPage)
	}
}
