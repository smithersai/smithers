package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mentionsSQLHDB = chunk5SQLHDB
type mentionsSQLHRow = chunk5SQLHRow
type mentionsSQLHRows = chunk5SQLHRows

func TestMentionsSQL_H_CreateCountListAndDelete(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	actorID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	mentionedID := mustCreateUser(t, pool, uniqueTestUsername(t))
	issue := mustCreateIssue(t, q, repoID, actorID, "mentions h")
	comment, err := q.CreateIssueComment(ctx, CreateIssueCommentParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: actorID, Valid: true}, Body: "@user", Commenter: "actor"})
	require.NoError(t, err)

	params := CreateMentionParams{
		RepositoryID: repoID, IssueID: pgtype.Int8{Int64: issue.ID, Valid: true}, CommentType: "issue_comment",
		CommentID: pgtype.Int8{Int64: comment.ID, Valid: true}, UserID: pgtype.Int8{Int64: actorID, Valid: true},
		MentionedUserID: pgtype.Int8{Int64: mentionedID, Valid: true},
	}
	mention, err := q.CreateMention(ctx, params)
	require.NoError(t, err)
	assert.Equal(t, mentionedID, mention.MentionedUserID.Int64)
	count, err := q.CountMentionsForUser(ctx, pgtype.Int8{Int64: mentionedID, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
	mentions, err := q.ListMentionsForUser(ctx, ListMentionsForUserParams{MentionedUserID: pgtype.Int8{Int64: mentionedID, Valid: true}, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, mentions, 1)
	assert.Equal(t, mention.ID, mentions[0].ID)
	_, err = q.CreateMention(ctx, params)
	require.ErrorIs(t, err, pgx.ErrNoRows)

	require.NoError(t, q.DeleteMentionsForComment(ctx, DeleteMentionsForCommentParams{CommentType: "issue_comment", CommentID: pgtype.Int8{Int64: comment.ID, Valid: true}}))
	count, err = q.CountMentionsForUser(ctx, pgtype.Int8{Int64: mentionedID, Valid: true})
	require.NoError(t, err)
	assert.Zero(t, count)
	mentions, err = q.ListMentionsForUser(ctx, ListMentionsForUserParams{MentionedUserID: pgtype.Int8{Int64: mentionedID, Valid: true}, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, mentions)

	_ = mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateMention(ctx, CreateMentionParams{
			RepositoryID: repoID, IssueID: pgtype.Int8{Int64: issue.ID, Valid: true}, CommentType: "bad", MentionedUserID: pgtype.Int8{Int64: mentionedID, Valid: true},
		})
		return err
	})
}

func TestMentionsSQL_H_ErrorBranches(t *testing.T) {
	sentinel := errors.New("mentions h failed")
	callList := func(q *Queries) error {
		_, err := q.ListMentionsForUser(context.Background(), ListMentionsForUserParams{MentionedUserID: pgtype.Int8{Int64: 1, Valid: true}, PageSize: 1})
		return err
	}
	require.ErrorIs(t, callList(New(mentionsSQLHDB{queryErr: sentinel})), sentinel)
	require.ErrorIs(t, callList(New(mentionsSQLHDB{rows: &mentionsSQLHRows{next: true, scanErr: sentinel}})), sentinel)
	require.ErrorIs(t, callList(New(mentionsSQLHDB{rows: &mentionsSQLHRows{err: sentinel}})), sentinel)

	rowQ := New(mentionsSQLHDB{row: mentionsSQLHRow{err: sentinel}})
	_, err := rowQ.CountMentionsForUser(context.Background(), pgtype.Int8{})
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CreateMention(context.Background(), CreateMentionParams{})
	require.ErrorIs(t, err, sentinel)
	require.ErrorIs(t, New(mentionsSQLHDB{execErr: sentinel}).DeleteMentionsForComment(context.Background(), DeleteMentionsForCommentParams{}), sentinel)
}
