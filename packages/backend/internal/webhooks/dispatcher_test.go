package webhooks

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// dispatcherSuite is this test binary's own product database.
var dispatcherSuite = postgresfixture.Suite{MaxConns: 5}

func TestMain(m *testing.M) {
	os.Exit(dispatcherSuite.Run(m))
}

type mockDispatcherStore struct {
	listFn   func(ctx context.Context, repositoryID int64) ([]db.Webhook, error)
	createFn func(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error)

	lastRepositoryID int64
	createCalls      []db.CreateWebhookDeliveryParams
}

func (m *mockDispatcherStore) ListActiveWebhooksByRepo(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
	m.lastRepositoryID = repositoryID
	if m.listFn != nil {
		return m.listFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockDispatcherStore) ListActiveWebhooksByOrg(ctx context.Context, orgID int64) ([]db.Webhook, error) {
	return nil, nil
}

func (m *mockDispatcherStore) CreateWebhookDelivery(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
	m.createCalls = append(m.createCalls, arg)
	if m.createFn != nil {
		return m.createFn(ctx, arg)
	}
	return db.WebhookDelivery{ID: int64(len(m.createCalls))}, nil
}

func TestDispatchEvent_CreatesDeliveriesForSubscribedHooks(t *testing.T) {
	store := &mockDispatcherStore{
		listFn: func(_ context.Context, repositoryID int64) ([]db.Webhook, error) {
			require.Equal(t, int64(77), repositoryID)
			return []db.Webhook{
				{ID: 1, RepositoryID: 77, IsActive: true, Events: []string{"issues"}},
				{ID: 2, RepositoryID: 77, IsActive: true, Events: []string{"landing_request"}},
				{ID: 3, RepositoryID: 77, IsActive: false, Events: []string{"issues"}},
				{ID: 4, RepositoryID: 77, IsActive: true, Events: []string{"all"}},
			}, nil
		},
	}

	dispatcher := NewDispatcher(store)
	err := dispatcher.DispatchEvent(context.Background(), 77, EventTypeIssues, map[string]string{"action": "opened"})
	require.NoError(t, err)

	require.Len(t, store.createCalls, 2)
	assert.Equal(t, int64(1), store.createCalls[0].WebhookID)
	assert.Equal(t, int64(4), store.createCalls[1].WebhookID)
	assert.Equal(t, string(EventTypeIssues), store.createCalls[0].EventType)
	assert.Equal(t, "pending", store.createCalls[0].Status)

	var firstPayload map[string]string
	require.NoError(t, json.Unmarshal(store.createCalls[0].Payload, &firstPayload))
	assert.Equal(t, "opened", firstPayload["action"])
}

func TestDispatchEvent_ReturnsErrorWhenPayloadMarshalFails(t *testing.T) {
	store := &mockDispatcherStore{
		listFn: func(_ context.Context, repositoryID int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, RepositoryID: repositoryID, IsActive: true, Events: []string{"issues"}}}, nil
		},
	}

	dispatcher := NewDispatcher(store)
	err := dispatcher.DispatchEvent(context.Background(), 77, EventTypeIssues, map[string]any{"bad": make(chan int)})
	require.Error(t, err)
	require.Len(t, store.createCalls, 0)
}

func TestDispatchEvent_PropagatesCreateDeliveryError(t *testing.T) {
	store := &mockDispatcherStore{
		listFn: func(_ context.Context, repositoryID int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, RepositoryID: repositoryID, IsActive: true, Events: []string{"issues"}}}, nil
		},
		createFn: func(_ context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
			return db.WebhookDelivery{}, assert.AnError
		},
	}

	dispatcher := NewDispatcher(store)
	err := dispatcher.DispatchEvent(context.Background(), 77, EventTypeIssues, map[string]string{"action": "opened"})
	require.ErrorIs(t, err, assert.AnError)
}

