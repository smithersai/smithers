package webhooks

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// dispatchCoverStore is a fully controllable Store mock supporting both the
// per-repo and per-org list paths plus delivery creation, with error injection.
type dispatchCoverStore struct {
	listRepoFn func(ctx context.Context, repositoryID int64) ([]db.Webhook, error)
	listOrgFn  func(ctx context.Context, orgID int64) ([]db.Webhook, error)
	createFn   func(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error)

	lastOrgID   int64
	createCalls []db.CreateWebhookDeliveryParams
}

func (m *dispatchCoverStore) ListActiveWebhooksByRepo(ctx context.Context, repositoryID int64) ([]db.Webhook, error) {
	if m.listRepoFn != nil {
		return m.listRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *dispatchCoverStore) ListActiveWebhooksByOrg(ctx context.Context, orgID int64) ([]db.Webhook, error) {
	m.lastOrgID = orgID
	if m.listOrgFn != nil {
		return m.listOrgFn(ctx, orgID)
	}
	return nil, nil
}

func (m *dispatchCoverStore) CreateWebhookDelivery(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
	m.createCalls = append(m.createCalls, arg)
	if m.createFn != nil {
		return m.createFn(ctx, arg)
	}
	return db.WebhookDelivery{ID: int64(len(m.createCalls))}, nil
}

// TestDispatcher_Cover_DispatchEvent_PropagatesListError exercises the
// ListActiveWebhooksByRepo error branch of DispatchEvent.
func TestDispatcher_Cover_DispatchEvent_PropagatesListError(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{
		listRepoFn: func(_ context.Context, _ int64) ([]db.Webhook, error) {
			return nil, assert.AnError
		},
	}

	d := NewDispatcher(store)
	err := d.DispatchEvent(context.Background(), 42, EventTypeIssues, map[string]string{"a": "b"})
	require.ErrorIs(t, err, assert.AnError)
	assert.Empty(t, store.createCalls)
}

// TestDispatcher_Cover_DispatchOrgEvent_RejectsZeroOrgID covers the guard for a
// non-positive organization id.
func TestDispatcher_Cover_DispatchOrgEvent_RejectsZeroOrgID(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{}
	d := NewDispatcher(store)

	for _, orgID := range []int64{0, -1} {
		err := d.DispatchOrgEvent(context.Background(), orgID, EventTypeOrganization, map[string]string{"a": "b"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid organization id")
	}
	assert.Empty(t, store.createCalls)
}

// TestDispatcher_Cover_DispatchOrgEvent_PropagatesListError covers the
// ListActiveWebhooksByOrg error branch.
func TestDispatcher_Cover_DispatchOrgEvent_PropagatesListError(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{
		listOrgFn: func(_ context.Context, _ int64) ([]db.Webhook, error) {
			return nil, assert.AnError
		},
	}

	d := NewDispatcher(store)
	err := d.DispatchOrgEvent(context.Background(), 7, EventTypeOrganization, map[string]string{"a": "b"})
	require.ErrorIs(t, err, assert.AnError)
	assert.Equal(t, int64(7), store.lastOrgID)
	assert.Empty(t, store.createCalls)
}

// TestDispatcher_Cover_DispatchOrgEvent_PropagatesMarshalError covers the
// json.Marshal error branch when the payload is not serializable.
func TestDispatcher_Cover_DispatchOrgEvent_PropagatesMarshalError(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{
		listOrgFn: func(_ context.Context, orgID int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, IsActive: true, Events: []string{"organization"}}}, nil
		},
	}

	d := NewDispatcher(store)
	err := d.DispatchOrgEvent(context.Background(), 7, EventTypeOrganization, map[string]any{"bad": make(chan int)})
	require.Error(t, err)
	assert.Empty(t, store.createCalls)
}

// TestDispatcher_Cover_DispatchOrgEvent_CreatesDeliveriesForSubscribed covers
// the happy path plus the inactive/unsubscribed skip branches of the loop.
func TestDispatcher_Cover_DispatchOrgEvent_CreatesDeliveriesForSubscribed(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{
		listOrgFn: func(_ context.Context, orgID int64) ([]db.Webhook, error) {
			require.Equal(t, int64(88), orgID)
			return []db.Webhook{
				{ID: 1, IsActive: true, Events: []string{"organization"}},
				{ID: 2, IsActive: true, Events: []string{"push"}}, // not subscribed -> skip
				{ID: 3, IsActive: false, Events: []string{"all"}}, // inactive -> skip
				{ID: 4, IsActive: true, Events: []string{"*"}},    // wildcard -> match
			}, nil
		},
	}

	d := NewDispatcher(store)
	err := d.DispatchOrgEvent(context.Background(), 88, EventTypeOrganization, map[string]string{"action": "member_added"})
	require.NoError(t, err)

	require.Len(t, store.createCalls, 2)
	assert.Equal(t, int64(1), store.createCalls[0].WebhookID)
	assert.Equal(t, int64(4), store.createCalls[1].WebhookID)
	assert.Equal(t, string(EventTypeOrganization), store.createCalls[0].EventType)
	assert.Equal(t, "pending", store.createCalls[0].Status)

	var decoded map[string]string
	require.NoError(t, json.Unmarshal(store.createCalls[0].Payload, &decoded))
	assert.Equal(t, "member_added", decoded["action"])
}

// TestDispatcher_Cover_DispatchOrgEvent_PropagatesCreateError covers the
// CreateWebhookDelivery error branch of the org loop.
func TestDispatcher_Cover_DispatchOrgEvent_PropagatesCreateError(t *testing.T) {
	t.Parallel()

	store := &dispatchCoverStore{
		listOrgFn: func(_ context.Context, _ int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, IsActive: true, Events: []string{"organization"}}}, nil
		},
		createFn: func(_ context.Context, _ db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
			return db.WebhookDelivery{}, assert.AnError
		},
	}

	d := NewDispatcher(store)
	err := d.DispatchOrgEvent(context.Background(), 7, EventTypeOrganization, map[string]string{"a": "b"})
	require.ErrorIs(t, err, assert.AnError)
}
