package services

import (
	"context"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type workflowRunEventNotifier interface {
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
}

func notifyWorkflowRunEvent(ctx context.Context, notifier workflowRunEventNotifier, workflowRunID int64, source string) {
	if notifier == nil || workflowRunID <= 0 {
		return
	}

	payload, _ := json.Marshal(map[string]any{
		"run_id": workflowRunID,
		"source": source,
	})

	if err := notifier.NotifyWorkflowRunEvent(ctx, db.NotifyWorkflowRunEventParams{
		RunID:   workflowRunID,
		Payload: string(payload),
	}); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, workflowRunID).
			Warn("failed to notify workflow run event", "source", source, "error", err)
	}
}
