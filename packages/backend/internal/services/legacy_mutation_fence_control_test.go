package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigureLegacyMutationFencesContractsTogetherAndNeverWeakens(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)
	_, err := pool.Exec(ctx, `
		UPDATE legacy_mutation_fence_control
		SET enforce_repository_storage = FALSE,
		    enforce_release_deletion = FALSE,
		    updated_at = NOW()
		WHERE singleton
	`)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
			UPDATE legacy_mutation_fence_control
			SET enforce_repository_storage = FALSE,
			    enforce_release_deletion = FALSE,
			    updated_at = NOW()
			WHERE singleton
		`)
	})

	state, err := ConfigureLegacyMutationFences(ctx, pool, false)
	require.NoError(t, err)
	assert.Equal(t, LegacyMutationFenceState{}, state)

	state, err = ConfigureLegacyMutationFences(ctx, pool, true)
	require.NoError(t, err)
	assert.Equal(t, LegacyMutationFenceState{
		RepositoryStorageEnforced: true,
		ReleaseDeletionEnabled:    true,
	}, state)

	state, err = ConfigureLegacyMutationFences(ctx, pool, false)
	require.NoError(t, err)
	assert.True(t, state.RepositoryStorageEnforced)
	assert.True(t, state.ReleaseDeletionEnabled)
}

func TestConfigureLegacyMutationFencesRequiresPool(t *testing.T) {
	_, err := ConfigureLegacyMutationFences(context.Background(), nil, true)
	require.ErrorContains(t, err, "database pool")
}
