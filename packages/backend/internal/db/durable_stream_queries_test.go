package db

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// Wait for an actual PostgreSQL lock waiter, not a timing assumption about how
// fast a goroutine starts. These tests prove ID allocation happens after the
// stream's parent lock, including when the two writers use different tables.
func awaitStreamWriterBlocked(t *testing.T, ctx context.Context, pid uint32) {
	t.Helper()
	require.Eventually(t, func() bool {
		var blocked bool
		err := sharedPool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1)) > 0`, int32(pid)).Scan(&blocked)
		return err == nil && blocked
	}, 3*time.Second, 5*time.Millisecond)
}

func TestDurableNotificationIDsSerializeBeforeAllocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q := New(sharedPool)
	userID := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	tx1, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx1.Rollback(context.Background())
	first, err := New(tx1).CreateNotification(ctx, CreateNotificationParams{UserID: userID, SourceType: "issue", Subject: "first"})
	require.NoError(t, err)
	tx2, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx2.Rollback(context.Background())
	type result struct {
		row Notification
		err error
	}
	done := make(chan result, 1)
	go func() {
		row, err := New(tx2).CreateNotification(ctx, CreateNotificationParams{UserID: userID, SourceType: "issue", Subject: "second"})
		done <- result{row, err}
	}()
	awaitStreamWriterBlocked(t, ctx, tx2.Conn().PgConn().PID())
	var allocated int64
	require.NoError(t, sharedPool.QueryRow(ctx, `SELECT last_value FROM notifications_id_seq`).Scan(&allocated))
	require.Equal(t, first.ID, allocated, "waiting writer must not allocate a cursor before the first writer commits")
	visible, err := q.ListNotificationsAfterID(ctx, ListNotificationsAfterIDParams{UserID: userID, MaxResults: 1000})
	require.NoError(t, err)
	require.Empty(t, visible)
	require.NoError(t, tx1.Commit(ctx))
	second := <-done
	require.NoError(t, second.err)
	require.Greater(t, second.row.ID, first.ID)
	require.NoError(t, tx2.Commit(ctx))
	head, err := q.GetNotificationStreamHead(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, second.row.ID, head)
	visible, err = q.ListNotificationsAfterID(ctx, ListNotificationsAfterIDParams{UserID: userID, AfterID: first.ID, MaxResults: 1000})
	require.NoError(t, err)
	require.Len(t, visible, 1)
	require.Equal(t, second.row.ID, visible[0].ID)
}

func TestDurableWorkflowBothSourcesSerializeAndReplay(t *testing.T) {
	for _, firstIsRun := range []bool{false, true} {
		t.Run(fmt.Sprint("first_run_log=", firstIsRun), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			q := New(sharedPool)
			_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, sharedPool)
			insert := func(tx pgx.Tx, run bool) (int64, error) {
				if run {
					row, err := New(tx).InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "system", Entry: "run log"})
					return row.ID, err
				}
				row, err := New(tx).InsertWorkflowLogNextSequence(ctx, InsertWorkflowLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "stdout", Entry: "step log"})
				return row.ID, err
			}
			tx1, err := sharedPool.Begin(ctx)
			require.NoError(t, err)
			defer tx1.Rollback(context.Background())
			first, err := insert(tx1, firstIsRun)
			require.NoError(t, err)
			tx2, err := sharedPool.Begin(ctx)
			require.NoError(t, err)
			defer tx2.Rollback(context.Background())
			type result struct {
				id  int64
				err error
			}
			done := make(chan result, 1)
			go func() { id, err := insert(tx2, !firstIsRun); done <- result{id, err} }()
			awaitStreamWriterBlocked(t, ctx, tx2.Conn().PgConn().PID())
			var allocated int64
			require.NoError(t, sharedPool.QueryRow(ctx, `SELECT last_value FROM workflow_logs_id_seq`).Scan(&allocated))
			require.Equal(t, first, allocated)
			require.NoError(t, tx1.Commit(ctx))
			second := <-done
			require.NoError(t, second.err)
			require.Greater(t, second.id, first)
			require.NoError(t, tx2.Commit(ctx))
			rows, err := q.ListWorkflowLogsSince(ctx, ListWorkflowLogsSinceParams{RunID: runID, PageSize: 1000})
			require.NoError(t, err)
			require.Len(t, rows, 2)
			require.Equal(t, first, rows[0].ID)
			require.Equal(t, second.id, rows[1].ID)
			require.NotEqual(t, rows[0].Entry, rows[1].Entry)
			head, err := q.GetWorkflowLogStreamHead(ctx, runID)
			require.NoError(t, err)
			require.Equal(t, second.id, head)
		})
	}
}

func TestDurableWorkflowQueryPagesOverBothSourcesWithGaps(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	_, runID, stepID := workflowLogsSQLHCreateFixture(t, q, sharedPool)
	expected := make([]int64, 0, 2105)
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	for index := 0; index < 2105; index++ {
		// Rollback/unrelated-work gaps are legal, not missing stream events.
		_, err = tx.Exec(ctx, `SELECT nextval('workflow_logs_id_seq')`)
		require.NoError(t, err)
		var id int64
		if index%2 == 0 {
			row, insertErr := New(tx).InsertWorkflowLog(ctx, InsertWorkflowLogParams{WorkflowRunID: runID, WorkflowStepID: stepID, Sequence: int64(index + 1), Stream: "stdout", Entry: "step"})
			err = insertErr
			id = row.ID
		} else {
			row, insertErr := New(tx).InsertWorkflowRunLogNextSequence(ctx, InsertWorkflowRunLogNextSequenceParams{WorkflowRunID: runID, WorkflowStepID: stepID, Stream: "system", Entry: "run"})
			err = insertErr
			id = row.ID
		}
		require.NoError(t, err)
		expected = append(expected, id)
	}
	require.NoError(t, tx.Commit(ctx))
	var after int64
	var actual []int64
	for {
		rows, err := q.ListWorkflowLogsSince(ctx, ListWorkflowLogsSinceParams{RunID: runID, AfterID: after, PageSize: 1000})
		require.NoError(t, err)
		for _, row := range rows {
			actual = append(actual, row.ID)
			after = row.ID
		}
		if len(rows) < 1000 {
			break
		}
	}
	require.Equal(t, expected, actual)
}
