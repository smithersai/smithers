package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// countingEventQuerier wraps mockEventQuerier and records how many times each
// user id is resolved, so we can prove per-request caching of actor lookups.
type countingEventQuerier struct {
	*mockEventQuerier
	getUserFn    func(id int64) (db.User, error)
	getUserCalls map[int64]int
}

func (c *countingEventQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if c.getUserCalls == nil {
		c.getUserCalls = map[int64]int{}
	}
	c.getUserCalls[id]++
	if c.getUserFn != nil {
		return c.getUserFn(id)
	}
	return db.User{ID: id, Username: "user", LowerUsername: "user"}, nil
}

func publicRepoEventQuerier(events []db.IssueEvent) *mockEventQuerier {
	return &mockEventQuerier{
		getRepoFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 10, IsPublic: true}, nil
		},
		getIssueByNumberFn: func(_ context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
			return db.Issue{ID: 100, RepositoryID: 10, Number: arg.Number}, nil
		},
		listIssueEventsFn: func(_ context.Context, _ db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error) {
			return events, nil
		},
	}
}

// A listed event whose actor exists → response carries actor_login.
func TestIssueEventService_ListIssueEvents_ResolvesActorLogin(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{})
	base := publicRepoEventQuerier([]db.IssueEvent{
		{ID: 1, IssueID: 100, ActorID: pgtype.Int8{Int64: 42, Valid: true}, EventType: "closed", Payload: payload, CreatedAt: time.Now()},
	})
	q := &countingEventQuerier{
		mockEventQuerier: base,
		getUserFn: func(id int64) (db.User, error) {
			return db.User{ID: id, Username: "smithersbot", LowerUsername: "smithersbot"}, nil
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.NoError(t, err)
	require.Len(t, items, 1)

	raw, err := json.Marshal(items[0])
	require.NoError(t, err)
	assert.Contains(t, string(raw), `"actor_login":"smithersbot"`,
		"timeline event should serialize a top-level actor_login resolved from the users table; got %s", string(raw))
}

// actor_id null → actor_login empty/omitted (client keeps numeric fallback).
func TestIssueEventService_ListIssueEvents_NullActorNoLogin(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{})
	base := publicRepoEventQuerier([]db.IssueEvent{
		{ID: 1, IssueID: 100, ActorID: pgtype.Int8{}, EventType: "closed", Payload: payload, CreatedAt: time.Now()},
	})
	q := &countingEventQuerier{
		mockEventQuerier: base,
		getUserFn: func(id int64) (db.User, error) {
			t.Fatalf("GetUserByID must not be called for a null actor_id (id=%d)", id)
			return db.User{}, nil
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.NoError(t, err)
	require.Len(t, items, 1)

	raw, err := json.Marshal(items[0])
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "actor_login",
		"a null actor_id must omit actor_login; got %s", string(raw))
}

// Missing/deleted user → actor_login empty/omitted.
func TestIssueEventService_ListIssueEvents_MissingUserNoLogin(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{})
	base := publicRepoEventQuerier([]db.IssueEvent{
		{ID: 1, IssueID: 100, ActorID: pgtype.Int8{Int64: 77, Valid: true}, EventType: "closed", Payload: payload, CreatedAt: time.Now()},
	})
	q := &countingEventQuerier{
		mockEventQuerier: base,
		getUserFn: func(id int64) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.NoError(t, err)
	require.Len(t, items, 1)

	raw, err := json.Marshal(items[0])
	require.NoError(t, err)
	assert.NotContains(t, string(raw), `"actor_login"`,
		"a missing/deleted user must leave actor_login empty; got %s", string(raw))
}

// Repeated actor ids across events → the user lookup runs once per unique id.
func TestIssueEventService_ListIssueEvents_ResolvesActorLoginOncePerUniqueID(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{})
	now := time.Now()
	base := publicRepoEventQuerier([]db.IssueEvent{
		{ID: 1, IssueID: 100, ActorID: pgtype.Int8{Int64: 42, Valid: true}, EventType: "opened", Payload: payload, CreatedAt: now},
		{ID: 2, IssueID: 100, ActorID: pgtype.Int8{Int64: 42, Valid: true}, EventType: "labeled", Payload: payload, CreatedAt: now},
		{ID: 3, IssueID: 100, ActorID: pgtype.Int8{Int64: 7, Valid: true}, EventType: "assigned", Payload: payload, CreatedAt: now},
		{ID: 4, IssueID: 100, ActorID: pgtype.Int8{Int64: 42, Valid: true}, EventType: "closed", Payload: payload, CreatedAt: now},
		{ID: 5, IssueID: 100, ActorID: pgtype.Int8{Int64: 7, Valid: true}, EventType: "reopened", Payload: payload, CreatedAt: now},
	})
	q := &countingEventQuerier{
		mockEventQuerier: base,
		getUserFn: func(id int64) (db.User, error) {
			return db.User{ID: id, Username: "u", LowerUsername: "u"}, nil
		},
	}
	svc := NewIssueEventService(q)
	items, err := svc.ListIssueEvents(context.Background(), nil, "owner", "repo", 1, 1, 30)
	require.NoError(t, err)
	require.Len(t, items, 5)

	// Each event must still resolve its login...
	for _, it := range items {
		raw, err := json.Marshal(it)
		require.NoError(t, err)
		assert.True(t, strings.Contains(string(raw), `"actor_login":"u"`),
			"every event with a resolvable actor should carry actor_login; got %s", string(raw))
	}

	// ...but the DB is hit at most once per unique actor id (2 uniques: 42, 7).
	assert.Equal(t, 1, q.getUserCalls[42], "actor 42 should be looked up exactly once, got %d", q.getUserCalls[42])
	assert.Equal(t, 1, q.getUserCalls[7], "actor 7 should be looked up exactly once, got %d", q.getUserCalls[7])
	assert.Len(t, q.getUserCalls, 2, "only the unique actor ids should be looked up")
}
