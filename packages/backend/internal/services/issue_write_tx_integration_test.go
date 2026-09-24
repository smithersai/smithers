package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// failingLabelsIssueWriteTxManager begins real transactions but fails the
// label replacement after the issue row is written.
type failingLabelsIssueWriteTxManager struct {
	inner *pgxIssueWriteTxManager
}

type failingLabelsIssueWriteTx struct {
	issueWriteTx
}

func (failingLabelsIssueWriteTx) ReplaceIssueLabels(context.Context, db.ReplaceIssueLabelsParams) error {
	return errors.New("injected label failure")
}

func (m failingLabelsIssueWriteTxManager) BeginIssueWriteTx(ctx context.Context) (issueWriteTx, error) {
	tx, err := m.inner.BeginIssueWriteTx(ctx)
	if err != nil {
		return nil, err
	}
	return failingLabelsIssueWriteTx{issueWriteTx: tx}, nil
}

func issueTxSeedLabel(t *testing.T, pool *pgxpool.Pool, repositoryID int64, name string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO labels (repository_id, name, color, description) VALUES ($1, $2, '#d73a4a', '')`,
		repositoryID, name)
	require.NoError(t, err)
}

func issueTxRepoID(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT id FROM repositories WHERE lower_name = $1`, name).Scan(&id))
	return id
}

func TestIssueWriteTx_Integration_CreateRollsBackOnLabelFailure(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repoName := issueCovSeedUserRepo(t, pool)
	repoID := issueTxRepoID(t, pool, repoName)
	issueTxSeedLabel(t, pool, repoID, "bug")

	queries := db.New(pool)
	svc := NewIssueService(queries, WithIssueWriteTxManager(failingLabelsIssueWriteTxManager{inner: &pgxIssueWriteTxManager{q: queries}}))

	_, err := svc.CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{Title: "t", Labels: []string{"bug"}})
	require.Equal(t, 500, issueAPIStatus(t, err))

	var issues, facts, nextNumber int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE repository_id = $1`, repoID).Scan(&issues))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_state_facts WHERE repository_id = $1`, repoID).Scan(&facts))
	require.NoError(t, pool.QueryRow(ctx, `SELECT next_issue_number FROM repositories WHERE id = $1`, repoID).Scan(&nextNumber))
	assert.Zero(t, issues, "the issue row must roll back with its labels")
	assert.Zero(t, facts)
	assert.Equal(t, int64(1), nextNumber, "the issue number must not be consumed")

	// A retry through the real transaction manager creates exactly one issue #1.
	created, err := NewIssueService(queries).CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{Title: "t", Labels: []string{"bug"}})
	require.NoError(t, err)
	assert.Equal(t, int64(1), created.Number)
	require.Len(t, created.Labels, 1)
}

func TestIssueWriteTx_Integration_UpdateSameSetsWritesNoFacts(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repoName := issueCovSeedUserRepo(t, pool)
	repoID := issueTxRepoID(t, pool, repoName)
	issueTxSeedLabel(t, pool, repoID, "bug")
	issueTxSeedLabel(t, pool, repoID, "docs")
	svc := NewIssueService(db.New(pool))

	created, err := svc.CreateIssue(ctx, &actor, actor.Username, repoName, CreateIssueInput{
		Title:     "t",
		Labels:    []string{"bug"},
		Assignees: []string{actor.Username},
	})
	require.NoError(t, err)

	countAssociationFacts := func() int64 {
		var n int64
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM issue_state_facts WHERE repository_id = $1 AND entity_type IN ('issue_label', 'issue_assignee')`,
			repoID).Scan(&n))
		return n
	}
	before := countAssociationFacts()

	labels := []string{"bug"}
	assignees := []string{actor.Username}
	_, err = svc.UpdateIssue(ctx, &actor, actor.Username, repoName, created.Number, UpdateIssueInput{Labels: &labels, Assignees: &assignees})
	require.NoError(t, err)
	assert.Equal(t, before, countAssociationFacts(), "re-sending unchanged sets must not churn association rows")

	labels = []string{"docs"}
	updated, err := svc.UpdateIssue(ctx, &actor, actor.Username, repoName, created.Number, UpdateIssueInput{Labels: &labels})
	require.NoError(t, err)
	assert.Equal(t, before+2, countAssociationFacts(), "swapping one label is one delete and one insert")
	require.Len(t, updated.Labels, 1)
	assert.Equal(t, "docs", updated.Labels[0].Name)
	require.Len(t, updated.Assignees, 1)

	empty := []string{}
	cleared, err := svc.UpdateIssue(ctx, &actor, actor.Username, repoName, created.Number, UpdateIssueInput{Labels: &empty, Assignees: &empty})
	require.NoError(t, err)
	assert.Empty(t, cleared.Labels)
	assert.Empty(t, cleared.Assignees)
}
