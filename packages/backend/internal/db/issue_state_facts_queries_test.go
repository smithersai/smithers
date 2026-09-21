package db

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

func issueStateFixture(t *testing.T) (int64, int64, *Queries) {
	t.Helper()
	user := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	repo := mustCreateRepo(t, sharedPool, user, "issue_state_"+randSlug(t))
	return user, repo, New(sharedPool)
}
func TestIssueStateFactsCaptureLifecycleCascadesAndRollback(t *testing.T) {
	ctx := context.Background()
	user, repo, q := issueStateFixture(t)
	issue, err := q.CreateIssue(ctx, CreateIssueParams{RepositoryID: repo, AuthorID: user, Title: "original", Body: "body"})
	require.NoError(t, err)
	label, err := q.CreateLabel(ctx, CreateLabelParams{RepositoryID: repo, Name: "bug", Color: "red"})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(ctx, AddIssueLabelParams{IssueID: issue.ID, LabelID: label.ID})
	require.NoError(t, err)
	assignee := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	_, err = q.AddIssueAssignee(ctx, AddIssueAssigneeParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: assignee, Valid: true}})
	require.NoError(t, err)
	milestone, err := q.CreateMilestone(ctx, CreateMilestoneParams{RepositoryID: repo, Title: "v1"})
	require.NoError(t, err)
	_, err = sharedPool.Exec(ctx, `UPDATE issues SET title='edited',body='new body',state='closed',closed_at=clock_timestamp(),milestone_id=$2 WHERE id=$1`, issue.ID, milestone.ID)
	require.NoError(t, err)
	require.NoError(t, q.DeleteMilestone(ctx, DeleteMilestoneParams{RepositoryID: repo, ID: milestone.ID}))
	require.NoError(t, q.DeleteLabel(ctx, DeleteLabelParams{RepositoryID: repo, ID: label.ID}))
	_, err = sharedPool.Exec(ctx, `DELETE FROM users WHERE id=$1`, assignee)
	require.NoError(t, err)
	journal, err := q.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(7), journal.Head)
	rows, err := q.ListIssueStateFacts(ctx, ListIssueStateFactsParams{RepositoryID: repo, ThroughSequence: journal.Head, PageSize: 1000})
	require.NoError(t, err)
	require.Len(t, rows, 7)
	require.Equal(t, "issue_assignee", rows[6].EntityType)
	require.Equal(t, "updated", rows[6].Operation)
	require.Contains(t, string(rows[6].PostImage), `"user_id": null`)
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	_, err = New(tx).CreateIssue(ctx, CreateIssueParams{RepositoryID: repo, AuthorID: user, Title: "rollback"})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	journal, err = q.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(7), journal.Head)
	_, err = sharedPool.Exec(ctx, `UPDATE issue_state_facts SET operation='updated' WHERE repository_id=$1`, repo)
	require.ErrorContains(t, err, "append-only")
	_, err = sharedPool.Exec(ctx, `DELETE FROM issues WHERE id=$1`, issue.ID)
	require.NoError(t, err)
	journal, err = q.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(8), journal.Head)
	rows, err = q.ListIssueStateFacts(ctx, ListIssueStateFactsParams{RepositoryID: repo, AfterSequence: 7, ThroughSequence: 8, PageSize: 1000})
	require.NoError(t, err)
	require.Equal(t, "deleted", rows[0].Operation)
	require.Nil(t, rows[0].PostImage)
	mustDurablyDeleteRepoCommittedForTest(t, sharedPool, repo)
	for _, table := range []string{"issue_state_journals", "issue_state_facts"} {
		var count int
		require.NoError(t, sharedPool.QueryRow(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE repository_id=$1", table), repo).Scan(&count))
		require.Zero(t, count)
	}
}
func TestIssueStateFactsSerializeCommittedCounterAndNotify(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user, repo, q := issueStateFixture(t)
	first, err := q.CreateIssue(ctx, CreateIssueParams{RepositoryID: repo, AuthorID: user, Title: "one"})
	require.NoError(t, err)
	second, err := q.CreateIssue(ctx, CreateIssueParams{RepositoryID: repo, AuthorID: user, Title: "two"})
	require.NoError(t, err)
	listener, err := pgx.Connect(ctx, resolveDBTestDatabaseURL(os.Getenv))
	require.NoError(t, err)
	defer listener.Close(ctx)
	_, err = listener.Exec(ctx, fmt.Sprintf("LISTEN issue_state_facts_%d", repo))
	require.NoError(t, err)
	tx1, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx1.Rollback(context.Background())
	_, err = tx1.Exec(ctx, `UPDATE issues SET body='first' WHERE id=$1`, first.ID)
	require.NoError(t, err)
	tx2, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx2.Rollback(context.Background())
	done := make(chan error, 1)
	go func() { _, err := tx2.Exec(ctx, `UPDATE issues SET body='second' WHERE id=$1`, second.ID); done <- err }()
	awaitStreamWriterBlocked(t, ctx, tx2.Conn().PgConn().PID())
	journal, err := q.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(2), journal.Head)
	wait, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	_, err = listener.WaitForNotification(wait)
	stop()
	require.Error(t, err)
	require.NoError(t, tx1.Commit(ctx))
	require.NoError(t, <-done)
	notice, err := listener.WaitForNotification(ctx)
	require.NoError(t, err)
	require.Equal(t, "3", notice.Payload)
	require.NoError(t, tx2.Commit(ctx))
	journal, err = q.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(4), journal.Head)
}
func TestIssueStateFactsMigrationCreatesLegacyMembershipBaseline(t *testing.T) {
	ctx := context.Background()
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	schema := "issue_legacy_" + randSlug(t)
	_, err = tx.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()+`; SET LOCAL search_path TO `+pgx.Identifier{schema}.Sanitize()+`,public`)
	require.NoError(t, err)
	// Minimal pre-migration tables preserve the exact columns needed by seed.
	_, err = tx.Exec(ctx, `CREATE TABLE repositories(id BIGINT PRIMARY KEY);INSERT INTO repositories VALUES(1),(2);CREATE TABLE issues(id BIGINT PRIMARY KEY,repository_id BIGINT,number BIGINT,title TEXT,body TEXT,state TEXT,author_id BIGINT,search_vector TSVECTOR,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);CREATE TABLE issue_labels(issue_id BIGINT,label_id BIGINT,created_at TIMESTAMPTZ);CREATE TABLE issue_assignees(id BIGINT PRIMARY KEY,issue_id BIGINT,user_id BIGINT,created_at TIMESTAMPTZ);INSERT INTO issues VALUES(3,1,1,'old','old body','closed',9,NULL,'2025-06-01T00:00:00Z','2025-06-02T00:00:00Z');INSERT INTO issue_labels VALUES(3,7,'2025-06-01T00:00:00Z');INSERT INTO issue_assignees VALUES(4,3,NULL,'2025-06-01T00:00:00Z')`)
	require.NoError(t, err)
	migration, err := os.ReadFile(filepath.Join(findMigrationsDir(t), "20260914200100_issue_state_facts.sql"))
	require.NoError(t, err)
	_, err = tx.Exec(ctx, string(migration))
	require.NoError(t, err)
	q := New(tx)
	journal, err := q.GetIssueStateJournal(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, "legacy_snapshot", journal.CoverageKind)
	require.Equal(t, int64(3), journal.Head)
	empty, err := q.GetIssueStateJournal(ctx, 2)
	require.NoError(t, err)
	require.Zero(t, empty.Head)
	require.Equal(t, "legacy_snapshot", empty.CoverageKind)
	rows, err := q.ListIssueStateFacts(ctx, ListIssueStateFactsParams{RepositoryID: 1, ThroughSequence: 3, PageSize: 1000})
	require.NoError(t, err)
	for i, row := range rows {
		require.Equal(t, int64(i+1), row.Sequence)
		require.Equal(t, "baseline", row.Operation)
		require.True(t, json.Valid(row.PostImage))
		require.True(t, strings.Contains(string(row.PostImage), "2025-"))
		require.NotContains(t, string(row.PostImage), "search_vector")
	}
}
