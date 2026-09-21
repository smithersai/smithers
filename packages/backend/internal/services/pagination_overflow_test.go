package services

import (
	"math"
	"testing"
)

// normalizePage narrows (page-1)*perPage to int32 for the SQL OFFSET. An
// unbounded page overflows int32 to a negative offset and 500s the query, so
// normalizePage must cap page to keep the offset non-negative and in range.
func TestNormalizePagePreventsInt32OffsetOverflow(t *testing.T) {
	for _, page := range []int{2_000_000_000, math.MaxInt32} {
		for _, perPage := range []int{1, 30, 100, 1000} {
			_, pageOffset, _, _ := normalizePage(page, perPage)
			if pageOffset < 0 {
				t.Fatalf("page=%d perPage=%d: pageOffset=%d is negative (overflow)", page, perPage, pageOffset)
			}
		}
	}

	// Normal pages are untouched.
	for _, page := range []int{1, 2, 50} {
		pageSize, pageOffset, resolvedPage, resolvedPerPage := normalizePage(page, 100)
		if resolvedPage != page {
			t.Fatalf("normal page altered: got resolvedPage=%d want %d", resolvedPage, page)
		}
		if resolvedPerPage != 100 || pageSize != 100 {
			t.Fatalf("perPage altered: pageSize=%d resolvedPerPage=%d", pageSize, resolvedPerPage)
		}
		if want := int32((page - 1) * 100); pageOffset != want {
			t.Fatalf("page=%d: pageOffset=%d want %d", page, pageOffset, want)
		}
	}
}

// normalizePagination is followed by callers computing int32((page-1)*perPage);
// it must cap page so that offset cannot overflow int32 to a negative value.
func TestNormalizePaginationPreventsInt32OffsetOverflow(t *testing.T) {
	for _, page := range []int{2_000_000_000, math.MaxInt32} {
		for _, perPage := range []int{1, 30, 100, 1000} {
			resolvedPage, resolvedPerPage := normalizePagination(page, perPage)
			offset := (resolvedPage - 1) * resolvedPerPage
			if offset < 0 || offset > math.MaxInt32 {
				t.Fatalf("page=%d perPage=%d: offset %d outside int32 range", page, perPage, offset)
			}
			if int32(offset) < 0 {
				t.Fatalf("page=%d perPage=%d: int32(offset)=%d is negative (overflow)", page, perPage, int32(offset))
			}
		}
	}

	// Normal pages are untouched.
	for _, page := range []int{1, 2, 50} {
		if got, perPage := normalizePagination(page, 30); got != page || perPage != 30 {
			t.Fatalf("normal pagination altered: page=%d perPage=%d", got, perPage)
		}
	}
}
