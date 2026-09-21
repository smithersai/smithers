package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowEventsCovNotifier struct {
	calls []db.NotifyWorkflowRunEventParams
	err   error
}

func (n *workflowEventsCovNotifier) NotifyWorkflowRunEvent(_ context.Context, arg db.NotifyWorkflowRunEventParams) error {
	n.calls = append(n.calls, arg)
	return n.err
}

func TestWorkflowEvents_Cov_NotifyBranches(t *testing.T) {
	notifyWorkflowRunEvent(context.Background(), nil, 1, "source")
	n := &workflowEventsCovNotifier{}
	notifyWorkflowRunEvent(context.Background(), n, 0, "source")
	if len(n.calls) != 0 {
		t.Fatalf("zero run id produced calls: %+v", n.calls)
	}

	notifyWorkflowRunEvent(context.Background(), n, 44, "scheduler")
	if len(n.calls) != 1 || n.calls[0].RunID != 44 {
		t.Fatalf("calls = %+v", n.calls)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(n.calls[0].Payload), &payload); err != nil {
		t.Fatalf("payload invalid json: %v", err)
	}
	if payload["source"] != "scheduler" || payload["run_id"].(float64) != 44 {
		t.Fatalf("payload = %#v", payload)
	}

	n.err = errors.New("notify failed")
	notifyWorkflowRunEvent(context.Background(), n, 45, "runner")
	if len(n.calls) != 2 {
		t.Fatalf("erroring notifier should still have recorded call: %+v", n.calls)
	}
}
