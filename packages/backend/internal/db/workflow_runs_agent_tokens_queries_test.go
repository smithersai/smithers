package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkflowRunAgentToken_UpdateAndGet(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "workflow-agent-token-user")
	repoID := mustCreateRepo(t, pool, userID, "workflow-agent-token-repo")
	cfg := []byte(`{"triggers":[{"type":"push"}],"steps":[{"name":"build","run":"make build"}]}`)

	def, err := q.CreateWorkflowDefinition(context.Background(), CreateWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "Agent Token",
		Path:         ".smithers/workflows/agent-token.tsx",
		Config:       cfg,
	})
	require.NoError(t, err)

	run, err := q.CreateWorkflowRun(context.Background(), CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-agent-token",
	})
	require.NoError(t, err)

	tokenHash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	expiresAt := time.Now().UTC().Add(1 * time.Hour).Truncate(time.Microsecond)

	updated, err := q.UpdateWorkflowRunAgentToken(context.Background(), UpdateWorkflowRunAgentTokenParams{
		ID: run.ID,
		AgentTokenHash: pgtype.Text{
			String: tokenHash,
			Valid:  true,
		},
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  expiresAt,
			Valid: true,
		},
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, updated.ID)
	assert.True(t, updated.AgentTokenHash.Valid)
	assert.Equal(t, tokenHash, updated.AgentTokenHash.String)
	assert.True(t, updated.AgentTokenExpiresAt.Valid)
	assert.WithinDuration(t, expiresAt, updated.AgentTokenExpiresAt.Time, time.Second)

	fetched, err := q.GetWorkflowRunByAgentToken(context.Background(), pgtype.Text{
		String: tokenHash,
		Valid:  true,
	})
	require.NoError(t, err)
	assert.Equal(t, run.ID, fetched.ID)
	assert.True(t, fetched.AgentTokenHash.Valid)
	assert.Equal(t, tokenHash, fetched.AgentTokenHash.String)
	assert.True(t, fetched.AgentTokenExpiresAt.Valid)
	assert.WithinDuration(t, expiresAt, fetched.AgentTokenExpiresAt.Time, time.Second)
}

func TestWorkflowRunAgentToken_GetMissingReturnsNoRows(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.GetWorkflowRunByAgentToken(context.Background(), pgtype.Text{
		String: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		Valid:  true,
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}
