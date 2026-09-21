package routes

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPagination_Cov_IDCursorEdges(t *testing.T) {
	t.Parallel()

	encoded := encodeIDCursor(12345)
	assert.NotEmpty(t, encoded)
	assert.Equal(t, int64(12345), decodeIDCursor(encoded))
	assert.Empty(t, encodeIDCursor(0))
	assert.Empty(t, encodeIDCursor(-1))
	assert.Equal(t, int64(5), decodeIDCursor("5"))
	assert.Zero(t, decodeIDCursor("-55"))
	assert.Zero(t, decodeIDCursor("%%%"))
}

func TestPagination_Cov_PaginationURLModes(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest("GET", "/api/items?cursor=old&limit=1&page=9&per_page=9&state=open", nil)
	assert.Equal(t, "/api/items?limit=25&state=open", paginationURL(req, 25, struct{}{}))
	assert.Equal(t, "/api/items?cursor=abc&limit=25&state=open", paginationURL(req, 25, "abc"))
	assert.Equal(t, "/api/items?page=3&per_page=15&state=open", paginationURL(req, 3, 15))
}

func TestPagination_Cov_SetLegacyPaginationHeadersEdges(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest("GET", "/api/items?filter=active", nil)
	rec := httptest.NewRecorder()
	setLegacyPaginationHeaders(rec, req, 2, 0, 75)
	link := rec.Header().Get("Link")
	assert.Contains(t, link, `rel="first"`)
	assert.Contains(t, link, `rel="last"`)
	assert.Contains(t, link, `rel="prev"`)
	assert.Contains(t, link, `rel="next"`)
	assert.Contains(t, link, "per_page=30")

	lastRec := httptest.NewRecorder()
	setLegacyPaginationHeaders(lastRec, req, 3, 30, 75)
	lastLink := lastRec.Header().Get("Link")
	assert.Contains(t, lastLink, `rel="prev"`)
	assert.NotContains(t, lastLink, `rel="next"`)
}