func TestDispatchEvent_RejectsZeroRepoID(t *testing.T) {
	t.Parallel()

	store := &mockDispatcherStore{}
	dispatcher := NewDispatcher(store)
	err := dispatcher.DispatchEvent(context.Background(), 0, EventTypeIssues, map[string]string{"action": "opened"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid repository id")
	assert.Empty(t, store.createCalls)
}

func TestIsSubscribedToEvent_WildcardAsterisk(t *testing.T) {
	t.Parallel()

	assert.True(t, isSubscribedToEvent([]string{"*"}, "push"))
	assert.True(t, isSubscribedToEvent([]string{"*"}, "issues"))
	assert.True(t, isSubscribedToEvent([]string{"*"}, "landing_request"))
}

func TestIsSubscribedToEvent_AllKeyword(t *testing.T) {
	t.Parallel()

	assert.True(t, isSubscribedToEvent([]string{"all"}, "push"))
	assert.True(t, isSubscribedToEvent([]string{"ALL"}, "issues"))
	assert.True(t, isSubscribedToEvent([]string{"All"}, "star"))
}

func TestIsSubscribedToEvent_CaseInsensitiveExactMatch(t *testing.T) {
	t.Parallel()

	assert.True(t, isSubscribedToEvent([]string{"ISSUES"}, "issues"))
	assert.True(t, isSubscribedToEvent([]string{"Issues"}, "issues"))
	assert.True(t, isSubscribedToEvent([]string{"  issues  "}, "issues"))
}

func TestIsSubscribedToEvent_LandingConflict(t *testing.T) {
	t.Parallel()

	assert.True(t, isSubscribedToEvent([]string{"landing.conflict"}, "landing.conflict"))
	assert.True(t, isSubscribedToEvent([]string{" LANDING.CONFLICT "}, "landing.conflict"))
	assert.False(t, isSubscribedToEvent([]string{"landing_request"}, "landing.conflict"))
}

func TestIsSubscribedToEvent_NoMatchReturnsfalse(t *testing.T) {
	t.Parallel()

	assert.False(t, isSubscribedToEvent([]string{"push"}, "issues"))
	assert.False(t, isSubscribedToEvent([]string{}, "issues"))
	assert.False(t, isSubscribedToEvent(nil, "issues"))
	assert.False(t, isSubscribedToEvent([]string{"issues"}, ""))
}

func TestDispatchEvent_SkipsInactiveHookEvenIfSubscribed(t *testing.T) {
	t.Parallel()

	store := &mockDispatcherStore{
		listFn: func(_ context.Context, repositoryID int64) ([]db.Webhook, error) {
			return []db.Webhook{
				{ID: 1, RepositoryID: repositoryID, IsActive: false, Events: []string{"*"}},
				{ID: 2, RepositoryID: repositoryID, IsActive: false, Events: []string{"all"}},
			}, nil
		},
	}

	dispatcher := NewDispatcher(store)
	err := dispatcher.DispatchEvent(context.Background(), 5, EventTypePush, map[string]string{"ref": "refs/heads/main"})
	require.NoError(t, err)
	assert.Empty(t, store.createCalls)
}

func TestDispatchEvent_AllEventTypes_EnqueuesForWildcardHook(t *testing.T) {
	t.Parallel()

	eventTypes := []EventType{
		EventTypePush,
		EventTypeLandingRequest,
		EventTypeLandingRequestReview,
		EventTypeLandingRequestComment,
		EventTypeIssues,
		EventTypeIssueComment,
		EventTypeCreate,
		EventTypeDelete,
		EventTypeTeam,
		EventTypeOrganization,
		EventTypeWorkflowRun,
		EventTypeWorkflowArtifact,
		EventTypeStatus,
		EventTypeLandingConflict,
		EventWiki,
	}

	for _, et := range eventTypes {
		et := et
		t.Run(string(et), func(t *testing.T) {
			t.Parallel()

			store := &mockDispatcherStore{
				listFn: func(_ context.Context, _ int64) ([]db.Webhook, error) {
					return []db.Webhook{
						{ID: 1, RepositoryID: 99, IsActive: true, Events: []string{"*"}},
					}, nil
				},
			}

			dispatcher := NewDispatcher(store)
			err := dispatcher.DispatchEvent(context.Background(), 99, et, map[string]string{"event": string(et)})
			require.NoError(t, err, "event type %s should dispatch without error", et)
			require.Len(t, store.createCalls, 1, "event type %s should create exactly one delivery", et)
			assert.Equal(t, string(et), store.createCalls[0].EventType)
			assert.Equal(t, "pending", store.createCalls[0].Status)
		})
	}
}

func TestDispatchEvent_IntegrationCreatesDeliveryRows(t *testing.T) {
	q, pool := newDispatcherQueries(t)
	ctx := context.Background()

	ownerID := mustCreateDispatcherUser(t, pool, "dispatch-owner")
	repoID := mustCreateDispatcherRepo(t, pool, ownerID, "dispatch-repo")

	hookIssues, err := q.CreateWebhook(ctx, db.CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/issues",
		Secret:       "s1",
		Events:       []string{"issues"},
		IsActive:     true,
	})
	require.NoError(t, err)

	_, err = q.CreateWebhook(ctx, db.CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/landing",
		Secret:       "s2",
		Events:       []string{"landing_request"},
		IsActive:     true,
	})
	require.NoError(t, err)

	_, err = q.CreateWebhook(ctx, db.CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/inactive",
		Secret:       "s3",
		Events:       []string{"issues"},
		IsActive:     false,
	})
	require.NoError(t, err)

	dispatcher := NewDispatcher(q)
	payload := IssueEventPayload{
		Action: "opened",
		Issue: IssuePayload{
			ID:        10,
			Number:    1,
			Title:     "t",
			Body:      "b",
			State:     "open",
			Author:    UserPayload{ID: ownerID, Login: "dispatch-owner"},
			CreatedAt: time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
			UpdatedAt: time.Date(2026, time.February, 22, 12, 0, 0, 0, time.UTC),
		},
		Repository: RepositoryPayload{ID: repoID, Name: "dispatch-repo", FullName: "dispatch-owner/dispatch-repo"},
		Sender:     UserPayload{ID: ownerID, Login: "dispatch-owner"},
	}

	require.NoError(t, dispatcher.DispatchEvent(ctx, repoID, EventTypeIssues, payload))

	var deliveryCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM webhook_deliveries`).Scan(&deliveryCount)
	require.NoError(t, err)
	assert.Equal(t, 1, deliveryCount)

	var webhookID int64
	var eventType string
	var payloadJSON []byte
	err = pool.QueryRow(ctx, `SELECT webhook_id, event_type, payload FROM webhook_deliveries LIMIT 1`).Scan(&webhookID, &eventType, &payloadJSON)
	require.NoError(t, err)
	assert.Equal(t, hookIssues.ID, webhookID)
	assert.Equal(t, string(EventTypeIssues), eventType)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(payloadJSON, &decoded))
	assert.Equal(t, "opened", decoded["action"])
}

func TestDispatchEvent_IntegrationStatusPayload_PersistsSenderLogin(t *testing.T) {
	q, pool := newDispatcherQueries(t)
	ctx := context.Background()

	ownerID := mustCreateDispatcherUser(t, pool, "status-owner")
	repoID := mustCreateDispatcherRepo(t, pool, ownerID, "status-repo")

	hookStatus, err := q.CreateWebhook(ctx, db.CreateWebhookParams{
		RepositoryID: repoID,
		Url:          "https://example.com/status",
		Secret:       "status-secret",
		Events:       []string{"status"},
		IsActive:     true,
	})
	require.NoError(t, err)

	dispatcher := NewDispatcher(q)
	payload := CommitStatusEventPayload{
		CommitStatus: CommitStatusPayload{
			ID:        1001,
			SHA:       "abc123",
			Context:   "ci/build",
			Status:    "success",
			TargetURL: "https://ci.example.com/runs/1001",
		},
		Repository: RepositoryPayload{ID: repoID, Name: "status-repo"},
		Sender:     UserPayload{ID: ownerID, Login: "status-owner"},
	}

	require.NoError(t, dispatcher.DispatchEvent(ctx, repoID, EventTypeStatus, payload))

	var webhookID int64
	var eventType string
	var payloadJSON []byte
	err = pool.QueryRow(ctx, `SELECT webhook_id, event_type, payload FROM webhook_deliveries LIMIT 1`).Scan(&webhookID, &eventType, &payloadJSON)
	require.NoError(t, err)
	assert.Equal(t, hookStatus.ID, webhookID)
	assert.Equal(t, string(EventTypeStatus), eventType)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(payloadJSON, &decoded))

	senderRaw, ok := decoded["sender"]
	require.True(t, ok, "payload should include sender object")
	sender, ok := senderRaw.(map[string]any)
	require.True(t, ok, "sender should be an object")
	assert.Equal(t, "status-owner", sender["login"])
	assert.Equal(t, float64(ownerID), sender["id"])
}

func newDispatcherQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	pool := dispatcherSuite.Pool(t)
	truncateDispatcherTables(t, pool)
	return db.New(pool), pool
}

func truncateDispatcherTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		TRUNCATE
			webhook_deliveries,
			webhooks,
			repositories,
			users
		RESTART IDENTITY CASCADE
	`)
	require.NoError(t, err)
}

func mustCreateDispatcherUser(t *testing.T, pool *pgxpool.Pool, username string) int64 {
	t.Helper()
	lower := strings.ToLower(username)
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		lower,
		username+"@example.com",
		lower+"@example.com",
		username,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func mustCreateDispatcherRepo(t *testing.T, pool *pgxpool.Pool, userID int64, name string) int64 {
	t.Helper()
	lower := strings.ToLower(name)
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		name,
		lower,
	).Scan(&id)
	require.NoError(t, err)
	return id
}
