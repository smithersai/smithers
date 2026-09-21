package services

import (
	"context"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Stream heads are read behind the same parent-row barrier used by writers
// before ID allocation. A global sequence is not a commit-order guarantee.
func (s *AgentService) GetAgentMessageStreamHead(ctx context.Context, sessionID string) (int64, error) {
	q, ok := s.q.(interface {
		GetAgentMessageStreamHead(context.Context, string) (int64, error)
	})
	if !ok {
		return 0, pkgerrors.Internal("agent stream head unavailable")
	}
	return q.GetAgentMessageStreamHead(ctx, sessionID)
}

func (s *NotificationService) GetNotificationStreamHead(ctx context.Context, userID int64) (int64, error) {
	q, ok := s.q.(interface {
		GetNotificationStreamHead(context.Context, int64) (int64, error)
	})
	if !ok {
		return 0, pkgerrors.Internal("notification stream head unavailable")
	}
	return q.GetNotificationStreamHead(ctx, userID)
}

func (s *workflowAPIService) GetWorkflowLogStreamHead(ctx context.Context, runID int64) (int64, error) {
	q, ok := s.queries.(interface {
		GetWorkflowLogStreamHead(context.Context, int64) (int64, error)
	})
	if !ok {
		return 0, pkgerrors.Internal("workflow stream head unavailable")
	}
	return q.GetWorkflowLogStreamHead(ctx, runID)
}
