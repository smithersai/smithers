package configsync

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseConfigFiles_ParsesAndNormalizesEachConfigType(t *testing.T) {
	t.Parallel()

	files := map[string][]byte{
		configFilePath: []byte(`
repository:
  description: "repo description"
  topics: ["Go", "api", "api"]
  visibility: private
  mirror:
    enabled: true
    destination: "https://github.com/acme/demo"
workspace:
  idle_timeout_seconds: 900
  persistence: ephemeral
  dependencies: ["golang", "bun", "golang"]
landing_queue:
  mode: parallel
  required_checks: ["lint", "ci", "lint"]
`),
		protectedBookmarksFilePath: []byte(`
protected_bookmarks:
  - pattern: "main"
    require_human_approvals: 2
    require_agent_lgtm: true
    required_checks: ["lint", "ci", "lint"]
    dismiss_stale_reviews: true
    restrict_push:
      teams: ["maintainers", "maintainers"]
`),
		labelsFilePath: []byte(`
labels:
  - name: bug
    color: "EB5757"
    description: "Broken"
`),
		webhooksFilePath: []byte(`
webhooks:
  - url: "https://example.com/hook"
    events: ["Workflow_Run", "push", "push"]
    secret: "${{ secrets.HOOK_SECRET }}"
`),
	}

	parsed, err := ParseConfigFiles(files)
	require.NoError(t, err)

	require.True(t, parsed.ConfigFilePresent)
	require.NotNil(t, parsed.Config.Repository)
	require.NotNil(t, parsed.Config.Repository.Visibility)
	assert.Equal(t, "private", *parsed.Config.Repository.Visibility)
	assert.Equal(t, []string{"api", "go"}, parsed.Config.Repository.Topics)
	require.NotNil(t, parsed.Config.Workspace)
	require.NotNil(t, parsed.Config.Workspace.Persistence)
	assert.Equal(t, "ephemeral", *parsed.Config.Workspace.Persistence)
	assert.Equal(t, []string{"bun", "golang"}, parsed.Config.Workspace.Dependencies)
	require.NotNil(t, parsed.Config.LandingQueue)
	assert.Equal(t, []string{"ci", "lint"}, parsed.Config.LandingQueue.RequiredChecks)

	require.True(t, parsed.ProtectedBookmarksFilePresent)
	require.Len(t, parsed.ProtectedBookmarks, 1)
	assert.Equal(t, int64(2), parsed.ProtectedBookmarks[0].RequireHumanApprovals)
	assert.True(t, parsed.ProtectedBookmarks[0].RequireAgentLGTM)
	assert.Equal(t, []string{"ci", "lint"}, parsed.ProtectedBookmarks[0].RequiredChecks)
	assert.Equal(t, []string{"maintainers"}, parsed.ProtectedBookmarks[0].RestrictPushTeams)

	require.True(t, parsed.LabelsFilePresent)
	require.Len(t, parsed.Labels, 1)
	assert.Equal(t, "#eb5757", parsed.Labels[0].Color)

	require.True(t, parsed.WebhooksFilePresent)
	require.Len(t, parsed.Webhooks, 1)
	assert.True(t, parsed.Webhooks[0].Active)
	assert.Equal(t, []string{"push", "workflow_run"}, parsed.Webhooks[0].Events)
	assert.Equal(t, "${{ secrets.HOOK_SECRET }}", parsed.Webhooks[0].SecretRef)
}

func TestParseConfigFiles_RejectsUnknownFields(t *testing.T) {
	t.Parallel()

	_, err := ParseConfigFiles(map[string][]byte{
		configFilePath: []byte(`
repository:
  description: "demo"
  unsupported: true
`),
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "field unsupported not found")
}

func TestParseConfigFiles_RejectsPlaintextWebhookSecret(t *testing.T) {
	t.Parallel()

	_, err := ParseConfigFiles(map[string][]byte{
		webhooksFilePath: []byte(`
webhooks:
  - url: "https://example.com/hook"
    events: ["push"]
    secret: "plain-text-secret"
`),
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "must use")
}
