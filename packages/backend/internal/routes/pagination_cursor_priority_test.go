package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Mixed pagination params: a request that echoes the response's next_cursor
// back while still spelling its page size as legacy `per_page` previously took
// the legacy branch and silently IGNORED the cursor — the client walked page 1
// forever while every response kept advertising next_cursor. The cursor must
// always win, and the per_page spelling must still set the page size (cursors
// encode offsets, so a silent default-limit switch would skew the walk).
func TestParsePagination_CursorWinsOverLegacyParams(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/repos/a/b/bookmarks?per_page=100&cursor=100", nil)
	cursor, limit, err := parsePagination(req)
	require.NoError(t, err)
	assert.Equal(t, "100", cursor, "the echoed cursor must be honored, not silently dropped")
	assert.Equal(t, 100, limit, "per_page must still set the page size in cursor mode")

	req = httptest.NewRequest(http.MethodGet, "/api/repos/a/b/bookmarks?page=2&cursor=100", nil)
	cursor, limit, err = parsePagination(req)
	require.NoError(t, err)
	assert.Equal(t, "100", cursor)
	assert.Equal(t, 30, limit, "no size spelling → default limit")

	// Pure legacy stays legacy.
	req = httptest.NewRequest(http.MethodGet, "/api/repos/a/b/bookmarks?page=2&per_page=100", nil)
	cursor, limit, err = parsePagination(req)
	require.NoError(t, err)
	assert.Equal(t, "100", cursor, "legacy page=2 translates to offset cursor 100")
	assert.Equal(t, 100, limit)
}
