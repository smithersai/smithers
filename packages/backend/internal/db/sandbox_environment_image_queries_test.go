package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertSandboxEnvironmentImageRetiresPriorPlatformBase(t *testing.T) {
	ctx := context.Background()
	queries := New(sharedPool)
	_, err := sharedPool.Exec(ctx, `DELETE FROM sandbox_environment_images WHERE repository_id IS NULL AND kind='vm'`)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM sandbox_environment_images WHERE repository_id IS NULL AND kind='vm'`)
	})

	first, err := queries.UpsertSandboxEnvironmentImage(ctx, UpsertSandboxEnvironmentImageParams{
		Kind: "vm", Source: ".smithers/environment.nix",
		ClosureHash:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Image:        "registry/base:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RepositoryID: pgtype.Int8{}, CreatedBy: pgtype.Int8{},
	})
	require.NoError(t, err)
	second, err := queries.UpsertSandboxEnvironmentImage(ctx, UpsertSandboxEnvironmentImageParams{
		Kind: "vm", Source: ".smithers/environment.nix",
		ClosureHash:  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Image:        "registry/base:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		RepositoryID: pgtype.Int8{}, CreatedBy: pgtype.Int8{},
	})
	require.NoError(t, err)

	rows, err := queries.ListSandboxEnvironmentImages(ctx, pgtype.Int8{})
	require.NoError(t, err)
	status := make(map[string]string, len(rows))
	for _, row := range rows {
		status[row.ID] = row.Status
	}
	assert.Equal(t, "retired", status[first.ID])
	assert.Equal(t, "ready", status[second.ID])

	ready, err := queries.ListReadySandboxEnvironmentImageReferences(ctx)
	require.NoError(t, err)
	assert.Contains(t, ready, second.Image)
	assert.NotContains(t, ready, first.Image)
}
