package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func issueProjectionFact(seq int64, entity, operation, key string, post any) IssueStateFact {
	var image []byte
	if post != nil {
		image, _ = json.Marshal(post)
	}
	return IssueStateFact{ID: uuid.NewString(), StreamID: "issues:1", Sequence: seq, SchemaVersion: 1, EntityType: entity, Operation: operation, IssueID: 7, EntityKey: key, PostImage: image, RecordedAt: time.Now().UTC()}
}
func TestIssueStateProjectionPureValidationAndDeletion(t *testing.T) {
	now := time.Now().UTC()
	row := db.Issue{ID: 7, RepositoryID: 1, Number: 1, State: "open", Title: "hello", CreatedAt: now, UpdatedAt: now}
	created := issueProjectionFact(1, "issue", "created", "7", row)
	first, err := ApplyIssueStateFact(IssueStateProjection{}, created)
	require.NoError(t, err)
	label := issueProjectionFact(2, "issue_label", "created", "7:9", db.IssueLabel{IssueID: 7, LabelID: 9, CreatedAt: now})
	second, err := ApplyIssueStateFact(first, label)
	require.NoError(t, err)
	require.Empty(t, first.Labels)
	require.Len(t, second.Labels, 1)
	assignment := issueProjectionFact(3, "issue_assignee", "created", "11", db.IssueAssignee{ID: 11, IssueID: 7, UserID: pgtype.Int8{Int64: 3, Valid: true}, CreatedAt: now})
	third, err := ApplyIssueStateFact(second, assignment)
	require.NoError(t, err)
	require.Empty(t, second.Assignees)
	again, err := ApplyIssueStateFact(third, assignment)
	require.NoError(t, err)
	require.Equal(t, third, again)
	bad := assignment
	bad.SchemaVersion = 2
	_, err = ApplyIssueStateFact(third, bad)
	require.Error(t, err)
	bad = assignment
	bad.StreamID = "issues:2"
	_, err = ApplyIssueStateFact(third, bad)
	require.Error(t, err)
	_, err = RebuildIssueStateProjection([]IssueStateFact{created, assignment})
	require.ErrorContains(t, err, "gap")
	final, err := ApplyIssueStateFact(third, issueProjectionFact(4, "issue", "deleted", "7", nil))
	require.NoError(t, err)
	require.Empty(t, final.Issues)
	require.Empty(t, final.Labels)
	require.Empty(t, final.Assignees)
	require.Len(t, third.Issues, 1)
}
func TestIssueStateProjectionMatchesCommittedOwnedRows(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	name := fmt.Sprintf("issue_projection_%d", time.Now().UnixNano())
	var user, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, name).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`, user, name).Scan(&repo))
	label, err := q.CreateLabel(ctx, db.CreateLabelParams{RepositoryID: repo, Name: "bug", Color: "red"})
	require.NoError(t, err)
	milestone, err := q.CreateMilestone(ctx, db.CreateMilestoneParams{RepositoryID: repo, Title: "v1"})
	require.NoError(t, err)
	verifier, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: repo, UserID: user, Title: "verification", Status: "active"})
	require.NoError(t, err)
	for index := 0; index < 25; index++ {
		row, err := q.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: repo, AuthorID: user, Title: fmt.Sprint(index), Body: "original", MilestoneID: pgtype.Int8{Int64: milestone.ID, Valid: true}})
		require.NoError(t, err)
		_, err = q.AddIssueLabel(ctx, db.AddIssueLabelParams{IssueID: row.ID, LabelID: label.ID})
		require.NoError(t, err)
		_, err = q.AddIssueAssignee(ctx, db.AddIssueAssigneeParams{IssueID: row.ID, UserID: pgtype.Int8{Int64: user, Valid: true}})
		require.NoError(t, err)
		_, err = q.CreateIssueComment(ctx, db.CreateIssueCommentParams{IssueID: row.ID, UserID: pgtype.Int8{Int64: user, Valid: true}, Body: "comment", Commenter: "author"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE issues SET title='edited',body='accepted body',state='fixed',closed_at=clock_timestamp(),fixed_at=clock_timestamp(),fixed_by_id=$2 WHERE id=$1`, row.ID, user)
		require.NoError(t, err)
		if index%3 == 0 {
			_, err = pool.Exec(ctx, `UPDATE issues SET state='verified',verified_at=clock_timestamp(),verified_by_id=$2,verified_by_agent_session_id=$3 WHERE id=$1`, row.ID, user, verifier.ID)
			require.NoError(t, err)
		}
		if index%4 == 0 {
			require.NoError(t, q.DeleteIssueAssignees(ctx, row.ID))
		}
		if index%5 == 0 {
			_, err = pool.Exec(ctx, `DELETE FROM issues WHERE id=$1`, row.ID)
			require.NoError(t, err)
		}
	}
	require.NoError(t, q.DeleteMilestone(ctx, db.DeleteMilestoneParams{RepositoryID: repo, ID: milestone.ID}))
	require.NoError(t, q.DeleteLabel(ctx, db.DeleteLabelParams{RepositoryID: repo, ID: label.ID}))
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	snapshot := db.New(tx)
	journal, err := snapshot.GetIssueStateJournal(ctx, repo)
	require.NoError(t, err)
	facts := []IssueStateFact{}
	var cursor int64
	for cursor < journal.Head {
		rows, err := snapshot.ListIssueStateFacts(ctx, db.ListIssueStateFactsParams{RepositoryID: repo, AfterSequence: cursor, ThroughSequence: journal.Head, PageSize: 17})
		require.NoError(t, err)
		require.NotEmpty(t, rows)
		for _, row := range rows {
			fact, err := DecodeIssueStateFact(row)
			require.NoError(t, err)
			facts = append(facts, fact)
			cursor = fact.Sequence
		}
	}
	projection, err := RebuildIssueStateProjection(facts)
	require.NoError(t, err)
	require.Equal(t, journal.Head, projection.Cursor)
	// Compare canonical JSON for every stored owned row. Search vector is an
	// explicit derived index, omitted on both sides; user/label joins are not here.
	for _, test := range []struct {
		entity string
		query  string
		images map[string]json.RawMessage
	}{
		{"issue", `SELECT id::TEXT,to_jsonb(i)-'search_vector' FROM issues i WHERE repository_id=$1`, map[string]json.RawMessage{}},
		{"label", `SELECT il.issue_id::TEXT || ':' || il.label_id::TEXT,to_jsonb(il) FROM issue_labels il JOIN issues i ON i.id=il.issue_id WHERE i.repository_id=$1`, map[string]json.RawMessage{}},
		{"assignee", `SELECT ia.id::TEXT,to_jsonb(ia) FROM issue_assignees ia JOIN issues i ON i.id=ia.issue_id WHERE i.repository_id=$1`, map[string]json.RawMessage{}},
	} {
		rows, err := tx.Query(ctx, test.query, repo)
		require.NoError(t, err)
		for rows.Next() {
			var key string
			var raw []byte
			require.NoError(t, rows.Scan(&key, &raw))
			test.images[key] = raw
		}
		require.NoError(t, rows.Err())
		rows.Close()
		actual := map[string]any{}
		switch test.entity {
		case "issue":
			for k, v := range projection.Issues {
				actual[fmt.Sprint(k)] = v
			}
		case "label":
			for k, v := range projection.Labels {
				actual[k] = v
			}
		default:
			for k, v := range projection.Assignees {
				actual[fmt.Sprint(k)] = v
			}
		}
		require.Len(t, actual, len(test.images))
		for key, expected := range test.images {
			encoded, err := json.Marshal(actual[key])
			require.NoError(t, err)
			require.Equal(t, canonicalIssueProjectionJSON(t, expected), canonicalIssueProjectionJSON(t, encoded))
		}
	}
}

func canonicalIssueProjectionJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var result map[string]any
	require.NoError(t, json.Unmarshal(raw, &result))
	for key, value := range result {
		if text, ok := value.(string); ok {
			if timestamp, err := time.Parse(time.RFC3339Nano, text); err == nil {
				result[key] = timestamp.UTC().Format(time.RFC3339Nano)
			}
		}
	}
	return result
}
