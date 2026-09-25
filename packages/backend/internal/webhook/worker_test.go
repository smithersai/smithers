package webhook

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workerMockStore struct {
	claimFn        func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error)
	listWebhooksFn func(ctx context.Context, ids []int64) ([]db.Webhook, error)
	updateResultFn func(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error
	updateRetryFn  func(ctx context.Context, arg db.UpdateWebhookDeliveryRetryParams) error
	listStatusFn   func(ctx context.Context, webhookID int64) ([]string, error)
	setActiveFn    func(ctx context.Context, arg db.SetWebhookActiveParams) error

	// mu guards the call records: the worker delivers a claimed batch
	// concurrently, so result/retry/disable writes arrive from many goroutines.
	mu             sync.Mutex
	claimCallCount int
	resultCalls    []db.UpdateWebhookDeliveryResultParams
	retryCalls     []db.UpdateWebhookDeliveryRetryParams
	setActiveCalls []db.SetWebhookActiveParams
}

func (m *workerMockStore) ClaimDueWebhookDeliveries(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
	m.mu.Lock()
	m.claimCallCount++
	m.mu.Unlock()
	if m.claimFn != nil {
		return m.claimFn(ctx, limit)
	}
	return nil, nil
}

func (m *workerMockStore) ListWebhooksByIDs(ctx context.Context, ids []int64) ([]db.Webhook, error) {
	if m.listWebhooksFn != nil {
		return m.listWebhooksFn(ctx, ids)
	}
	return nil, nil
}

func (m *workerMockStore) UpdateWebhookDeliveryResult(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
	m.mu.Lock()
	m.resultCalls = append(m.resultCalls, arg)
	m.mu.Unlock()
	if m.updateResultFn != nil {
		return m.updateResultFn(ctx, arg)
	}
	return nil
}

func (m *workerMockStore) UpdateWebhookDeliveryRetry(ctx context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
	m.mu.Lock()
	m.retryCalls = append(m.retryCalls, arg)
	m.mu.Unlock()
	if m.updateRetryFn != nil {
		return m.updateRetryFn(ctx, arg)
	}
	return nil
}

func (m *workerMockStore) ListRecentWebhookDeliveryStatuses(ctx context.Context, webhookID int64) ([]string, error) {
	if m.listStatusFn != nil {
		return m.listStatusFn(ctx, webhookID)
	}
	return nil, nil
}

func (m *workerMockStore) SetWebhookActive(ctx context.Context, arg db.SetWebhookActiveParams) error {
	m.mu.Lock()
	m.setActiveCalls = append(m.setActiveCalls, arg)
	m.mu.Unlock()
	if m.setActiveFn != nil {
		return m.setActiveFn(ctx, arg)
	}
	return nil
}

func TestWorker_PollOnce_NoTasksAvailable(t *testing.T) {
	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return nil, nil
		},
	}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, store.resultCalls)
}

func TestWorker_PollOnce_DeliversSuccessfully(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "test_event", r.Header.Get("X-Smithers-Event"))
		assert.Equal(t, "123", r.Header.Get("X-Smithers-Delivery"))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 123, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, Url: ts.URL, IsActive: true, Secret: "secret"}}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "success", store.resultCalls[0].Status)
	assert.Equal(t, "ok", store.resultCalls[0].ResponseBody)
}

func TestWorker_PollOnce_RecordsFailureAndSchedulesRetry(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("error"))
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 124, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, Url: ts.URL, IsActive: true}}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Empty(t, store.resultCalls)
	require.Len(t, store.retryCalls, 1)
	assert.Equal(t, "pending", store.retryCalls[0].Status)
	assert.Equal(t, "error", store.retryCalls[0].ResponseBody)
}

func TestWorker_PollOnce_FinalFailureDisablesWebhook(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("error"))
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 125, WebhookID: 1, Attempts: 4, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, Url: ts.URL, IsActive: true}}, nil
		},
		listStatusFn: func(ctx context.Context, webhookID int64) ([]string, error) {
			return []string{"failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed"}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "failed", store.resultCalls[0].Status)

	require.Len(t, store.setActiveCalls, 1)
	assert.Equal(t, int64(1), store.setActiveCalls[0].ID)
	assert.False(t, store.setActiveCalls[0].IsActive)
}

func TestWorker_PollOnce_NetworkError_RecordsFailure(t *testing.T) {
	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 126, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, Url: "http://localhost:0", IsActive: true}}, nil
		},
	}

	// DefaultClient has short timeout
	client := &http.Client{Timeout: 10 * time.Millisecond}
	worker := NewWorker(store, client, NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Empty(t, store.resultCalls)
	require.Len(t, store.retryCalls, 1)
	assert.Equal(t, "pending", store.retryCalls[0].Status)
}

