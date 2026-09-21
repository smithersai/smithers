package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type searchSQLHDB = chunk5SQLHDB
type searchSQLHRows = chunk5SQLHRows

func TestSearchSQL_H_FTSRoundTripAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	term := "needle" + randSlug(t)
	ownerID := mustCreateUser(t, pool, "owner"+randSlug(t))
	viewerID := ownerID
	repoName := "repo" + randSlug(t)
	repo, err := q.CreateRepo(ctx, CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            repoName,
		LowerName:       strings.ToLower(repoName),
		Description:     "repository " + term,
		StorageSetID:    "s1",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)
	doc, err := q.UpsertCodeSearchDocument(ctx, UpsertCodeSearchDocumentParams{RepositoryID: repo.ID, FilePath: "cmd/main.go", Content: "package main " + term})
	require.NoError(t, err)
	assert.Equal(t, "cmd/main.go", doc.FilePath)
	issue := mustCreateIssue(t, q, repo.ID, ownerID, "issue "+term)
	assigneeName := "assignee" + randSlug(t)
	assigneeID := mustCreateUser(t, pool, assigneeName)
	label, err := q.CreateLabel(ctx, CreateLabelParams{RepositoryID: repo.ID, Name: "search-label", Color: "00aa00", Description: ""})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(ctx, AddIssueLabelParams{IssueID: issue.ID, LabelID: label.ID})
	require.NoError(t, err)
	_, err = q.AddIssueAssignee(ctx, AddIssueAssigneeParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: assigneeID, Valid: true}})
	require.NoError(t, err)

	codeRows, err := q.SearchCodeFTS(ctx, SearchCodeFTSParams{Query: term, PageOffset: 0, PageSize: 10, ViewerID: viewerID})
	require.NoError(t, err)
	require.Len(t, codeRows, 1)
	assert.Equal(t, repo.ID, codeRows[0].RepositoryID)
	issueRows, err := q.SearchIssuesFTS(ctx, SearchIssuesFTSParams{
		Query: term, StateFilter: "open", LabelFilter: "search-label", AssigneeFilter: assigneeName, PageOffset: 0, PageSize: 10, ViewerID: viewerID,
	})
	require.NoError(t, err)
	require.Len(t, issueRows, 1)
	assert.Equal(t, issue.ID, issueRows[0].ID)
	repoRows, err := q.SearchRepositoriesFTS(ctx, SearchRepositoriesFTSParams{Query: term, PageOffset: 0, PageSize: 10, ViewerID: viewerID})
	require.NoError(t, err)
	require.Len(t, repoRows, 1)
	assert.Equal(t, repo.ID, repoRows[0].ID)
	userRows, err := q.SearchUsersFTS(ctx, SearchUsersFTSParams{Query: "owner", PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.NotEmpty(t, userRows)

	deleted, err := q.DeleteCodeSearchDocumentsByRepo(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	codeRows, err = q.SearchCodeFTS(ctx, SearchCodeFTSParams{Query: term, PageOffset: 0, PageSize: 10, ViewerID: viewerID})
	require.NoError(t, err)
	assert.Empty(t, codeRows)
}

func TestSearchSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("search h failed")
	listCases := []struct {
		name string
		call func(*Queries) error
	}{
		{"SearchCodeFTS", func(q *Queries) error {
			_, err := q.SearchCodeFTS(context.Background(), SearchCodeFTSParams{Query: "x", PageSize: 1})
			return err
		}},
		{"SearchIssuesFTS", func(q *Queries) error {
			_, err := q.SearchIssuesFTS(context.Background(), SearchIssuesFTSParams{Query: "x", PageSize: 1})
			return err
		}},
		{"SearchRepositoriesFTS", func(q *Queries) error {
			_, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{Query: "x", PageSize: 1})
			return err
		}},
		{"SearchUsersFTS", func(q *Queries) error {
			_, err := q.SearchUsersFTS(context.Background(), SearchUsersFTSParams{Query: "x", PageSize: 1})
			return err
		}},
	}
	for _, tc := range listCases {
		require.ErrorIs(t, tc.call(New(searchSQLHDB{queryErr: sentinel})), sentinel, tc.name+" query")
		require.ErrorIs(t, tc.call(New(searchSQLHDB{rows: &searchSQLHRows{next: true, scanErr: sentinel}})), sentinel, tc.name+" scan")
		require.ErrorIs(t, tc.call(New(searchSQLHDB{rows: &searchSQLHRows{err: sentinel}})), sentinel, tc.name+" rows")
	}
	_, err := New(searchSQLHDB{execErr: sentinel}).DeleteCodeSearchDocumentsByRepo(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)
}
