package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockWorkflowRunEventNotifier struct {
	notifyFn func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	calls    []db.NotifyWorkflowRunEventParams
}

func (m *mockWorkflowRunEventNotifier) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	m.calls = append(m.calls, arg)
	if m.notifyFn != nil {
		return m.notifyFn(ctx, arg)
	}
	return nil
}

func TestNotifyWorkflowRunEvent_Success(t *testing.T) {
	t.Parallel()

	notifier := &mockWorkflowRunEventNotifier{}
	notifyWorkflowRunEvent(context.Background(), notifier, 42, "test")

	require.Len(t, notifier.calls, 1)
	assert.Equal(t, int64(42), notifier.calls[0].RunID)
	assert.Contains(t, notifier.calls[0].Payload, `"run_id":42`)
	assert.Contains(t, notifier.calls[0].Payload, `"source":"test"`)
}

func TestNotifyWorkflowRunEvent_NilNotifier(t *testing.T) {
	t.Parallel()

	// Should not panic
	notifyWorkflowRunEvent(context.Background(), nil, 42, "test")
}

func TestNotifyWorkflowRunEvent_ZeroRunID(t *testing.T) {
	t.Parallel()

	notifier := &mockWorkflowRunEventNotifier{}
	notifyWorkflowRunEvent(context.Background(), notifier, 0, "test")

	// Should not call notifier with zero run ID
	assert.Empty(t, notifier.calls)
}

func TestNotifyWorkflowRunEvent_NegativeRunID(t *testing.T) {
	t.Parallel()

	notifier := &mockWorkflowRunEventNotifier{}
	notifyWorkflowRunEvent(context.Background(), notifier, -1, "test")

	// Should not call notifier with negative run ID
	assert.Empty(t, notifier.calls)
}

func TestNotifyWorkflowRunEvent_NotifierError(t *testing.T) {
	t.Parallel()

	notifier := &mockWorkflowRunEventNotifier{
		notifyFn: func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
			return assert.AnError
		},
	}

	// Should not panic on error; logs warning but doesn't propagate
	notifyWorkflowRunEvent(context.Background(), notifier, 42, "test")
	require.Len(t, notifier.calls, 1)
}
