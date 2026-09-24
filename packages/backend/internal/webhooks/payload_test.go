package webhooks

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLandingRequestPayload_JSONIncludesJJNativeFields(t *testing.T) {
	payload := LandingRequestEventPayload{
		Action: "opened",
		LandingRequest: LandingRequestPayload{
			Number:         42,
			Title:          "Add authentication",
			State:          "open",
			Author:         UserPayload{ID: 9, Login: "alice"},
			ChangeIDs:      []string{"kxyz", "kabc"},
			TargetBookmark: "main",
			ConflictStatus: "clean",
			StackSize:      2,
			CreatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	landing, ok := decoded["landing_request"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, []any{"kxyz", "kabc"}, landing["change_ids"])
	assert.Equal(t, "main", landing["target_bookmark"])
	assert.Equal(t, "clean", landing["conflict_status"])
	assert.EqualValues(t, 2, landing["stack_size"])
}

func TestWorkflowRunEventPayload_JSONShape(t *testing.T) {
	payload := WorkflowRunEventPayload{
		Action: "queued",
		WorkflowRun: WorkflowRunPayload{
			ID:           7,
			Name:         "ci",
			Status:       "queued",
			TriggerEvent: "push",
			TriggerRef:   "main",
			CommitSHA:    "abc123",
			CreatedAt:    time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, "queued", decoded["action"])
	wr, ok := decoded["workflow_run"].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 7, wr["id"])
	assert.Equal(t, "queued", wr["status"])
	assert.Equal(t, "push", wr["trigger_event"])
	assert.Equal(t, "main", wr["trigger_ref"])
	assert.Equal(t, "abc123", wr["commit_sha"])
}

func TestWorkflowArtifactEventPayload_JSONShape(t *testing.T) {
	confirmedAt := time.Date(2026, time.February, 22, 12, 5, 0, 0, time.UTC)
	payload := WorkflowArtifactEventPayload{
		Action: "ready",
		Artifact: WorkflowArtifactPayload{
			ID:             9,
			WorkflowRunID:  7,
			Name:           "research.md",
			Size:           128,
			ContentType:    "text/markdown",
			Status:         "ready",
			SourceWorkflow: "research",
			CreatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, time.February, 22, 12, 5, 0, 0, time.UTC),
			ConfirmedAt:    &confirmedAt,
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, "ready", decoded["action"])
	artifact, ok := decoded["artifact"].(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 9, artifact["id"])
	assert.EqualValues(t, 7, artifact["workflow_run_id"])
	assert.Equal(t, "research.md", artifact["name"])
	assert.Equal(t, "research", artifact["source_workflow"])
	assert.Equal(t, "ready", artifact["status"])
}
