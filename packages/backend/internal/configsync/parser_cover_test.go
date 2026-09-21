package configsync

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestParser_Cover_ConfigFileValidationErrors exercises every validation branch
// in parseConfigFile via ParseConfigFiles.
func TestParser_Cover_ConfigFileValidationErrors(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name:    "invalid visibility",
			yaml:    "repository:\n  visibility: internal\n",
			wantErr: "repository.visibility must be public or private",
		},
		{
			name:    "invalid topic",
			yaml:    "repository:\n  topics: [\"bad topic\"]\n",
			wantErr: "invalid topic",
		},
		{
			name:    "mirror enabled missing",
			yaml:    "repository:\n  mirror:\n    destination: \"https://github.com/a/b\"\n",
			wantErr: "repository.mirror.enabled is required",
		},
		{
			name:    "mirror disabled with destination",
			yaml:    "repository:\n  mirror:\n    enabled: false\n    destination: \"https://github.com/a/b\"\n",
			wantErr: "must be omitted when repository.mirror.enabled is false",
		},
		{
			name:    "mirror enabled missing destination",
			yaml:    "repository:\n  mirror:\n    enabled: true\n",
			wantErr: "destination is required when repository.mirror.enabled is true",
		},
		{
			name:    "mirror destination invalid url",
			yaml:    "repository:\n  mirror:\n    enabled: true\n    destination: \"not-a-valid-url\"\n",
			wantErr: "repository.mirror.destination must be a valid URL",
		},
		{
			name:    "idle timeout not positive",
			yaml:    "workspace:\n  idle_timeout_seconds: 0\n",
			wantErr: "workspace.idle_timeout_seconds must be positive",
		},
		{
			name:    "idle timeout exceeds database limit",
			yaml:    "workspace:\n  idle_timeout_seconds: 2147483648\n",
			wantErr: "workspace.idle_timeout_seconds must be at most 2147483647",
		},
		{
			name:    "invalid persistence",
			yaml:    "workspace:\n  persistence: forever\n",
			wantErr: "workspace.persistence must be persistent or ephemeral",
		},
		{
			name:    "blank dependency",
			yaml:    "workspace:\n  dependencies: [\"go\", \"  \"]\n",
			wantErr: "workspace.dependencies",
		},
		{
			name:    "invalid landing mode",
			yaml:    "landing_queue:\n  mode: turbo\n",
			wantErr: "landing_queue.mode must be serialized or parallel",
		},
		{
			name:    "blank required check",
			yaml:    "landing_queue:\n  required_checks: [\"ci\", \"\"]\n",
			wantErr: "landing_queue.required_checks",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseConfigFiles(map[string][]byte{configFilePath: []byte(tc.yaml)})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

// TestParser_Cover_ConfigFileValidCombinations covers the happy branches for
// disabled mirror and public visibility that the existing suite doesn't touch.
func TestParser_Cover_ConfigFileValidCombinations(t *testing.T) {
	t.Parallel()

	parsed, err := ParseConfigFiles(map[string][]byte{
		configFilePath: []byte("repository:\n  visibility: PUBLIC\n  topics: []\n  mirror:\n    enabled: false\nworkspace:\n  idle_timeout_seconds: 2147483647\n  dependencies: []\nlanding_queue:\n  mode: serialized\n  required_checks: []\n"),
	})
	require.NoError(t, err)
	require.True(t, parsed.ConfigFilePresent)
	require.NotNil(t, parsed.Config.Repository)
	require.NotNil(t, parsed.Config.Repository.Visibility)
	assert.Equal(t, "public", *parsed.Config.Repository.Visibility)
	assert.Equal(t, []string{}, parsed.Config.Repository.Topics)
	require.NotNil(t, parsed.Config.Repository.Mirror)
	require.NotNil(t, parsed.Config.Repository.Mirror.Enabled)
	assert.False(t, *parsed.Config.Repository.Mirror.Enabled)
	assert.Equal(t, 2147483647, *parsed.Config.Workspace.IdleTimeoutSeconds)
	assert.Equal(t, []string{}, parsed.Config.Workspace.Dependencies)
	assert.Equal(t, []string{}, parsed.Config.LandingQueue.RequiredChecks)
}

// TestParser_Cover_ProtectedBookmarksBranches covers the empty, defaulting, and
// error branches of parseProtectedBookmarksFile.
func TestParser_Cover_ProtectedBookmarksBranches(t *testing.T) {
	t.Parallel()

	t.Run("empty content yields empty slice", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{protectedBookmarksFilePath: []byte("   \n")})
		require.NoError(t, err)
		require.True(t, parsed.ProtectedBookmarksFilePresent)
		assert.Equal(t, []ProtectedBookmarkRule{}, parsed.ProtectedBookmarks)
	})

	t.Run("missing key required", func(t *testing.T) {
		t.Parallel()
		_, err := ParseConfigFiles(map[string][]byte{protectedBookmarksFilePath: []byte("{}\n")})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "protected_bookmarks is required")
	})

	t.Run("defaults applied without optional fields", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			protectedBookmarksFilePath: []byte("protected_bookmarks:\n  - pattern: main\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.ProtectedBookmarks, 1)
		rule := parsed.ProtectedBookmarks[0]
		assert.True(t, rule.RequireReview)
		assert.Equal(t, int64(1), rule.RequireHumanApprovals)
		assert.Equal(t, []string{}, rule.RequiredChecks)
		assert.False(t, rule.DismissStaleReviews)
		assert.Equal(t, []string{}, rule.RestrictPushTeams)
	})

	t.Run("explicit optionals and sort", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			protectedBookmarksFilePath: []byte("protected_bookmarks:\n  - pattern: zeta\n    require_review: false\n    restrict_push: {}\n  - pattern: alpha\n    require_review: true\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.ProtectedBookmarks, 2)
		assert.Equal(t, "alpha", parsed.ProtectedBookmarks[0].Pattern)
		assert.True(t, parsed.ProtectedBookmarks[0].RequireReview)
		assert.Equal(t, "zeta", parsed.ProtectedBookmarks[1].Pattern)
		assert.False(t, parsed.ProtectedBookmarks[1].RequireReview)
		assert.Equal(t, []string{}, parsed.ProtectedBookmarks[1].RestrictPushTeams)
	})

	errCases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name:    "malformed yaml",
			yaml:    "protected_bookmarks: [\n",
			wantErr: "yaml",
		},
		{
			name:    "blank pattern",
			yaml:    "protected_bookmarks:\n  - pattern: \"  \"\n",
			wantErr: "protected_bookmarks.pattern is required",
		},
		{
			name:    "invalid glob pattern",
			yaml:    "protected_bookmarks:\n  - pattern: \"[\"\n",
			wantErr: "is invalid",
		},
		{
			name:    "duplicate pattern",
			yaml:    "protected_bookmarks:\n  - pattern: main\n  - pattern: main\n",
			wantErr: "duplicate protected bookmark pattern",
		},
		{
			name:    "negative approvals",
			yaml:    "protected_bookmarks:\n  - pattern: main\n    require_human_approvals: -1\n",
			wantErr: "require_human_approvals must be >= 0",
		},
		{
			name:    "blank required check",
			yaml:    "protected_bookmarks:\n  - pattern: main\n    required_checks: [\"\"]\n",
			wantErr: "protected_bookmarks.required_checks",
		},
		{
			name:    "blank restrict push team",
			yaml:    "protected_bookmarks:\n  - pattern: main\n    restrict_push:\n      teams: [\"  \"]\n",
			wantErr: "protected_bookmarks.restrict_push.teams",
		},
	}
	for _, tc := range errCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseConfigFiles(map[string][]byte{protectedBookmarksFilePath: []byte(tc.yaml)})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

