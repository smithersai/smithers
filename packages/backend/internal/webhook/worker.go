package webhook

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	defaultPollInterval = 2 * time.Second
	defaultClaimLimit   = 10
)

// Worker polls for pending webhook deliveries and sends them.
type Worker struct {
	store       QueueStore
	client      *http.Client
	secretCodec SecretCodec
	metrics     MetricsObserver
	logger      *slog.Logger
	interval    time.Duration
	limit       int32
}

// WorkerOption configures optional worker integrations.
type WorkerOption func(*Worker)

// WithMetricsObserver records webhook delivery metrics as tasks complete.
func WithMetricsObserver(observer MetricsObserver) WorkerOption {
	return func(w *Worker) {
		w.metrics = observer
	}
}

// NewWorker creates a webhook delivery worker.
func NewWorker(store QueueStore, client *http.Client, codec SecretCodec, opts ...WorkerOption) *Worker {
	if codec == nil {
		codec = NoopSecretCodec{}
	}

	worker := &Worker{
		store:       store,
		client:      client,
		secretCodec: codec,
		logger:      slog.Default(),
		interval:    defaultPollInterval,
		limit:       defaultClaimLimit,
	}

	for _, opt := range opts {
		if opt != nil {
			opt(worker)
		}
	}

	return worker
}

// Start runs the polling loop until ctx is cancelled.
func (w *Worker) Start(ctx context.Context) {
	w.logger.Info("webhook worker started")

	for {
		if err := w.pollOnceRecovering(ctx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				w.logger.Info("webhook worker stopping", "reason", err)
				return
			}
			w.logger.Error("webhook worker poll error", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("webhook worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

func (w *Worker) pollOnceRecovering(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			w.logger.Error("webhook worker panicked", "panic", r)
		}
	}()

	return w.PollOnce(ctx)
}

// PollOnce claims due deliveries and delivers them concurrently. The claim
// limit bounds the batch, so it also bounds the number of requests in flight.
// Delivering the batch in parallel keeps one slow or black-holed receiver
// from holding every other webhook in the batch behind its HTTP timeout.
func (w *Worker) PollOnce(ctx context.Context) error {
	tasks, err := PollQueue(ctx, w.store, w.limit)
	if err != nil {
		return fmt.Errorf("poll webhook queue: %w", err)
	}

	var wg sync.WaitGroup
	for _, task := range tasks {
		if !task.Webhook.IsActive {
			// Inactive webhooks should fail terminally instead of requeueing.
			_ = UpdateTaskStatus(ctx, w.store, task, DeliveryResult{
				Err:          fmt.Errorf("webhook disabled"),
				ResponseBody: "webhook disabled",
				SkipRetry:    true,
				Disabled:     true,
			}, time.Now().UTC(), w.metrics)
			continue
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					w.logger.Error("webhook delivery panicked",
						"delivery_id", task.Delivery.ID,
						"webhook_id", task.Webhook.ID,
						"panic", r,
					)
				}
			}()
			w.processTask(ctx, task)
		}()
	}
	wg.Wait()

	return nil
}

// processTask delivers one webhook and records the result.
func (w *Worker) processTask(ctx context.Context, task Task) {
	decryptedSecret, err := w.secretCodec.DecryptString(task.Webhook.Secret)
	if err != nil {
		if updateErr := UpdateTaskStatus(ctx, w.store, task, DeliveryResult{
			ResponseBody: fmt.Sprintf("failed to decrypt webhook secret: %v", err),
			Err:          err,
			SkipRetry:    true,
		}, time.Now().UTC(), w.metrics); updateErr != nil {
			w.logger.Error("failed to mark webhook delivery failed after decrypt error",
				"delivery_id", task.Delivery.ID,
				"webhook_id", task.Webhook.ID,
				"error", updateErr,
			)
		}
		return
	}

	req := DeliveryRequest{
		URL:        task.Webhook.Url,
		Secret:     decryptedSecret,
		EventType:  task.Delivery.EventType,
		DeliveryID: fmt.Sprintf("%d", task.Delivery.ID),
		Payload:    task.Delivery.Payload,
	}

	statusCode, body, err := Deliver(ctx, w.client, req)

	result := DeliveryResult{
		StatusCode:   statusCode,
		ResponseBody: body,
		Err:          err,
	}

	if updateErr := UpdateTaskStatus(ctx, w.store, task, result, time.Now().UTC(), w.metrics); updateErr != nil {
		w.logger.Error("failed to update webhook delivery status",
			"delivery_id", task.Delivery.ID,
			"webhook_id", task.Webhook.ID,
			"error", updateErr,
		)
	}
}
