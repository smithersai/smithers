package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIssueChangeLinks_LandingFixesAndRecordsEventOnce(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "issue-link-fixer")
	repoID := mustCreateRepo(t, pool, userID, "issue-link-repo")
	issue, err := q.CreateIssue(ctx, CreateIssueParams{
		RepositoryID: repoID, Title: "linked bug", AuthorID: userID, MilestoneID: pgtype.Int8{},
	})
	require.NoError(t, err)
	_, err = q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "change-1", CommitID: "commit-1",
		Description: "fix\n\nCloses #1", ParentChangeIds: json.RawMessage(`[]`),
	})
	require.NoError(t, err)
	require.NoError(t, q.CreateIssueChangeLink(ctx, CreateIssueChangeLinkParams{
		RepositoryID: repoID, ChangeID: "change-1", LinkType: "closes", IssueNumber: issue.Number,
	}))

	issueLinks, err := q.ListLinkedChangesForIssue(ctx, issue.ID)
	require.NoError(t, err)
	require.Len(t, issueLinks, 1)
	assert.Equal(t, "change-1", issueLinks[0].ChangeID)
	changeLinks, err := q.ListLinkedIssuesForChange(ctx, ListLinkedIssuesForChangeParams{RepositoryID: repoID, ChangeID: "change-1"})
	require.NoError(t, err)
	require.Len(t, changeLinks, 1)
	assert.Equal(t, issue.Number, changeLinks[0].Number)

	landing, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land fix", AuthorID: userID, TargetBookmark: "main", StackSize: 1,
	})
	require.NoError(t, err)
	_, err = q.AddLandingRequestChange(ctx, AddLandingRequestChangeParams{
		LandingRequestID: landing.ID, ChangeID: "change-1", PositionInStack: 1,
	})
	require.NoError(t, err)

	fixed, err := q.FixIssuesForLanding(ctx, FixIssuesForLandingParams{
		LandingRequestID: landing.ID, FixedByID: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{issue.ID}, fixed)
	got, err := q.GetIssueByID(ctx, issue.ID)
	require.NoError(t, err)
	assert.Equal(t, "fixed", got.State)
	assert.Equal(t, userID, got.FixedByID.Int64)
	assert.True(t, got.FixedAt.Valid)

	events, err := q.ListIssueEventsByIssue(ctx, ListIssueEventsByIssueParams{IssueID: issue.ID, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, events, 1)
	assert.Equal(t, "fixed", events[0].EventType)
	assert.Contains(t, string(events[0].Payload), `"linked_changes": ["change-1"]`)

	fixed, err = q.FixIssuesForLanding(ctx, FixIssuesForLandingParams{
		LandingRequestID: landing.ID, FixedByID: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Empty(t, fixed)
	events, err = q.ListIssueEventsByIssue(ctx, ListIssueEventsByIssueParams{IssueID: issue.ID, PageSize: 10})
	require.NoError(t, err)
	assert.Len(t, events, 1)
}

func TestCreateIssue_AssignsRepoScopedNumber(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-author")
	repoID := mustCreateRepo(t, pool, userID, "issue-repo")

	first, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "First issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), first.Number)

	second, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "Second issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), second.Number)

	got, err := q.GetIssueByNumber(context.Background(), GetIssueByNumberParams{RepositoryID: repoID, Number: 2})
	require.NoError(t, err)
	assert.Equal(t, second.ID, got.ID)
}

func TestCreateIssue_WithMilestoneID(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-milestone-author")
	repoID := mustCreateRepo(t, pool, userID, "issue-milestone-repo")
	milestone, err := q.CreateMilestone(context.Background(), CreateMilestoneParams{
		RepositoryID: repoID,
		Title:        "v1",
		Description:  "first milestone",
		DueDate:      pgtype.Timestamptz{},
	})
	require.NoError(t, err)

	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "Issue with milestone",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{Int64: milestone.ID, Valid: true},
	})
	require.NoError(t, err)
	require.True(t, issue.MilestoneID.Valid)
	assert.Equal(t, milestone.ID, issue.MilestoneID.Int64)
}

func TestListIssuesByRepoFiltered_StateAndPagination(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-list-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-list-repo")

	for idx, title := range []string{"one", "two", "three"} {
		created, err := q.CreateIssue(context.Background(), CreateIssueParams{
			RepositoryID: repoID,
			Title:        title,
			Body:         "",
			AuthorID:     userID,
			MilestoneID:  pgtype.Int8{},
		})
		require.NoError(t, err)
		if idx == 2 {
			_, err = q.UpdateIssue(context.Background(), UpdateIssueParams{
				ID:          created.ID,
				Title:       created.Title,
				Body:        created.Body,
				State:       "closed",
				MilestoneID: created.MilestoneID,
				ClosedAt:    pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
			})
			require.NoError(t, err)
		}
	}

	totalAll, err := q.CountIssuesByRepoFiltered(context.Background(), CountIssuesByRepoFilteredParams{RepositoryID: repoID, State: ""})
	require.NoError(t, err)
	assert.Equal(t, int64(3), totalAll)

	totalOpen, err := q.CountIssuesByRepoFiltered(context.Background(), CountIssuesByRepoFilteredParams{RepositoryID: repoID, State: "open"})
	require.NoError(t, err)
	assert.Equal(t, int64(2), totalOpen)

	totalClosed, err := q.CountIssuesByRepoFiltered(context.Background(), CountIssuesByRepoFilteredParams{RepositoryID: repoID, State: "closed"})
	require.NoError(t, err)
	assert.Equal(t, int64(1), totalClosed)

	openRows, err := q.ListIssuesByRepoFiltered(context.Background(), ListIssuesByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "open",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, openRows, 2)
	assert.Equal(t, int64(2), openRows[0].Number)
	assert.Equal(t, int64(1), openRows[1].Number)

	closedRows, err := q.ListIssuesByRepoFiltered(context.Background(), ListIssuesByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "closed",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, closedRows, 1)
	assert.Equal(t, int64(3), closedRows[0].Number)

	page, err := q.ListIssuesByRepoFiltered(context.Background(), ListIssuesByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "",
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, int64(2), page[0].Number)
}

func TestUpdateIssue_UpdatesFieldsAndClosedAt(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-update-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-update-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "old title",
		Body:         "old body",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	closedAt := pgtype.Timestamptz{Time: time.Now().UTC().Truncate(time.Second), Valid: true}
	updated, err := q.UpdateIssue(context.Background(), UpdateIssueParams{
		ID:          issue.ID,
		Title:       "new title",
		Body:        "new body",
		State:       "closed",
		MilestoneID: issue.MilestoneID,
		ClosedAt:    closedAt,
	})
	require.NoError(t, err)
	assert.Equal(t, "new title", updated.Title)
	assert.Equal(t, "new body", updated.Body)
	assert.Equal(t, "closed", updated.State)
	require.True(t, updated.ClosedAt.Valid)
	assert.WithinDuration(t, closedAt.Time, updated.ClosedAt.Time, time.Second)

	reopened, err := q.UpdateIssue(context.Background(), UpdateIssueParams{
		ID:          updated.ID,
		Title:       updated.Title,
		Body:        updated.Body,
		State:       "open",
		MilestoneID: updated.MilestoneID,
		ClosedAt:    pgtype.Timestamptz{},
	})
	require.NoError(t, err)
	assert.Equal(t, "open", reopened.State)
	assert.False(t, reopened.ClosedAt.Valid)
	assert.True(t, reopened.UpdatedAt.After(updated.UpdatedAt) || reopened.UpdatedAt.Equal(updated.UpdatedAt))
}

func TestIssueAssignees_AddListDelete(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "issue-assignee-author")
	assigneeID := mustCreateUser(t, pool, "issue-assignee-user")
	repoID := mustCreateRepo(t, pool, authorID, "issue-assignee-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "assignees",
		Body:         "",
		AuthorID:     authorID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	_, err = q.AddIssueAssignee(context.Background(), AddIssueAssigneeParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: assigneeID, Valid: true}})
	require.NoError(t, err)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.AddIssueAssignee(context.Background(), AddIssueAssigneeParams{IssueID: issue.ID, UserID: pgtype.Int8{Int64: assigneeID, Valid: true}})
		return err
	})

	assignees, err := q.ListIssueAssignees(context.Background(), issue.ID)
	require.NoError(t, err)
	require.Len(t, assignees, 1)
	assert.Equal(t, assigneeID, assignees[0].ID)

	err = q.DeleteIssueAssignees(context.Background(), issue.ID)
	require.NoError(t, err)

	assignees, err = q.ListIssueAssignees(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Len(t, assignees, 0)
}

