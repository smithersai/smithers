package configsync

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestService_H_BuildPlanConfigOnlyRepoUpdate(t *testing.T) {
	t.Parallel()

	svc := newServiceWithStore(nil, nil, nil, nil, nil)
	plan, err := svc.buildPlan(context.Background(), db.Repository{
		ID:                         42,
		Description:                "old",
		IsPublic:                   false,
		Topics:                     []string{"backend"},
		WorkspaceIdleTimeoutSecs:   1800,
		WorkspacePersistence:       "persistent",
		WorkspaceDependencies:      []string{"bun"},
		LandingQueueMode:           "serialized",
		LandingQueueRequiredChecks: []string{"old-check"},
	}, ParsedConfig{
		ConfigFilePresent: true,
		Config: ConfigFile{
			Repository: &RepositorySettings{
				Description: stringPtr("new"),
				Visibility:  stringPtr("public"),
			},
			Workspace: &WorkspaceSettings{
				IdleTimeoutSeconds: intPtr(900),
				Persistence:        stringPtr("ephemeral"),
			},
			LandingQueue: &LandingQueueSettings{
				Mode: stringPtr("parallel"),
			},
		},
	})

	require.NoError(t, err)
	require.NotNil(t, plan.repoUpdate)
	assert.Equal(t, int64(42), plan.repoUpdate.ID)
	assert.Equal(t, "new", plan.repoUpdate.Description)
	assert.True(t, plan.repoUpdate.IsPublic)
	assert.Equal(t, int32(900), plan.repoUpdate.WorkspaceIdleTimeoutSecs)
	assert.Equal(t, "ephemeral", plan.repoUpdate.WorkspacePersistence)
	assert.Equal(t, "parallel", plan.repoUpdate.LandingQueueMode)
	assert.Empty(t, plan.warnings)
	assert.Len(t, plan.changes, 5)
}
