package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestLabel_Z_RemainingBranches(t *testing.T) {
	ctx := context.Background()
	actor := labelTestUser(1)
	privateRepo := labelHPrivateRepoFor(2)

	_, err := NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}).GetLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 403, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getLabelByIDFn: func(context.Context, db.GetLabelByIDParams) (db.Label, error) {
			return db.Label{}, pgx.ErrNoRows
		},
	}).GetLabel(ctx, actor, "alice", "demo", 1)
	require.Equal(t, 404, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateRepo, nil
		},
	}).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 403, labelAPIStatus(t, err))

	_, _, err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{}, pgx.ErrNoRows
		},
	}).ListIssueLabels(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Equal(t, 404, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return labelTestRepo(nil), nil
		},
		getIssueByNumberFn: func(context.Context, db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 10, Number: 1}, nil
		},
		removeIssueLabelByNameFn: func(context.Context, db.RemoveIssueLabelByNameParams) (int64, error) {
			return 0, nil
		},
	}).RemoveIssueLabelByName(ctx, actor, "alice", "demo", 1, "bug")
	require.Equal(t, 404, labelAPIStatus(t, err))

	err = NewLabelService(&mockLabelQuerier{}).requireReadAccess(ctx, privateRepo, actor)
	require.Equal(t, 403, labelAPIStatus(t, err))

	_, err = NewLabelService(&mockLabelQuerier{
		countLabelsForIssueFn: func(context.Context, int64) (int64, error) { return 2, nil },
		listLabelsForIssueFn: func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
			return nil, errors.New("list failed")
		},
	}).listAllLabelsForIssue(ctx, 10)
	require.Equal(t, 500, labelAPIStatus(t, err))

	labels, err := NewLabelService(&mockLabelQuerier{
		countLabelsForIssueFn: func(context.Context, int64) (int64, error) { return 2, nil },
		listLabelsForIssueFn: func(context.Context, db.ListLabelsForIssueParams) ([]db.Label, error) {
			return nil, nil
		},
	}).listAllLabelsForIssue(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, labels)
}