func TestWorker_PollOnce_MultipleTasks_ProcessesAll(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 1, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
				{ID: 2, WebhookID: 2, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
				{ID: 3, WebhookID: 3, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{
				{ID: 1, Url: ts.URL, IsActive: true},
				{ID: 2, Url: ts.URL, IsActive: true},
				{ID: 3, Url: ts.URL, IsActive: true},
			}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Len(t, store.resultCalls, 3)
}

// A slow receiver must not hold up another webhook's delivery in the same
// claimed batch. The slow receiver answers 200 only if the fast webhook's
// delivery reaches its server while the slow request is still open, which
// can only happen when the batch is delivered concurrently.
func TestWorker_PollOnce_SlowReceiverDoesNotBlockOtherWebhooks(t *testing.T) {
	fastArrived := make(chan struct{})
	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(fastArrived)
		w.WriteHeader(http.StatusOK)
	}))
	defer fast.Close()
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-fastArrived:
			w.WriteHeader(http.StatusOK)
		case <-time.After(2 * time.Second):
			w.WriteHeader(http.StatusGatewayTimeout)
		}
	}))
	defer slow.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 1, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
				{ID: 2, WebhookID: 2, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{
				{ID: 1, Url: slow.URL, IsActive: true},
				{ID: 2, Url: fast.URL, IsActive: true},
			}, nil
		},
	}

	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	require.NoError(t, worker.PollOnce(context.Background()))

	require.Empty(t, store.retryCalls, "the slow receiver timed out waiting for the other webhook's delivery")
	require.Len(t, store.resultCalls, 2)
	for _, call := range store.resultCalls {
		assert.Equal(t, "success", call.Status, "delivery %d", call.ID)
	}
}

func TestWorker_PollOnce_SkipsInactiveWebhook(t *testing.T) {
	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 127, WebhookID: 1, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{ID: 1, Url: "http://example.com", IsActive: false}}, nil
		},
	}

	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Empty(t, store.retryCalls)
	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "failed", store.resultCalls[0].Status)
}

func TestWorker_PollOnce_DecryptsCiphertextSecretBeforeDeliver(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("worker-secret-key")
	require.NoError(t, err)

	plaintextSecret := "plain-secret"
	ciphertextSecret, err := codec.EncryptString(plaintextSecret)
	require.NoError(t, err)

	payload := []byte(`{"ok":true}`)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, signPayload(plaintextSecret, payload), r.Header.Get(smithersSignatureName))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 301, WebhookID: 77, Attempts: 1, EventType: "test_event", Payload: payload},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{
				ID:       77,
				Url:      ts.URL,
				IsActive: true,
				Secret:   ciphertextSecret,
			}}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), codec)
	err = worker.PollOnce(context.Background())
	require.NoError(t, err)
	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "success", store.resultCalls[0].Status)
}

func TestWorker_PollOnce_DecryptionFailureMarksDeliveryFailed(t *testing.T) {
	t.Parallel()

	codec, err := NewSecretCodec("worker-secret-key")
	require.NoError(t, err)

	hitCount := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitCount++
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return []db.WebhookDelivery{
				{ID: 302, WebhookID: 77, Attempts: 1, EventType: "test_event", Payload: []byte(`{}`)},
			}, nil
		},
		listWebhooksFn: func(ctx context.Context, ids []int64) ([]db.Webhook, error) {
			return []db.Webhook{{
				ID:       77,
				Url:      ts.URL,
				IsActive: true,
				Secret:   "not-base64@@",
			}}, nil
		},
	}

	worker := NewWorker(store, ts.Client(), codec)
	err = worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Equal(t, 0, hitCount)
	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "failed", store.resultCalls[0].Status)
	assert.Contains(t, store.resultCalls[0].ResponseBody, "decrypt")
	assert.Empty(t, store.retryCalls)
}

func TestWorker_PollOnce_StoreError_ReturnsError(t *testing.T) {
	expectedErr := errors.New("db error")
	store := &workerMockStore{
		claimFn: func(ctx context.Context, limit int32) ([]db.WebhookDelivery, error) {
			return nil, expectedErr
		},
	}

	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	err := worker.PollOnce(context.Background())
	require.ErrorIs(t, err, expectedErr)
}

func TestWorker_Start_StopsOnContextCancellation(t *testing.T) {
	store := &workerMockStore{}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
		// success
	case <-time.After(100 * time.Millisecond):
		t.Fatal("worker did not stop promptly")
	}
}

func TestWorker_Start_PollsRepeatedly(t *testing.T) {
	store := &workerMockStore{}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	worker.interval = 10 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	worker.Start(ctx)

	assert.GreaterOrEqual(t, store.claimCallCount, 2)
}