// TestParser_Cover_LabelsBranches covers parseLabelsFile edge/error branches.
func TestParser_Cover_LabelsBranches(t *testing.T) {
	t.Parallel()

	t.Run("empty content yields empty slice", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{labelsFilePath: []byte("\n\n")})
		require.NoError(t, err)
		require.True(t, parsed.LabelsFilePresent)
		assert.Equal(t, []LabelDefinition{}, parsed.Labels)
	})

	t.Run("missing key required", func(t *testing.T) {
		t.Parallel()
		_, err := ParseConfigFiles(map[string][]byte{labelsFilePath: []byte("{}\n")})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "labels is required")
	})

	t.Run("sorts labels by name", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			labelsFilePath: []byte("labels:\n  - name: zeta\n    color: aabbcc\n  - name: alpha\n    color: ddeeff\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.Labels, 2)
		assert.Equal(t, "alpha", parsed.Labels[0].Name)
		assert.Equal(t, "zeta", parsed.Labels[1].Name)
	})

	errCases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name:    "malformed yaml",
			yaml:    "labels: [\n",
			wantErr: "yaml",
		},
		{
			name:    "blank name",
			yaml:    "labels:\n  - name: \"  \"\n    color: \"aabbcc\"\n",
			wantErr: "labels.name is required",
		},
		{
			name:    "name too long",
			yaml:    "labels:\n  - name: \"" + string(make255()) + "\"\n    color: \"aabbcc\"\n",
			wantErr: "labels.name is invalid",
		},
		{
			name:    "duplicate label",
			yaml:    "labels:\n  - name: bug\n    color: aabbcc\n  - name: bug\n    color: ddeeff\n",
			wantErr: "duplicate label",
		},
		{
			name:    "invalid color",
			yaml:    "labels:\n  - name: bug\n    color: \"xyz\"\n",
			wantErr: "labels.color is invalid",
		},
	}
	for _, tc := range errCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseConfigFiles(map[string][]byte{labelsFilePath: []byte(tc.yaml)})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

