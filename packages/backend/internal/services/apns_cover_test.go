package services

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type apnsCovDeviceQuerier struct {
	mu      sync.Mutex
	devices []db.UserDevice
	err     error
	calls   int
}

func (q *apnsCovDeviceQuerier) ListAPNSDevicesForUser(ctx context.Context, userID int64) ([]db.UserDevice, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.calls++
	return append([]db.UserDevice(nil), q.devices...), q.err
}

func (q *apnsCovDeviceQuerier) callCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.calls
}

type apnsCovClient struct {
	mu     sync.Mutex
	err    error
	tokens []string
	notes  []ApprovalPushNotification
}

func (c *apnsCovClient) SendApprovalPush(ctx context.Context, token string, notification ApprovalPushNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tokens = append(c.tokens, token)
	c.notes = append(c.notes, notification)
	return c.err
}

func (c *apnsCovClient) tokenCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.tokens)
}

func (c *apnsCovClient) sentTokens() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.tokens...)
}

func (c *apnsCovClient) noteAt(index int) ApprovalPushNotification {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.notes[index]
}

func TestAPNS_Cov_DispatcherEnqueueRunAndSendBranches(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	devices := &apnsCovDeviceQuerier{devices: []db.UserDevice{
		{ID: 1, ApnsToken: "token-one"},
		{ID: 2, ApnsToken: "token-two"},
	}}
	client := &apnsCovClient{}
	dispatcher := NewApprovalPushDispatcher(ctx, devices, client, 1, nil)

	createdAt := time.Now().UTC()
	dispatcher.EnqueueApprovalPush(42, ApprovalResponse{
		ID:        "approval-1",
		Kind:      "shell_command",
		Title:     "Run command",
		CreatedAt: createdAt,
	})

	require.Eventually(t, func() bool {
		return client.tokenCount() == 2
	}, time.Second, 10*time.Millisecond)
	assert.Equal(t, []string{"token-one", "token-two"}, client.sentTokens())
	note := client.noteAt(0)
	assert.Equal(t, int64(42), note.UserID)
	assert.Equal(t, "approval-1", note.ApprovalID)
	assert.Equal(t, "shell_command", note.Kind)
	assert.Equal(t, "Run command", note.Title)
	assert.Equal(t, createdAt, note.CreatedAt)

	dispatcher.EnqueueApprovalPush(0, ApprovalResponse{ID: "ignored"})
	var nilDispatcher *ApprovalPushDispatcher
	nilDispatcher.EnqueueApprovalPush(42, ApprovalResponse{ID: "ignored"})
	assert.Equal(t, 1, devices.callCount())

	erringDevices := &apnsCovDeviceQuerier{err: assert.AnError}
	dispatcher = &ApprovalPushDispatcher{q: erringDevices, client: client, logger: slog.Default()}
	dispatcher.send(context.Background(), approvalPushJob{userID: 7, approval: ApprovalResponse{ID: "approval-2"}})
	assert.Equal(t, 1, erringDevices.callCount())
}

func TestAPNS_Cov_LoggingClientAndTokenPrefix(t *testing.T) {
	loggerClient := NewLoggingAPNSClient(nil)
	require.NoError(t, loggerClient.SendApprovalPush(context.Background(), "abcdefghijklmnop", ApprovalPushNotification{
		UserID:     1,
		ApprovalID: "approval-log",
		Kind:       "kind",
		Title:      "title",
	}))

	assert.Equal(t, "short", tokenPrefix("short"))
	assert.Equal(t, "abcdefghijkl", tokenPrefix("abcdefghijklmnop"))

	custom := NewLoggingAPNSClient(slog.Default())
	require.NotNil(t, custom)
}
