package services

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestValidateRepoName_Matrix(t *testing.T) {
	t.Parallel()

	valid := []string{
		"repo",
		"repo-1",
		"repo_1",
		"repo.1",
		"R",
		"a" + strings.Repeat("b", 99),
	}
	for _, name := range valid {
		name := name
		t.Run("valid_"+name, func(t *testing.T) {
			assert.NoError(t, validateRepoName(name))
		})
	}

	invalid := map[string]string{
		"":                             "missing_field",
		" ":                            "invalid",
		"-repo":                        "invalid",
		".repo":                        "invalid",
		"_repo":                        "invalid",
		"repo name":                    "invalid",
		"repo/name":                    "invalid",
		"repo.git":                     "invalid",
		"a" + strings.Repeat("b", 100): "invalid",
	}
	for name, code := range invalid {
		name, code := name, code
		t.Run("invalid_"+fmt.Sprintf("%q", name), func(t *testing.T) {
			err := validateRepoName(name)
			requireValidationFieldError(t, err, "name", code)
		})
	}

	reserved := make([]string, 0, len(reservedRepoNames))
	for name := range reservedRepoNames {
		reserved = append(reserved, name)
	}
	sort.Strings(reserved)
	for _, name := range reserved {
		name := name
		t.Run("reserved_"+name, func(t *testing.T) {
			requireValidationFieldError(t, validateRepoName(name), "name", "invalid")
			requireValidationFieldError(t, validateRepoName(strings.ToUpper(name)), "name", "invalid")
		})
	}
}

