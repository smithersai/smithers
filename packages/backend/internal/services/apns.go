package services

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

var ErrPushDeliveryNotConfigured = errors.New("push delivery is not configured")

const defaultApprovalPushQueueSize = 256

type APNSDeviceQuerier interface {
	ListAPNSDevicesForUser(ctx context.Context, userID int64) ([]db.UserDevice, error)
}

type ApprovalPushNotifier interface {
	EnqueueApprovalPush(userID int64, approval ApprovalResponse)
}

type APNSClient interface {
	SendApprovalPush(ctx context.Context, token string, notification ApprovalPushNotification) error
}

type ApprovalPushNotification struct {
	UserID     int64
	ApprovalID string
	Kind       string
	Title      string
	CreatedAt  time.Time
}

type approvalPushJob struct {
	userID   int64
	approval ApprovalResponse
}

type ApprovalPushDispatcher struct {
	q      APNSDeviceQuerier
	client APNSClient
	queue  chan approvalPushJob
	logger *slog.Logger
}

func NewApprovalPushDispatcher(ctx context.Context, q APNSDeviceQuerier, client APNSClient, bufferSize int, logger *slog.Logger) *ApprovalPushDispatcher {
	if bufferSize <= 0 {
		bufferSize = defaultApprovalPushQueueSize
	}
	if logger == nil {
		logger = slog.Default()
	}
	d := &ApprovalPushDispatcher{
		q:      q,
		client: client,
		queue:  make(chan approvalPushJob, bufferSize),
		logger: logger,
	}
	go d.run(ctx)
	return d
}

func (d *ApprovalPushDispatcher) EnqueueApprovalPush(userID int64, approval ApprovalResponse) {
	if d == nil || d.q == nil || d.client == nil || userID <= 0 {
		return
	}
	select {
	case d.queue <- approvalPushJob{userID: userID, approval: approval}:
	default:
		d.logger.Warn("approval push queue full; dropping notification", "user_id", userID, "approval_id", approval.ID)
	}
}

func (d *ApprovalPushDispatcher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-d.queue:
			d.send(ctx, job)
		}
	}
}

func (d *ApprovalPushDispatcher) send(ctx context.Context, job approvalPushJob) {
	devices, err := d.q.ListAPNSDevicesForUser(ctx, job.userID)
	if err != nil {
		d.logger.Warn("approval push device lookup failed", "user_id", job.userID, "approval_id", job.approval.ID, "error", err)
		return
	}

	notification := ApprovalPushNotification{
		UserID:     job.userID,
		ApprovalID: job.approval.ID,
		Kind:       job.approval.Kind,
		Title:      job.approval.Title,
		CreatedAt:  job.approval.CreatedAt,
	}
	for _, device := range devices {
		if err := d.client.SendApprovalPush(ctx, device.ApnsToken, notification); err != nil {
			d.logger.Warn("approval push send failed", "user_id", job.userID, "approval_id", job.approval.ID, "device_id", device.ID, "error", err)
		}
	}
}

type LoggingAPNSClient struct {
	logger *slog.Logger
}

func NewLoggingAPNSClient(logger *slog.Logger) *LoggingAPNSClient {
	if logger == nil {
		logger = slog.Default()
	}
	return &LoggingAPNSClient{logger: logger}
}

func (c *LoggingAPNSClient) SendApprovalPush(_ context.Context, token string, notification ApprovalPushNotification) error {
	c.logger.Info(
		"apns: push delivery requested",
		"user_id", notification.UserID,
		"approval_id", notification.ApprovalID,
		"kind", notification.Kind,
		"title", notification.Title,
		"token_prefix", tokenPrefix(token),
	)
	return ErrPushDeliveryNotConfigured
}

func tokenPrefix(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12]
}
