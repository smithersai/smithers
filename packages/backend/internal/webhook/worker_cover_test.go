package webhook

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workerCovFailingCodec struct {
	decryptErr error
}

func (c workerCovFailingCodec) EncryptString(plaintext string) (string, error) {
	return plaintext, nil
}

func (c workerCovFailingCodec) DecryptString(string) (string, error) {
	return "", c.decryptErr
}

func TestWorker_Cov_NewWorkerDefaultsNilCodecAndAppliesOptions(t *testing.T) {
	t.Parallel()

	store := &workerMockStore{}
	observer := &fakeWebhookMetricsObserver{}

	worker := NewWorker(store, nil, nil, nil, WithMetricsObserver(observer))

	assert.Same(t, store, worker.store)
	assert.Nil(t, worker.client)
	_, ok := worker.secretCodec.(NoopSecretCodec)
	assert.True(t, ok)
	assert.Same(t, observer, worker.metrics)
	assert.NotNil(t, worker.logger)
	assert.Equal(t, defaultPollInterval, worker.interval)
	assert.Equal(t, int32(defaultClaimLimit), worker.limit)
}

func TestWorker_Cov_StartReturnsOnPollContextCanceled(t *testing.T) {
	store := &workerMockStore{
		claimFn: func(context.Context, int32) ([]db.WebhookDelivery, error) {
			return nil, context.Canceled
		},
	}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})

	done := make(chan struct{})
	go func() {
		worker.Start(context.Background())
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("worker did not stop after context-canceled poll error")
	}
}

func TestWorker_Cov_StartLogsNonContextErrorThenStops(t *testing.T) {
	expectedErr := errors.New("transient poll failure")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	store := &workerMockStore{
		claimFn: func(context.Context, int32) ([]db.WebhookDelivery, error) {
			cancel()
			return nil, expectedErr
		},
	}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	worker.interval = time.Hour

	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("worker did not stop after cancellation following poll error")
	}
	assert.Equal(t, 1, store.claimCallCount)
}

func TestWorker_Cov_StartRecoversPollPanicAndContinues(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	calls := 0
	store := &workerMockStore{
		claimFn: func(context.Context, int32) ([]db.WebhookDelivery, error) {
			calls++
			if calls == 1 {
				panic("poll panic")
			}
			if calls == 2 {
				cancel()
				return nil, context.Canceled
			}
			return nil, nil
		},
	}
	worker := NewWorker(store, http.DefaultClient, NoopSecretCodec{})
	worker.interval = time.Millisecond

	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("worker did not continue after recovered panic")
	}
	assert.GreaterOrEqual(t, store.claimCallCount, 2)
}

func TestWorker_Cov_ProcessTaskLogsDecryptUpdateError(t *testing.T) {
	t.Parallel()

	decryptErr := errors.New("ciphertext corrupt")
	updateErr := errors.New("failed status write failed")
	store := &workerMockStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "failed", arg.Status)
			assert.Contains(t, arg.ResponseBody, decryptErr.Error())
			return updateErr
		},
	}
	worker := NewWorker(store, http.DefaultClient, workerCovFailingCodec{decryptErr: decryptErr})

	worker.processTask(context.Background(), Task{
		Delivery: db.WebhookDelivery{ID: 801, WebhookID: 901, Attempts: 1},
		Webhook:  db.Webhook{ID: 901, Url: "https://example.com/hook", IsActive: true, Secret: "encrypted"},
	})

	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "failed", store.resultCalls[0].Status)
	assert.Empty(t, store.retryCalls)
}

func TestWorker_Cov_ProcessTaskLogsStatusUpdateError(t *testing.T) {
	t.Parallel()

	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		assert.Equal(t, signPayload("plain-secret", []byte(`{"ok":true}`)), r.Header.Get(smithersSignatureName))
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("accepted"))
	}))
	defer server.Close()

	updateErr := errors.New("success status write failed")
	store := &workerMockStore{
		updateResultFn: func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
			assert.Equal(t, "success", arg.Status)
			assert.Equal(t, "accepted", arg.ResponseBody)
			return updateErr
		},
	}
	worker := NewWorker(store, server.Client(), NoopSecretCodec{})

	worker.processTask(context.Background(), Task{
		Delivery: db.WebhookDelivery{
			ID:        802,
			WebhookID: 902,
			Attempts:  1,
			EventType: "test_event",
			Payload:   []byte(`{"ok":true}`),
		},
		Webhook: db.Webhook{ID: 902, Url: server.URL, IsActive: true, Secret: "plain-secret"},
	})

	assert.True(t, hit)
	require.Len(t, store.resultCalls, 1)
	assert.Equal(t, "success", store.resultCalls[0].Status)
}