func TestNormalizeTopics_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     []string
		want      []string
		wantField string
		wantCode  string
	}{
		{name: "empty", input: nil, want: []string{}},
		{name: "normalizes_and_dedupes", input: []string{"Go", " api ", "go", "cli-tool"}, want: []string{"go", "api", "cli-tool"}},
		{name: "numeric_allowed", input: []string{"123", "go1"}, want: []string{"123", "go1"}},
		{name: "invalid_blank", input: []string{""}, wantField: "topics", wantCode: "invalid"},
		{name: "invalid_underscore", input: []string{"go_lang"}, wantField: "topics", wantCode: "invalid"},
		{name: "invalid_starts_with_dash", input: []string{"-go"}, wantField: "topics", wantCode: "invalid"},
		{name: "invalid_too_long", input: []string{"a" + strings.Repeat("b", 35)}, wantField: "topics", wantCode: "invalid"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeTopics(tc.input)
			if tc.wantField != "" {
				requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
				assert.Nil(t, got)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestValidateLabelName_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input     string
		want      string
		wantField string
		wantCode  string
	}{
		{input: "bug", want: "bug"},
		{input: "  bug  ", want: "bug"},
		{input: strings.Repeat("a", 255), want: strings.Repeat("a", 255)},
		{input: "", wantField: "name", wantCode: "missing_field"},
		{input: " ", wantField: "name", wantCode: "missing_field"},
		{input: strings.Repeat("a", 256), wantField: "name", wantCode: "invalid"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("label_%q", tc.input), func(t *testing.T) {
			got, err := validateLabelName(tc.input)
			if tc.wantField != "" {
				requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
				assert.Empty(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestNormalizeLabelColor_AllHexDigits(t *testing.T) {
	t.Parallel()

	for _, ch := range "0123456789abcdef" {
		color := strings.Repeat(string(ch), 6)
		t.Run("hex_"+string(ch), func(t *testing.T) {
			got, err := normalizeLabelColor(color)
			require.NoError(t, err)
			assert.Equal(t, "#"+color, got)
		})
	}
}

func TestNormalizeLabelColor_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input     string
		want      string
		wantField string
		wantCode  string
	}{
		{input: "ABCDEF", want: "#abcdef"},
		{input: " #123456 ", want: "#123456"},
		{input: "", wantField: "color", wantCode: "missing_field"},
		{input: " ", wantField: "color", wantCode: "missing_field"},
		{input: "#12345", wantField: "color", wantCode: "invalid"},
		{input: "#1234567", wantField: "color", wantCode: "invalid"},
		{input: "#12GG56", wantField: "color", wantCode: "invalid"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("color_%q", tc.input), func(t *testing.T) {
			got, err := normalizeLabelColor(tc.input)
			if tc.wantField != "" {
				requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
				assert.Empty(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestNormalizeLabelNames_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     []string
		want      []string
		wantField string
		wantCode  string
	}{
		{name: "dedupes_preserving_order", input: []string{"bug", "help wanted", "bug"}, want: []string{"bug", "help wanted"}},
		{name: "trims_values", input: []string{"  bug  ", " docs "}, want: []string{"bug", "docs"}},
		{name: "missing", input: nil, wantField: "labels", wantCode: "missing_field"},
		{name: "blank_label", input: []string{"bug", ""}, wantField: "labels", wantCode: "invalid"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeLabelNames(tc.input)
			if tc.wantField != "" {
				requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
				assert.Nil(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestNormalizeSearchPagination_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for page := -2; page <= 3; page++ {
		page := page
		for perPage := -2; perPage <= 105; perPage++ {
			perPage := perPage
			t.Run(fmt.Sprintf("page_%d_per_%d", page, perPage), func(t *testing.T) {
				caseCount++
				gotPage, gotPerPage := normalizeSearchPagination(page, perPage)
				if page < 1 {
					assert.Equal(t, 1, gotPage)
				} else {
					assert.Equal(t, page, gotPage)
				}
				switch {
				case perPage < 1:
					assert.Equal(t, searchDefaultPerPage, gotPerPage)
				case perPage > searchMaxPerPage:
					assert.Equal(t, searchMaxPerPage, gotPerPage)
				default:
					assert.Equal(t, perPage, gotPerPage)
				}
			})
		}
	}
	assert.Equal(t, 648, caseCount)
}

func TestSearchViewerID_NilAndValue(t *testing.T) {
	t.Parallel()

	assert.Equal(t, int64(0), searchViewerID(nil))
	assert.Equal(t, int64(42), searchViewerID(&db.User{ID: 42}))
}

func TestNormalizeWorkflowCacheConfig_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   WorkflowCacheConfig
		want WorkflowCacheConfig
	}{
		{
			name: "defaults",
			in:   WorkflowCacheConfig{},
			want: WorkflowCacheConfig{
				Prefix:          defaultWorkflowCachePrefix,
				SignedURLExpiry: blob.DefaultSignedURLExpiry,
				TTL:             defaultWorkflowCacheTTL,
				RepoQuotaBytes:  defaultWorkflowCacheRepoQuotaBytes,
				ArchiveMaxBytes: defaultWorkflowCacheArchiveMaxBytes,
			},
		},
		{
			name: "preserves_non_zero_and_trims_prefix",
			in: WorkflowCacheConfig{
				Prefix:          " /cache-prefix/ ",
				SignedURLExpiry: time.Minute,
				TTL:             time.Hour,
				RepoQuotaBytes:  123,
				ArchiveMaxBytes: 456,
			},
			want: WorkflowCacheConfig{
				Prefix:          "cache-prefix",
				SignedURLExpiry: time.Minute,
				TTL:             time.Hour,
				RepoQuotaBytes:  123,
				ArchiveMaxBytes: 456,
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeWorkflowCacheConfig(tc.in))
		})
	}
}

func TestValidateWorkflowCacheIdentity_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		key         string
		version     string
		wantKey     string
		wantVersion string
		wantStatus  int
		wantMessage string
	}{
		{name: "trims_key_and_version", key: "  npm-cache  ", version: "  v1  ", wantKey: "npm-cache", wantVersion: "v1"},
		{name: "default_version", key: "npm-cache", version: "", wantKey: "npm-cache", wantVersion: workflowCacheStaticVersion},
		{name: "missing_key", key: " ", wantStatus: 400, wantMessage: "cache key is required"},
		{name: "key_too_long", key: strings.Repeat("a", workflowCacheMaxKeyLength+1), wantStatus: 400, wantMessage: "cache key is too long"},
		{name: "version_too_long", key: "cache", version: strings.Repeat("v", workflowCacheMaxVersionLength+1), wantStatus: 400, wantMessage: "cache version is too long"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			gotKey, gotVersion, err := validateWorkflowCacheIdentity(tc.key, tc.version)
			if tc.wantStatus != 0 {
				requireAPIError(t, err, tc.wantStatus, tc.wantMessage)
				assert.Empty(t, gotKey)
				assert.Empty(t, gotVersion)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.wantKey, gotKey)
			assert.Equal(t, tc.wantVersion, gotVersion)
		})
	}
}

func TestNormalizeWorkflowCacheBookmark_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		def   string
		want  string
	}{
		{input: "", def: "main", want: "main"},
		{input: " refs/heads/main ", def: "default", want: "main"},
		{input: "refs/bookmarks/feature", def: "default", want: "feature"},
		{input: "bookmarks/release", def: "default", want: "release"},
		{input: "feature", def: "default", want: "feature"},
		{input: "refs/tags/v1.0.0", def: "main", want: "main"},
		{input: "tags/v1.0.0", def: "main", want: "main"},
		{input: "refs/unknown/x", def: "main", want: "main"},
		{input: "refs/heads/   ", def: "main", want: "main"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("bookmark_%q", tc.input), func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeWorkflowCacheBookmark(tc.input, tc.def))
		})
	}
}

func TestWorkflowCacheHelpers(t *testing.T) {
	t.Parallel()

	t.Run("object_key_is_deterministic_and_prefixed", func(t *testing.T) {
		key1 := workflowCacheObjectKey("cache-prefix", 7, 123, "main", "npm", "v1")
		key2 := workflowCacheObjectKey("cache-prefix", 7, 123, "main", "npm", "v1")
		key3 := workflowCacheObjectKey("cache-prefix", 7, 123, "main", "npm", "v2")
		assert.Equal(t, key1, key2)
		assert.NotEqual(t, key1, key3)
		assert.True(t, strings.HasPrefix(key1, "cache-prefix/repos/7/"))
		assert.True(t, strings.HasSuffix(key1, ".tgz"))
	})

	t.Run("expired", func(t *testing.T) {
		now := time.Date(2026, 3, 12, 6, 0, 0, 0, time.UTC)
		assert.True(t, workflowCacheExpired(now, now))
		assert.True(t, workflowCacheExpired(now.Add(-time.Second), now))
		assert.False(t, workflowCacheExpired(now.Add(time.Second), now))
	})

	t.Run("nullable_time", func(t *testing.T) {
		now := time.Date(2026, 3, 12, 6, 0, 0, 0, time.FixedZone("X", -7*3600))
		ptr := &now
		got, ok := workflowCacheNullableTime(now)
		require.True(t, ok)
		assert.Equal(t, now.UTC(), got)

		got, ok = workflowCacheNullableTime(pgtype.Timestamptz{Time: now, Valid: true})
		require.True(t, ok)
		assert.Equal(t, now.UTC(), got)

		got, ok = workflowCacheNullableTime(ptr)
		require.True(t, ok)
		assert.Equal(t, now.UTC(), got)

		_, ok = workflowCacheNullableTime(pgtype.Timestamptz{})
		assert.False(t, ok)
		_, ok = workflowCacheNullableTime(nil)
		assert.False(t, ok)
		_, ok = workflowCacheNullableTime("not-a-time")
		assert.False(t, ok)
	})
}

func TestUserHelpers_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("normalize_pagination", func(t *testing.T) {
		for page := -2; page <= 3; page++ {
			page := page
			for perPage := -2; perPage <= 105; perPage++ {
				perPage := perPage
				t.Run(fmt.Sprintf("page_%d_per_%d", page, perPage), func(t *testing.T) {
					gotPage, gotPerPage := normalizePagination(page, perPage)
					if page < 1 {
						assert.Equal(t, 1, gotPage)
					} else {
						assert.Equal(t, page, gotPage)
					}
					switch {
					case perPage < 1:
						assert.Equal(t, UserDefaultPerPage, gotPerPage)
					case perPage > UserMaxPerPage:
						assert.Equal(t, UserMaxPerPage, gotPerPage)
					default:
						assert.Equal(t, perPage, gotPerPage)
					}
				})
			}
		}
	})

	t.Run("activity_summary", func(t *testing.T) {
		tests := []struct {
			name string
			log  db.AuditLog
			want string
		}{
			{name: "repo_create", log: db.AuditLog{EventType: "repo.create", TargetName: "alice/demo"}, want: "created repository alice/demo"},
			{name: "repo_delete", log: db.AuditLog{EventType: "repo.delete", TargetName: "alice/demo"}, want: "deleted repository alice/demo"},
			{name: "repo_archive_no_target", log: db.AuditLog{EventType: "repo.archive"}, want: "archived repository"},
			{name: "fallback_action_and_target", log: db.AuditLog{EventType: "other", Action: "updated", TargetName: "alice/demo"}, want: "updated alice/demo"},
			{name: "fallback_target_only", log: db.AuditLog{EventType: "other", TargetName: "alice/demo"}, want: "alice/demo"},
			{name: "fallback_event_type", log: db.AuditLog{EventType: "user.login"}, want: "user login"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				assert.Equal(t, tc.want, formatActivitySummary(tc.log))
			})
		}
		assert.Equal(t, "did thing target", formatActivityWithTarget("did thing", "target"))
		assert.Equal(t, "did thing", formatActivityWithTarget("did thing", ""))
	})

	t.Run("text_value_and_mapping", func(t *testing.T) {
		assert.Equal(t, "", textValue(pgtype.Text{}))
		assert.Equal(t, "alice@example.com", textValue(pgtype.Text{String: "alice@example.com", Valid: true}))

		now := time.Date(2026, 3, 12, 6, 0, 0, 0, time.UTC)
		user := db.User{
			ID:          7,
			Username:    "alice",
			DisplayName: "Alice",
			Email:       pgtype.Text{String: "alice@example.com", Valid: true},
			Bio:         "bio",
			AvatarUrl:   "https://example.com/avatar.png",
			IsAdmin:     true,
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		assert.Equal(t, "alice@example.com", mapUserProfile(user).Email)
		assert.Equal(t, "alice", mapPublicUserProfile(user).Username)
		assert.Equal(t, "alice/demo", mapRepoSummary(db.Repository{ID: 1, Name: "demo"}, "alice").FullName)
		assert.Equal(t, "alice", mapActivitySummary(db.AuditLog{ActorName: " alice "}).ActorUsername)
		assert.Equal(t, "org", mapOrgSummary(db.Organization{Name: "org"}).Name)
	})
}

func TestSandboxAndWorkspaceHelpers_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("build_authenticated_repo_clone_url", func(t *testing.T) {
		tests := []struct {
			name       string
			baseURL    string
			owner      string
			repo       string
			token      string
			wantPath   string
			wantStatus string
		}{
			{name: "simple", baseURL: "https://git.example.test", owner: "alice", repo: "demo", token: "smithers_token", wantPath: "/alice/demo.git"},
			{name: "base_path_preserved", baseURL: "https://git.example.test/base", owner: "alice", repo: "demo", token: "smithers_token", wantPath: "/base/alice/demo.git"},
			{name: "missing_base", baseURL: "", owner: "alice", repo: "demo", token: "smithers_token", wantStatus: "git base url is required"},
			{name: "missing_repo", baseURL: "https://git.example.test", owner: "", repo: "demo", token: "smithers_token", wantStatus: "repository owner and name are required"},
			{name: "missing_token", baseURL: "https://git.example.test", owner: "alice", repo: "demo", token: "", wantStatus: "git clone token is required"},
			{name: "invalid_base", baseURL: "git.example.test", owner: "alice", repo: "demo", token: "smithers_token", wantStatus: "git base url must include scheme and host"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				got, err := buildAuthenticatedRepoCloneURL(tc.baseURL, tc.owner, tc.repo, tc.token)
				if tc.wantStatus != "" {
					require.Error(t, err)
					assert.Contains(t, err.Error(), tc.wantStatus)
					assert.Empty(t, got)
					return
				}
				require.NoError(t, err)
				parsed, parseErr := url.Parse(got)
				require.NoError(t, parseErr)
				assert.Equal(t, tc.wantPath, parsed.Path)
				assert.Equal(t, "x-access-token", parsed.User.Username())
				password, _ := parsed.User.Password()
				assert.Equal(t, tc.token, password)
			})
		}
	})

	t.Run("normalize_public_base_url", func(t *testing.T) {
		tests := []struct {
			input string
			want  string
		}{
			{input: "https://example.com/api", want: "https://example.com"},
			{input: "https://example.com/api/", want: "https://example.com"},
			{input: " https://example.com/path/ ", want: "https://example.com/path"},
			{input: "", want: ""},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("base_%q", tc.input), func(t *testing.T) {
				assert.Equal(t, tc.want, normalizePublicBaseURL(tc.input))
			})
		}
	})

	t.Run("optional_vm_id", func(t *testing.T) {
		assert.Equal(t, pgtype.Text{String: "vm-123", Valid: true}, optionalVMID(" vm-123 "))
		assert.Equal(t, pgtype.Text{String: "", Valid: false}, optionalVMID(" "))
	})

	t.Run("can_provision_workspace", func(t *testing.T) {
		tests := []struct {
			name  string
			input CreateWorkspaceSessionInput
			want  bool
		}{
			{name: "all_required_fields", input: CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "alice", RepoName: "demo"}, want: true},
			{name: "missing_user", input: CreateWorkspaceSessionInput{RepoOwner: "alice", RepoName: "demo"}, want: false},
			{name: "missing_owner", input: CreateWorkspaceSessionInput{UserID: 1, RepoName: "demo"}, want: false},
			{name: "missing_repo", input: CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "alice"}, want: false},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				assert.Equal(t, tc.want, canProvisionWorkspace(tc.input))
			})
		}
	})

	t.Run("workspace_response_mappers", func(t *testing.T) {
		now := time.Date(2026, 3, 12, 6, 0, 0, 0, time.UTC)
		session := db.WorkspaceSession{
			ID:              "sess-1",
			WorkspaceID:     "ws-1",
			RepositoryID:    7,
			UserID:          8,
			Status:          "active",
			Cols:            120,
			Rows:            40,
			LastActivityAt:  now,
			IdleTimeoutSecs: 3600,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		snapshot := db.WorkspaceSnapshot{
			ID:           "snap-1",
			RepositoryID: 7,
			UserID:       8,
			WorkspaceID:  "ws-1",
			Name:         "snapshot",
			SnapshotID:   "fs-1",
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		assert.Equal(t, session.ID, toWorkspaceSessionResponse(session).ID)
		assert.Equal(t, snapshot.ID, toWorkspaceSnapshotResponse(snapshot).ID)
	})
}

func TestEmailHelpers_Matrix(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 12, 6, 0, 0, 0, time.UTC)
	assert.Equal(t, "alice@example.com", mapEmailResponse(db.EmailAddress{
		ID:          1,
		Email:       "alice@example.com",
		IsActivated: true,
		IsPrimary:   true,
		CreatedAt:   now,
	}).Email)

	tests := []struct {
		input     string
		wantField string
		wantCode  string
	}{
		{input: "alice@example.com"},
		{input: "Alice <alice@example.com>", wantField: "email", wantCode: "invalid"},
		{input: "", wantField: "email", wantCode: "missing_field"},
		{input: strings.Repeat("a", 255) + "@example.com", wantField: "email", wantCode: "invalid"},
		{input: "alice", wantField: "email", wantCode: "invalid"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("email_%q", tc.input), func(t *testing.T) {
			err := validateEmail(tc.input)
			if tc.wantField != "" {
				requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
				return
			}
			require.NoError(t, err)
		})
	}
}

func requireValidationFieldError(t *testing.T, err error, wantField string, wantCode string) {
	t.Helper()

	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *APIError, got %T", err)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "validation failed", apiErr.Message)
	require.NotEmpty(t, apiErr.Errors)
	assert.Equal(t, wantField, apiErr.Errors[0].Field)
	assert.Equal(t, wantCode, apiErr.Errors[0].Code)
}
