package taskrunner

import (
	"context"
	"fmt"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	runnerclient "github.com/smithersai/smithers/packages/backend/internal/taskrunner/client"
)

type apiTaskClient interface {
	ClaimTask(ctx context.Context, runnerID int64) (*runnerclient.Task, error)
	CompleteTask(ctx context.Context, taskID, runnerID int64, status, errorMessage string) error
}

type APIPool struct {
	client apiTaskClient
}

func NewAPIPool(client apiTaskClient) *APIPool {
	return &APIPool{client: client}
}

func (p *APIPool) ClaimTask(ctx context.Context, runnerID int64) (*db.WorkflowTask, error) {
	if p == nil || p.client == nil {
		return nil, fmt.Errorf("runner API client unavailable")
	}

	task, err := p.client.ClaimTask(ctx, runnerID)
	if err != nil || task == nil {
		return nil, err
	}

	return &db.WorkflowTask{
		ID:             task.ID,
		WorkflowRunID:  task.WorkflowRunID,
		RepositoryID:   task.RepositoryID,
		WorkflowStepID: task.WorkflowStepID,
		Attempt:        task.Attempt,
		Payload:        task.Payload,
	}, nil
}

func (p *APIPool) CompleteTask(ctx context.Context, taskID int64, runnerID int64, status, errorMessage string) error {
	if p == nil || p.client == nil {
		return fmt.Errorf("runner API client unavailable")
	}

	return p.client.CompleteTask(ctx, taskID, runnerID, status, errorMessage)
}

func (p *APIPool) GetTaskStatus(ctx context.Context, taskID, runnerID int64) (string, error) {
	if p == nil || p.client == nil {
		return "", fmt.Errorf("runner API client unavailable")
	}
	reader, ok := p.client.(interface {
		GetTaskStatus(context.Context, int64, int64) (string, error)
	})
	if !ok {
		return "", fmt.Errorf("runner task status client unavailable")
	}
	return reader.GetTaskStatus(ctx, taskID, runnerID)
}
