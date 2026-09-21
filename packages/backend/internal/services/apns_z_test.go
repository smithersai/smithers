package services

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAPNS_Z_DefaultBufferQueueFullAndSendFailure(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	dispatcher := NewApprovalPushDispatcher(ctx, &apnsCovDeviceQuerier{}, &apnsCovClient{}, 0, slog.Default())
	cancel()
	assert.Equal(t, defaultApprovalPushQueueSize, cap(dispatcher.queue))

	q := &apnsCovDeviceQuerier{}
	dropper := &ApprovalPushDispatcher{
		q:      q,
		client: &apnsCovClient{},
		queue:  make(chan approvalPushJob, 1),
		logger: slog.Default(),
	}
	dropper.queue <- approvalPushJob{userID: 1, approval: ApprovalResponse{ID: "queued"}}
	dropper.EnqueueApprovalPush(2, ApprovalResponse{ID: "dropped"})
	assert.Equal(t, 0, q.callCount())

	client := &apnsCovClient{err: errors.New("send failed")}
	sender := &ApprovalPushDispatcher{
		q: &apnsCovDeviceQuerier{devices: []db.UserDevice{
			{ID: 7, ApnsToken: "token-z"},
		}},
		client: client,
		logger: slog.Default(),
	}
	sender.send(context.Background(), approvalPushJob{userID: 9, approval: ApprovalResponse{ID: "approval-z", CreatedAt: time.Now()}})
	require.Equal(t, 1, client.tokenCount())
}