// make255 builds a 256-character label name (exceeds the 255 max).
func make255() []byte {
	b := make([]byte, 256)
	for i := range b {
		b[i] = 'a'
	}
	return b
}

// TestParser_Cover_WebhooksBranches covers parseWebhooksFile edge/error branches.
func TestParser_Cover_WebhooksBranches(t *testing.T) {
	t.Parallel()

	t.Run("empty content yields empty slice", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{webhooksFilePath: []byte("  ")})
		require.NoError(t, err)
		require.True(t, parsed.WebhooksFilePresent)
		assert.Equal(t, []WebhookDefinition{}, parsed.Webhooks)
	})

	t.Run("missing key required", func(t *testing.T) {
		t.Parallel()
		_, err := ParseConfigFiles(map[string][]byte{webhooksFilePath: []byte("{}\n")})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "webhooks is required")
	})

	t.Run("defaults active true without secret", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			webhooksFilePath: []byte("webhooks:\n  - url: \"https://example.com/hook\"\n    events: [\"push\"]\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.Webhooks, 1)
		assert.True(t, parsed.Webhooks[0].Active)
		assert.Equal(t, "", parsed.Webhooks[0].SecretRef)
	})

	t.Run("explicit inactive with blank secret", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			webhooksFilePath: []byte("webhooks:\n  - url: \"https://example.com/hook\"\n    events: [\"push\"]\n    secret: \"  \"\n    active: false\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.Webhooks, 1)
		assert.False(t, parsed.Webhooks[0].Active)
		assert.Equal(t, "", parsed.Webhooks[0].SecretRef)
	})

	t.Run("sorts webhooks by url", func(t *testing.T) {
		t.Parallel()
		parsed, err := ParseConfigFiles(map[string][]byte{
			webhooksFilePath: []byte("webhooks:\n  - url: \"https://z.example.com/hook\"\n    events: [\"push\"]\n  - url: \"https://a.example.com/hook\"\n    events: [\"push\"]\n"),
		})
		require.NoError(t, err)
		require.Len(t, parsed.Webhooks, 2)
		assert.Equal(t, "https://a.example.com/hook", parsed.Webhooks[0].URL)
		assert.Equal(t, "https://z.example.com/hook", parsed.Webhooks[1].URL)
	})

	errCases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name:    "malformed yaml",
			yaml:    "webhooks: [\n",
			wantErr: "yaml",
		},
		{
			name:    "blank url",
			yaml:    "webhooks:\n  - url: \"  \"\n    events: [\"push\"]\n",
			wantErr: "webhooks.url is required",
		},
		{
			name:    "non https url",
			yaml:    "webhooks:\n  - url: \"http://example.com/hook\"\n    events: [\"push\"]\n",
			wantErr: "webhooks.url must use https",
		},
		{
			name:    "invalid url",
			yaml:    "webhooks:\n  - url: \"https://exa mple.com/hook\"\n    events: [\"push\"]\n",
			wantErr: "webhooks.url must be a valid URL",
		},
		{
			name:    "duplicate url",
			yaml:    "webhooks:\n  - url: \"https://example.com/hook\"\n    events: [\"push\"]\n  - url: \"https://example.com/hook\"\n    events: [\"push\"]\n",
			wantErr: "duplicate webhook url",
		},
		{
			name:    "blank event",
			yaml:    "webhooks:\n  - url: \"https://example.com/hook\"\n    events: [\"\"]\n",
			wantErr: "webhooks.events",
		},
		{
			name:    "no events",
			yaml:    "webhooks:\n  - url: \"https://example.com/hook\"\n    events: []\n",
			wantErr: "must contain at least one event",
		},
	}
	for _, tc := range errCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseConfigFiles(map[string][]byte{webhooksFilePath: []byte(tc.yaml)})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

