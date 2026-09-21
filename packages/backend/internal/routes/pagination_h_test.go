package routes

import (
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPagination_H_URLAssemblyBranches(t *testing.T) {
	assert.Equal(t, "/api/items", paginationURLWithQuery("/api/items", url.Values{}))
	assert.Equal(t, "/api/items?a=1", paginationURLWithQuery("/api/items", url.Values{"a": []string{"1"}}))

	req := httptest.NewRequest("GET", "/api/items", nil)
	assert.Equal(t, "/api/items?limit=25", paginationURL(req, 25, ""))
}
