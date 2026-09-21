package repohostserver

import (
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParsePagination_PerPageMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for perPage := 0; perPage <= 105; perPage++ {
		perPage := perPage
		t.Run("per_page_"+offsetName(perPage), func(t *testing.T) {
			caseCount++
			values := url.Values{"per_page": []string{offsetName(perPage)}}
			got, err := parsePagination(values)
			switch {
			case perPage == 0:
				require.Error(t, err)
				assert.Contains(t, err.Error(), "per_page must be at least 1")
			case perPage > 100:
				require.Error(t, err)
				assert.Contains(t, err.Error(), "per_page must not exceed 100")
			default:
				require.NoError(t, err)
				assert.Equal(t, uint32(1), got.Page)
				assert.Equal(t, uint32(perPage), got.PerPage)
			}
		})
	}

	assert.Equal(t, 106, caseCount)
}

func TestParsePagination_PageMatrix(t *testing.T) {
	t.Parallel()

	for page := 0; page <= 25; page++ {
		page := page
		t.Run("page_"+offsetName(page), func(t *testing.T) {
			values := url.Values{"page": []string{offsetName(page)}}
			got, err := parsePagination(values)
			if page == 0 {
				require.Error(t, err)
				assert.Contains(t, err.Error(), "page must be at least 1")
				return
			}

			require.NoError(t, err)
			assert.Equal(t, uint32(page), got.Page)
			assert.Equal(t, uint32(30), got.PerPage)
		})
	}
}

func TestParsePagination_ExtraCases(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		values      url.Values
		wantPage    uint32
		wantPerPage uint32
		wantError   string
	}{
		{
			name:        "defaults",
			values:      url.Values{},
			wantPage:    1,
			wantPerPage: 30,
		},
		{
			name:        "limit_alias",
			values:      url.Values{"limit": []string{"5"}},
			wantPage:    1,
			wantPerPage: 5,
		},
		{
			name:        "per_page_wins_over_limit",
			values:      url.Values{"per_page": []string{"7"}, "limit": []string{"5"}},
			wantPage:    1,
			wantPerPage: 7,
		},
		{
			name:      "invalid_page_format",
			values:    url.Values{"page": []string{"abc"}},
			wantError: "page must be a positive integer",
		},
		{
			name:      "invalid_per_page_format",
			values:    url.Values{"per_page": []string{"abc"}},
			wantError: "per_page must be a positive integer",
		},
		{
			name:      "invalid_limit_format",
			values:    url.Values{"limit": []string{"abc"}},
			wantError: "per_page must be a positive integer",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := parsePagination(tc.values)
			if tc.wantError != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantError)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.wantPage, got.Page)
			assert.Equal(t, tc.wantPerPage, got.PerPage)
		})
	}
}

func TestDecodeRequest_Matrix(t *testing.T) {
	t.Parallel()

	type payload struct {
		Name string `json:"name"`
	}

	tests := []struct {
		name      string
		body      string
		wantName  string
		wantError string
	}{
		{name: "valid_json", body: `{"name":"alice"}`, wantName: "alice"},
		{name: "invalid_json", body: `{`, wantError: "invalid JSON"},
		{name: "wrong_type", body: `{"name":1}`, wantError: "invalid JSON"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/decode", strings.NewReader(tc.body))
			var got payload
			err := decodeRequest(req, &got)
			if tc.wantError != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantError)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.wantName, got.Name)
		})
	}
}

func offsetName(v int) string {
	return strconv.Itoa(v)
}