// TestParser_Cover_DecodeYAMLStrictEOF covers the io.EOF branch (comment-only doc)
// of decodeYAMLStrict, which trims to non-empty but decodes to nothing.
func TestParser_Cover_DecodeYAMLStrictEOF(t *testing.T) {
	t.Parallel()

	parsed, err := ParseConfigFiles(map[string][]byte{configFilePath: []byte("# only a comment\n")})
	require.NoError(t, err)
	require.True(t, parsed.ConfigFilePresent)
	assert.Nil(t, parsed.Config.Repository)
	assert.Nil(t, parsed.Config.Workspace)
	assert.Nil(t, parsed.Config.LandingQueue)
}

// TestParser_Cover_DecodeYAMLStrictEmptyConfig covers the empty-document branch
// of decodeYAMLStrict through config.yml, whose parser does not pre-trim input.
func TestParser_Cover_DecodeYAMLStrictEmptyConfig(t *testing.T) {
	t.Parallel()

	parsed, err := ParseConfigFiles(map[string][]byte{configFilePath: []byte(" \n\t")})
	require.NoError(t, err)
	require.True(t, parsed.ConfigFilePresent)
	assert.Nil(t, parsed.Config.Repository)
	assert.Nil(t, parsed.Config.Workspace)
	assert.Nil(t, parsed.Config.LandingQueue)
}

// TestParser_Cover_NormalizeLabelColor exercises normalizeLabelColor directly
// for the empty, wrong-length, invalid-char, and happy cases.
func TestParser_Cover_NormalizeLabelColor(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr string
	}{
		{name: "valid with hash", raw: "#EB5757", want: "#eb5757"},
		{name: "valid without hash", raw: " aAbBcC ", want: "#aabbcc"},
		{name: "empty", raw: "  ", wantErr: "labels.color is required"},
		{name: "wrong length", raw: "abc", wantErr: "labels.color is invalid"},
		{name: "invalid char", raw: "gggggg", wantErr: "labels.color is invalid"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeLabelColor(tc.raw)
			if tc.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestParser_Cover_NormalizeHelpers covers the nil/empty branches of the
// list-normalization helpers directly.
func TestParser_Cover_NormalizeHelpers(t *testing.T) {
	t.Parallel()

	t.Run("topics nil and empty", func(t *testing.T) {
		t.Parallel()
		got, err := normalizeOptionalTopics(nil)
		require.NoError(t, err)
		assert.Nil(t, got)

		got, err = normalizeOptionalTopics([]string{})
		require.NoError(t, err)
		assert.Equal(t, []string{}, got)
	})

	t.Run("topics invalid", func(t *testing.T) {
		t.Parallel()
		_, err := normalizeOptionalTopics([]string{"Bad Topic"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid topic")
	})

	t.Run("trimmed list nil and empty", func(t *testing.T) {
		t.Parallel()
		got, err := normalizeOptionalTrimmedList(nil, false)
		require.NoError(t, err)
		assert.Nil(t, got)

		got, err = normalizeOptionalTrimmedList([]string{}, true)
		require.NoError(t, err)
		assert.Equal(t, []string{}, got)
	})

	t.Run("trimmed list blank error", func(t *testing.T) {
		t.Parallel()
		_, err := normalizeOptionalTrimmedList([]string{"ok", "   "}, false)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must not contain blanks")
	})

	t.Run("required checks or empty nil", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, []string{}, requiredChecksOrEmpty(nil))
		assert.Equal(t, []string{"a"}, requiredChecksOrEmpty([]string{"a"}))
	})
}

// TestParser_Cover_ParseConfigFilesErrorPropagation ensures each per-file parse
// error is surfaced by ParseConfigFiles.
func TestParser_Cover_ParseConfigFilesErrorPropagation(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		files   map[string][]byte
		wantErr string
	}{
		{
			name:    "protected bookmarks error",
			files:   map[string][]byte{protectedBookmarksFilePath: []byte("protected_bookmarks:\n  - pattern: \"  \"\n")},
			wantErr: "protected_bookmarks.pattern is required",
		},
		{
			name:    "labels error",
			files:   map[string][]byte{labelsFilePath: []byte("labels:\n  - name: bug\n    color: bad\n")},
			wantErr: "labels.color is invalid",
		},
		{
			name:    "webhooks error",
			files:   map[string][]byte{webhooksFilePath: []byte("webhooks:\n  - url: \"http://x\"\n    events: [\"push\"]\n")},
			wantErr: "webhooks.url must use https",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseConfigFiles(tc.files)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}