func TestIssueComments_CRUDAndCounts(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-comment-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-comment-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "Need comments",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	created, err := q.CreateIssueComment(context.Background(), CreateIssueCommentParams{
		IssueID:   issue.ID,
		UserID:    pgtype.Int8{Int64: userID, Valid: true},
		Body:      "first",
		Commenter: "author",
	})
	require.NoError(t, err)

	count, err := q.CountIssueCommentsByIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)

	got, err := q.GetIssueCommentByID(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)

	updated, err := q.UpdateIssueComment(context.Background(), UpdateIssueCommentParams{ID: created.ID, Body: "edited"})
	require.NoError(t, err)
	assert.Equal(t, "edited", updated.Body)
	assert.True(t, updated.UpdatedAt.After(created.UpdatedAt) || updated.UpdatedAt.Equal(created.UpdatedAt))

	rows, err := q.ListIssueComments(context.Background(), ListIssueCommentsParams{
		IssueID:    issue.ID,
		PageOffset: 0,
		PageSize:   10,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, created.ID, rows[0].ID)

	err = q.DeleteIssueComment(context.Background(), created.ID)
	require.NoError(t, err)

	count, err = q.CountIssueCommentsByIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), count)
}

func TestIssueEvents_CreateIssueEvent_PersistsAllFields(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-event-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-event-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "timeline issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	payload := []byte(`{"type":"state_changed","before":"open","after":"closed"}`)
	created, err := q.CreateIssueEvent(context.Background(), CreateIssueEventParams{
		IssueID:   issue.ID,
		ActorID:   pgtype.Int8{Int64: userID, Valid: true},
		EventType: "state_changed",
		Payload:   payload,
	})
	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.Equal(t, issue.ID, created.IssueID)
	require.True(t, created.ActorID.Valid)
	assert.Equal(t, userID, created.ActorID.Int64)
	assert.Equal(t, "state_changed", created.EventType)
	assert.JSONEq(t, string(payload), string(created.Payload))
	assert.False(t, created.CreatedAt.IsZero())

	systemPayload := []byte(`{"type":"sync","meta":{"source":"linear"}}`)
	systemEvent, err := q.CreateIssueEvent(context.Background(), CreateIssueEventParams{
		IssueID:   issue.ID,
		ActorID:   pgtype.Int8{},
		EventType: "sync",
		Payload:   systemPayload,
	})
	require.NoError(t, err)
	assert.Equal(t, issue.ID, systemEvent.IssueID)
	assert.False(t, systemEvent.ActorID.Valid)
	assert.Equal(t, "sync", systemEvent.EventType)
	assert.JSONEq(t, string(systemPayload), string(systemEvent.Payload))

	var count int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM issue_events WHERE issue_id = $1`, issue.ID).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}

func TestIssueEvents_ListIssueEventsByIssue_OrderedAndPaginated(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-event-list-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-event-list-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "timeline issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	otherIssue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "other issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	createEvent := func(issueID int64, eventType string, payload string) IssueEvent {
		t.Helper()

		event, createErr := q.CreateIssueEvent(context.Background(), CreateIssueEventParams{
			IssueID:   issueID,
			ActorID:   pgtype.Int8{Int64: userID, Valid: true},
			EventType: eventType,
			Payload:   []byte(payload),
		})
		require.NoError(t, createErr)
		return event
	}

	first := createEvent(issue.ID, "created", `{"position":1}`)
	second := createEvent(issue.ID, "commented", `{"position":2}`)
	third := createEvent(issue.ID, "closed", `{"position":3}`)
	_ = createEvent(otherIssue.ID, "created", `{"position":99}`)

	base := time.Now().UTC().Truncate(time.Second)
	mustExec(t, pool, `UPDATE issue_events SET created_at = $2 WHERE id = $1`, first.ID, base)
	mustExec(t, pool, `UPDATE issue_events SET created_at = $2 WHERE id = $1`, second.ID, base)
	mustExec(t, pool, `UPDATE issue_events SET created_at = $2 WHERE id = $1`, third.ID, base.Add(time.Minute))

	events, err := q.ListIssueEventsByIssue(context.Background(), ListIssueEventsByIssueParams{
		IssueID:    issue.ID,
		PageOffset: 0,
		PageSize:   10,
	})
	require.NoError(t, err)
	require.Len(t, events, 3)
	assert.Equal(t, []int64{first.ID, second.ID, third.ID}, []int64{events[0].ID, events[1].ID, events[2].ID})
	assert.Equal(t, []string{"created", "commented", "closed"}, []string{events[0].EventType, events[1].EventType, events[2].EventType})
	assert.WithinDuration(t, base, events[0].CreatedAt, time.Second)
	assert.WithinDuration(t, base, events[1].CreatedAt, time.Second)
	assert.WithinDuration(t, base.Add(time.Minute), events[2].CreatedAt, time.Second)

	page, err := q.ListIssueEventsByIssue(context.Background(), ListIssueEventsByIssueParams{
		IssueID:    issue.ID,
		PageOffset: 1,
		PageSize:   1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, second.ID, page[0].ID)
}

// TestIssueAndRepoCounters_Mutations verifies the trigger-maintained
// denormalized counters (trg_issues_repo_counts_*, trg_issue_comments_count_*):
// they must track actual row transitions exactly once, including no-op writes
// that previously double-counted under application-side check-then-increment.
func TestIssueAndRepoCounters_Mutations(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-counter-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-counter-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "counter",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	repoCounts := func() (numIssues, numClosed int64) {
		t.Helper()
		err := pool.QueryRow(context.Background(), `SELECT num_issues, num_closed_issues FROM repositories WHERE id = $1`, repoID).Scan(&numIssues, &numClosed)
		require.NoError(t, err)
		return numIssues, numClosed
	}

	numIssues, numClosed := repoCounts()
	assert.Equal(t, int64(1), numIssues, "CreateIssue must increment num_issues via trigger")
	assert.Equal(t, int64(0), numClosed)

	// Closing the issue transitions open -> closed exactly once.
	closeIssue := func() {
		t.Helper()
		_, err := q.UpdateIssue(context.Background(), UpdateIssueParams{
			ID:          issue.ID,
			Title:       issue.Title,
			Body:        issue.Body,
			State:       "closed",
			MilestoneID: pgtype.Int8{},
			ClosedAt:    pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		})
		require.NoError(t, err)
	}
	closeIssue()
	_, numClosed = repoCounts()
	assert.Equal(t, int64(1), numClosed)

	// A redundant close (same state) must not fire the transition trigger.
	closeIssue()
	_, numClosed = repoCounts()
	assert.Equal(t, int64(1), numClosed, "no-op close must not double-count")

	_, err = q.UpdateIssue(context.Background(), UpdateIssueParams{
		ID:          issue.ID,
		Title:       issue.Title,
		Body:        issue.Body,
		State:       "open",
		MilestoneID: pgtype.Int8{},
		ClosedAt:    pgtype.Timestamptz{},
	})
	require.NoError(t, err)
	_, numClosed = repoCounts()
	assert.Equal(t, int64(0), numClosed)

	commentCount := func() (count int64) {
		t.Helper()
		err := pool.QueryRow(context.Background(), `SELECT comment_count FROM issues WHERE id = $1`, issue.ID).Scan(&count)
		require.NoError(t, err)
		return count
	}

	comment, err := q.CreateIssueComment(context.Background(), CreateIssueCommentParams{
		IssueID:   issue.ID,
		UserID:    pgtype.Int8{Int64: userID, Valid: true},
		Body:      "counted",
		Commenter: "issue-counter-user",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), commentCount())

	require.NoError(t, q.DeleteIssueComment(context.Background(), comment.ID))
	assert.Equal(t, int64(0), commentCount())

	// Deleting an already-deleted comment removes no row and must not
	// decrement again (GREATEST floor plus row-level trigger semantics).
	require.NoError(t, q.DeleteIssueComment(context.Background(), comment.ID))
	assert.Equal(t, int64(0), commentCount())
}

func TestGetIssueByID_ReturnsIssueByPrimaryKey(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-byid-author")
	repoID := mustCreateRepo(t, pool, userID, "issue-byid-repo")

	created, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "Get by ID",
		Body:         "body",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	got, err := q.GetIssueByID(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "Get by ID", got.Title)

	// Non-existent ID.
	_, err = q.GetIssueByID(context.Background(), 999999)
	require.Error(t, err)
}

func TestGetIssueByCommentID_ReturnsParentIssue(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-comment-lookup-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-comment-lookup-repo")

	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "parent issue",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	comment, err := q.CreateIssueComment(context.Background(), CreateIssueCommentParams{
		IssueID:   issue.ID,
		UserID:    pgtype.Int8{Int64: userID, Valid: true},
		Body:      "test comment",
		Commenter: "user",
	})
	require.NoError(t, err)

	got, err := q.GetIssueByCommentID(context.Background(), comment.ID)
	require.NoError(t, err)
	assert.Equal(t, issue.ID, got.ID)
	assert.Equal(t, "parent issue", got.Title)
}

func TestAddIssueLabel_UniqueConstraint(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-label-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-label-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "label me",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	label, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "bug",
		Color:        "#ff0000",
		Description:  "",
	})
	require.NoError(t, err)

	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: issue.ID, LabelID: label.ID})
	require.NoError(t, err)

	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: issue.ID, LabelID: label.ID})
	require.Error(t, err)
}

func TestDeleteIssueLabels_RemovesAllIssueLabels(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "issue-delete-labels-user")
	repoID := mustCreateRepo(t, pool, userID, "issue-delete-labels-repo")
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "has labels",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

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

	err = q.AddIssueLabels(context.Background(), AddIssueLabelsParams{
		IssueID:  issue.ID,
		LabelIds: []int64{bug.ID, docs.ID},
	})
	require.NoError(t, err)

	err = q.DeleteIssueLabels(context.Background(), issue.ID)
	require.NoError(t, err)

	count, err := q.CountLabelsForIssue(context.Background(), issue.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), count)
}
