package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateRepoConfigState(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "repo-config-user")
	repoID := mustCreateRepo(t, pool, userID, "repo-config-repo")

	updated, err := q.UpdateRepoConfigState(context.Background(), UpdateRepoConfigStateParams{
		ID:                         repoID,
		Description:                "updated description",
		IsPublic:                   false,
		Topics:                     []string{"api", "go"},
		IsMirror:                   true,
		MirrorDestination:          "https://github.com/acme/demo",
		WorkspaceIdleTimeoutSecs:   900,
		WorkspacePersistence:       "ephemeral",
		WorkspaceDependencies:      []string{"bun", "go"},
		LandingQueueMode:           "parallel",
		LandingQueueRequiredChecks: []string{"ci"},
	})
	require.NoError(t, err)

	assert.Equal(t, "updated description", updated.Description)
	assert.False(t, updated.IsPublic)
	assert.Equal(t, []string{"api", "go"}, updated.Topics)
	assert.True(t, updated.IsMirror)
	assert.Equal(t, "https://github.com/acme/demo", updated.MirrorDestination)
	assert.EqualValues(t, 900, updated.WorkspaceIdleTimeoutSecs)
	assert.Equal(t, "ephemeral", updated.WorkspacePersistence)
	assert.Equal(t, []string{"bun", "go"}, updated.WorkspaceDependencies)
	assert.Equal(t, "parallel", updated.LandingQueueMode)
	assert.Equal(t, []string{"ci"}, updated.LandingQueueRequiredChecks)
}
