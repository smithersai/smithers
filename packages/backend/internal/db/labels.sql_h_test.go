package db

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type labelsSQLHDB = chunk5SQLHDB
type labelsSQLHRow = chunk5SQLHRow
type labelsSQLHRows = chunk5SQLHRows

func TestLabelsSQL_H_ListAndCountRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	issue := mustCreateIssue(t, q, repoID, userID, "labels h issue")

	bug, err := q.CreateLabel(ctx, CreateLabelParams{RepositoryID: repoID, Name: "bug", Color: "ff0000", Description: "Bug"})
	require.NoError(t, err)
	feature, err := q.CreateLabel(ctx, CreateLabelParams{RepositoryID: repoID, Name: "feature", Color: "00ff00", Description: "Feature"})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(ctx, AddIssueLabelParams{IssueID: issue.ID, LabelID: bug.ID})
	require.NoError(t, err)

	count, err := q.CountIssueLabelsByLabel(ctx, bug.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
	count, err = q.CountIssueLabelsByLabel(ctx, feature.ID)
	require.NoError(t, err)
	assert.Zero(t, count)

	all, err := q.ListAllLabelsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, all, 2)
	byNames, err := q.ListLabelsByNames(ctx, ListLabelsByNamesParams{RepositoryID: repoID, Names: []string{"feature", "missing"}})
	require.NoError(t, err)
	require.Len(t, byNames, 1)
	assert.Equal(t, feature.ID, byNames[0].ID)
	paged, err := q.ListLabelsByRepo(ctx, ListLabelsByRepoParams{RepositoryID: repoID, PageOffset: 0, PageSize: 1})
	require.NoError(t, err)
	require.Len(t, paged, 1)
	forIssue, err := q.ListLabelsForIssue(ctx, ListLabelsForIssueParams{IssueID: issue.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, forIssue, 1)
	assert.Equal(t, bug.ID, forIssue[0].ID)
	empty, err := q.ListLabelsByNames(ctx, ListLabelsByNamesParams{RepositoryID: repoID, Names: []string{"none"}})
	require.NoError(t, err)
	assert.Empty(t, empty)
}

func TestLabelsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("labels h failed")
	listCases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAllLabelsByRepo", func(q *Queries) error { _, err := q.ListAllLabelsByRepo(context.Background(), 1); return err }},
		{"ListLabelsByNames", func(q *Queries) error {
			_, err := q.ListLabelsByNames(context.Background(), ListLabelsByNamesParams{RepositoryID: 1, Names: []string{"a"}})
			return err
		}},
		{"ListLabelsByRepo", func(q *Queries) error {
			_, err := q.ListLabelsByRepo(context.Background(), ListLabelsByRepoParams{RepositoryID: 1, PageSize: 1})
			return err
		}},
		{"ListLabelsForIssue", func(q *Queries) error {
			_, err := q.ListLabelsForIssue(context.Background(), ListLabelsForIssueParams{IssueID: 1, PageSize: 1})
			return err
		}},
	}
	for _, tc := range listCases {
		require.ErrorIs(t, tc.call(New(labelsSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(labelsSQLHDB{rows: &labelsSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(labelsSQLHDB{rows: &labelsSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}
	_, err := New(labelsSQLHDB{row: labelsSQLHRow{err: sentinel}}).CountIssueLabelsByLabel(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}
