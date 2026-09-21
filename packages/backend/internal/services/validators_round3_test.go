package services

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestIssueNormalizers_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("assignees", func(t *testing.T) {
		tests := []struct {
			name      string
			input     []string
			want      []string
			wantField string
			wantCode  string
		}{
			{name: "empty_slice", input: nil, want: []string{}},
			{name: "normalizes_and_dedupes", input: []string{"Alice", " bob ", "alice"}, want: []string{"alice", "bob"}},
			{name: "rejects_blank", input: []string{"alice", ""}, wantField: "assignees", wantCode: "invalid"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				got, err := normalizeAssigneeUsernames(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Nil(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})

	t.Run("filter_state", func(t *testing.T) {
		tests := []struct {
			input     string
			want      string
			wantField string
			wantCode  string
		}{
			{input: "", want: ""},
			{input: " OPEN ", want: "open"},
			{input: "closed", want: "closed"},
			// GitHub-compatible: state=all means "no filter" (same as empty).
			{input: "all", want: ""},
			{input: " ALL ", want: ""},
			{input: "merged", wantField: "state", wantCode: "invalid"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("filter_%q", tc.input), func(t *testing.T) {
				got, err := normalizeIssueFilterState(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Empty(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})

	t.Run("state", func(t *testing.T) {
		tests := []struct {
			input     string
			want      string
			wantField string
			wantCode  string
		}{
			{input: "OPEN", want: "open"},
			{input: " closed ", want: "closed"},
			{input: "", wantField: "state", wantCode: "invalid"},
			// "all" is a filter-only concept; a concrete state must be open/closed.
			{input: "all", wantField: "state", wantCode: "invalid"},
			{input: "merged", wantField: "state", wantCode: "invalid"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("state_%q", tc.input), func(t *testing.T) {
				got, err := normalizeIssueState(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Empty(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})
}

func TestWorkflowArtifactValidators_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("content_type", func(t *testing.T) {
		tests := []struct {
			input string
			want  string
		}{
			{input: "", want: defaultWorkflowArtifactContentType},
			{input: " ", want: defaultWorkflowArtifactContentType},
			{input: "text/plain", want: "text/plain"},
			{input: " application/gzip ", want: "application/gzip"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("content_type_%q", tc.input), func(t *testing.T) {
				assert.Equal(t, tc.want, normalizeWorkflowArtifactContentType(tc.input))
			})
		}
	})

	t.Run("name", func(t *testing.T) {
		tests := []struct {
			name      string
			input     string
			want      string
			wantField string
			wantCode  string
		}{
			{name: "plain", input: "build.tar.gz", want: "build.tar.gz"},
			{name: "trimmed", input: " artifact.zip ", want: "artifact.zip"},
			{name: "max_len", input: strings.Repeat("a", maxWorkflowArtifactNameLength), want: strings.Repeat("a", maxWorkflowArtifactNameLength)},
			{name: "missing", input: "", wantField: "name", wantCode: "missing_field"},
			{name: "dot", input: ".", wantField: "name", wantCode: "invalid"},
			{name: "dotdot", input: "..", wantField: "name", wantCode: "invalid"},
			{name: "slash", input: "dir/file", wantField: "name", wantCode: "invalid"},
			{name: "backslash", input: "dir\\file", wantField: "name", wantCode: "invalid"},
			{name: "control_char", input: "bad\x00name", wantField: "name", wantCode: "invalid"},
			{name: "too_long", input: strings.Repeat("a", maxWorkflowArtifactNameLength+1), wantField: "name", wantCode: "too_long"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				got, err := validateWorkflowArtifactName(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Empty(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})
}

func TestOAuth2Helpers_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("parse_scope_string", func(t *testing.T) {
		tests := []struct {
			input string
			want  []string
		}{
			{input: "", want: nil},
			{input: " ", want: nil},
			{input: "read:user", want: []string{"read:user"}},
			{input: "read:user write:repository", want: []string{"read:user", "write:repository"}},
			{input: "  read:user   write:repository  admin ", want: []string{"read:user", "write:repository", "admin"}},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("scope_%q", tc.input), func(t *testing.T) {
				assert.Equal(t, tc.want, parseScopeString(tc.input))
			})
		}
	})

	t.Run("to_response_nil_slices_become_empty", func(t *testing.T) {
		now := time.Date(2026, 3, 12, 7, 0, 0, 0, time.UTC)
		resp := toOAuth2ApplicationResponse(db.Oauth2Application{
			ID:           1,
			ClientID:     "client-1",
			Name:         "Test App",
			RedirectUris: nil,
			Scopes:       nil,
			Confidential: true,
			CreatedAt:    now,
			UpdatedAt:    now,
		})
		require.NotNil(t, resp.RedirectURIs)
		require.NotNil(t, resp.Scopes)
		assert.Empty(t, resp.RedirectURIs)
		assert.Empty(t, resp.Scopes)
		assert.Equal(t, "client-1", resp.ClientID)
	})

	t.Run("to_response_preserves_values", func(t *testing.T) {
		now := time.Date(2026, 3, 12, 7, 0, 0, 0, time.UTC)
		resp := toOAuth2ApplicationResponse(db.Oauth2Application{
			ID:           2,
			ClientID:     "client-2",
			Name:         "Prod App",
			RedirectUris: []string{"https://example.com/callback"},
			Scopes:       []string{"read:user", "write:repository"},
			Confidential: false,
			CreatedAt:    now,
			UpdatedAt:    now,
		})
		assert.Equal(t, []string{"https://example.com/callback"}, resp.RedirectURIs)
		assert.Equal(t, []string{"read:user", "write:repository"}, resp.Scopes)
		assert.False(t, resp.Confidential)
	})
}
