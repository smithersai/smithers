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

func TestLabelQueries_CRUDAndIssueAssociations(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "label-query-user")
	repoID := mustCreateRepo(t, pool, userID, "label-query-repo")
	otherRepoID := mustCreateRepo(t, pool, userID, "label-query-other")

	created, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "bug",
		Color:        "#ff0000",
		Description:  "bug label",
	})
	require.NoError(t, err)
	assert.Equal(t, "bug", created.Name)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateLabel(context.Background(), CreateLabelParams{
			RepositoryID: repoID,
			Name:         "bug",
			Color:        "#00ff00",
			Description:  "duplicate",
		})
		return err
	})

	_, err = q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "docs",
		Color:        "#0000ff",
		Description:  "docs label",
	})
	require.NoError(t, err)

	count, err := q.CountLabelsByRepo(context.Background(), repoID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	labels, err := q.ListLabelsByRepo(context.Background(), ListLabelsByRepoParams{
		RepositoryID: repoID,
		PageOffset:   0,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, labels, 1)
	assert.Equal(t, "bug", labels[0].Name)

	loaded, err := q.GetLabelByID(context.Background(), GetLabelByIDParams{RepositoryID: repoID, ID: created.ID})
	require.NoError(t, err)
	assert.Equal(t, created.ID, loaded.ID)

	_, err = q.GetLabelByID(context.Background(), GetLabelByIDParams{RepositoryID: otherRepoID, ID: created.ID})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	updated, err := q.UpdateLabel(context.Background(), UpdateLabelParams{
		ID:           created.ID,
		RepositoryID: repoID,
		Name:         "bug-updated",
		Color:        "#123456",
		Description:  "updated",
	})
	require.NoError(t, err)
	assert.Equal(t, "bug-updated", updated.Name)
	assert.Equal(t, "#123456", updated.Color)
	assert.Equal(t, "updated", updated.Description)

	var issue Issue
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO issues (repository_id, number, title, body, state, author_id) VALUES ($1, 1, $2, '', 'open', $3) RETURNING id, repository_id, number`,
		repoID,
		"label test issue",
		userID,
	).Scan(&issue.ID, &issue.RepositoryID, &issue.Number)
	require.NoError(t, err)

	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: issue.ID, LabelID: created.ID})
	require.NoError(t, err)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: issue.ID, LabelID: created.ID})
		return err
	})

	issueLabels, err := q.ListLabelsForIssue(context.Background(), ListLabelsForIssueParams{
		IssueID:    issue.ID,
		PageOffset: 0,
		PageSize:   10,
	})
	require.NoError(t, err)
	require.Len(t, issueLabels, 1)
	assert.Equal(t, created.ID, issueLabels[0].ID)

	issueLabelCount, err := q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), issueLabelCount)

	removed, err := q.RemoveIssueLabelByName(context.Background(), RemoveIssueLabelByNameParams{
		RepositoryID: repoID,
		IssueNumber:  issue.Number,
		LabelName:    updated.Name,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), removed)

	issueLabelCount, err = q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), issueLabelCount)

	err = q.DeleteLabel(context.Background(), DeleteLabelParams{RepositoryID: repoID, ID: created.ID})
	require.NoError(t, err)

	_, err = q.GetLabelByID(context.Background(), GetLabelByIDParams{RepositoryID: repoID, ID: created.ID})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestGetLabelByName_ReturnsLabelByRepoAndName(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "label-name-user")
	repoID := mustCreateRepo(t, pool, userID, "label-name-repo")

	created, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "feature",
		Color:        "#00ff00",
		Description:  "feature label",
	})
	require.NoError(t, err)

	found, err := q.GetLabelByName(context.Background(), GetLabelByNameParams{
		RepositoryID: repoID,
		Name:         "feature",
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, found.ID)
	assert.Equal(t, "feature", found.Name)

	// Not found for different repo.
	otherRepoID := mustCreateRepo(t, pool, userID, "label-name-other")
	_, err = q.GetLabelByName(context.Background(), GetLabelByNameParams{
		RepositoryID: otherRepoID,
		Name:         "feature",
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestListLabelsByNames_ReturnsBatchResults(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "label-names-user")
	repoID := mustCreateRepo(t, pool, userID, "label-names-repo")

	_, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "bug",
		Color:        "#ff0000",
		Description:  "",
	})
	require.NoError(t, err)

	_, err = q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "docs",
		Color:        "#0000ff",
		Description:  "",
	})
	require.NoError(t, err)

	_, err = q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "enhancement",
		Color:        "#00ff00",
		Description:  "",
	})
	require.NoError(t, err)

	// Fetch subset by names.
	labels, err := q.ListLabelsByNames(context.Background(), ListLabelsByNamesParams{
		RepositoryID: repoID,
		Names:        []string{"bug", "enhancement"},
	})
	require.NoError(t, err)
	require.Len(t, labels, 2)
	assert.Equal(t, "bug", labels[0].Name)
	assert.Equal(t, "enhancement", labels[1].Name)

	// Empty names array returns nothing.
	empty, err := q.ListLabelsByNames(context.Background(), ListLabelsByNamesParams{
		RepositoryID: repoID,
		Names:        []string{},
	})
	require.NoError(t, err)
	assert.Len(t, empty, 0)
}

func TestAddIssueLabels_BulkAddMultipleLabels(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "bulk-label-user")
	repoID := mustCreateRepo(t, pool, userID, "bulk-label-repo")

	bug, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "bug",
		Color:        "#ff0000",
		Description:  "",
	})
	require.NoError(t, err)

	docs, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "docs",
		Color:        "#0000ff",
		Description:  "",
	})
	require.NoError(t, err)

	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "bulk label issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	// Add both labels in one call.
	err = q.AddIssueLabels(context.Background(), AddIssueLabelsParams{
		IssueID:  issue.ID,
		LabelIds: []int64{bug.ID, docs.ID},
	})
	require.NoError(t, err)

	count, err := q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	// Duplicate should fail.
	err = q.AddIssueLabels(context.Background(), AddIssueLabelsParams{
		IssueID:  issue.ID,
		LabelIds: []int64{bug.ID},
	})
	require.Error(t, err)
}

func TestRemoveIssueLabel_ByLabelID(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "rm-label-user")
	repoID := mustCreateRepo(t, pool, userID, "rm-label-repo")

	label, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "removable",
		Color:        "#aabbcc",
		Description:  "",
	})
	require.NoError(t, err)

	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "rm label issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{
		IssueID: issue.ID,
		LabelID: label.ID,
	})
	require.NoError(t, err)

	count, err := q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)

	// Remove by label ID.
	err = q.RemoveIssueLabel(context.Background(), RemoveIssueLabelParams{
		IssueID: issue.ID,
		LabelID: label.ID,
	})
	require.NoError(t, err)

	count, err = q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), count)
}

func TestMilestoneQueries_CRUDAndStateFiltering(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "milestone-query-user")
	repoID := mustCreateRepo(t, pool, userID, "milestone-query-repo")
	otherRepoID := mustCreateRepo(t, pool, userID, "milestone-query-other")
	due := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)

	created, err := q.CreateMilestone(context.Background(), CreateMilestoneParams{
		RepositoryID: repoID,
		Title:        "v1",
		Description:  "first",
		DueDate:      pgtype.Timestamptz{Time: due, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "open", created.State)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateMilestone(context.Background(), CreateMilestoneParams{
			RepositoryID: repoID,
			Title:        "v1",
			Description:  "dup",
		})
		return err
	})

	_, err = q.CreateMilestone(context.Background(), CreateMilestoneParams{
		RepositoryID: repoID,
		Title:        "v2",
		Description:  "second",
	})
	require.NoError(t, err)

	count, err := q.CountMilestonesByRepo(context.Background(), CountMilestonesByRepoParams{
		RepositoryID: repoID,
		State:        "",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	openList, err := q.ListMilestonesByRepo(context.Background(), ListMilestonesByRepoParams{
		RepositoryID: repoID,
		State:        "open",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, openList, 2)

	loaded, err := q.GetMilestoneByID(context.Background(), GetMilestoneByIDParams{RepositoryID: repoID, ID: created.ID})
	require.NoError(t, err)
	assert.Equal(t, created.ID, loaded.ID)

	_, err = q.GetMilestoneByID(context.Background(), GetMilestoneByIDParams{RepositoryID: otherRepoID, ID: created.ID})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	closedAt := time.Now().UTC().Truncate(time.Second)
	updated, err := q.UpdateMilestone(context.Background(), UpdateMilestoneParams{
		ID:           created.ID,
		RepositoryID: repoID,
		Title:        "v1-closed",
		Description:  "closed",
		State:        "closed",
		DueDate:      pgtype.Timestamptz{Time: due.Add(24 * time.Hour), Valid: true},
		ClosedAt:     pgtype.Timestamptz{Time: closedAt, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "closed", updated.State)
	assert.True(t, updated.ClosedAt.Valid)

	closedCount, err := q.CountMilestonesByRepo(context.Background(), CountMilestonesByRepoParams{
		RepositoryID: repoID,
		State:        "closed",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), closedCount)

	err = q.DeleteMilestone(context.Background(), DeleteMilestoneParams{RepositoryID: repoID, ID: created.ID})
	require.NoError(t, err)

	_, err = q.GetMilestoneByID(context.Background(), GetMilestoneByIDParams{RepositoryID: repoID, ID: created.ID})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}
