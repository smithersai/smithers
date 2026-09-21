package webhooks

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLandingConflictEventPayload_JSONSerialization(t *testing.T) {
	payload := LandingConflictEventPayload{
		Action:         "conflicted",
		PreviousStatus: "clean",
		LandingRequest: LandingRequestPayload{
			Number:         42,
			Title:          "Add authentication",
			State:          "open",
			Author:         UserPayload{ID: 9, Login: "alice"},
			ChangeIDs:      []string{"kxyz", "kabc"},
			TargetBookmark: "main",
			ConflictStatus: "conflicted",
			StackSize:      2,
			CreatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt:      time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		ConflictsByChange: map[string][]ConflictDetail{
			"kxyz": {
				{
					FilePath:     "README.md",
					ConflictType: "both_modified",
				},
			},
		},
		Repository: RepositoryPayload{ID: 11, Name: "demo", FullName: "alice/demo"},
		Sender:     UserPayload{ID: 9, Login: "alice"},
	}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, "conflicted", decoded["action"])
	assert.Equal(t, "clean", decoded["previous_status"])

	landing, ok := decoded["landing_request"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "conflicted", landing["conflict_status"])

	conflictsByChange, ok := decoded["conflicts_by_change"].(map[string]any)
	require.True(t, ok)
	kxyz, ok := conflictsByChange["kxyz"].([]any)
	require.True(t, ok)
	require.Len(t, kxyz, 1)
	conflictDetail, ok := kxyz[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "README.md", conflictDetail["file_path"])
	assert.Equal(t, "both_modified", conflictDetail["conflict_type"])
}
