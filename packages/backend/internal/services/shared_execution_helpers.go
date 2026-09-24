package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const AlertRemediationTriggerEvent = "monitoring_alert"

type runnerTxStarter interface {
	BeginTx(context.Context) (pgx.Tx, error)
}

func IsTerminalWorkflowRunStatus(status string) bool {
	switch status {
	case "success", "failure", "cancelled", "error":
		return true
	default:
		return false
	}
}

func WorkflowRunStatusDescription(status string) string {
	switch status {
	case "success":
		return "Workflow completed successfully"
	case "failure":
		return "Workflow failed"
	case "cancelled":
		return "Workflow was cancelled"
	case "error":
		return "Workflow hit an infrastructure error"
	default:
		return fmt.Sprintf("Workflow status: %s", status)
	}
}

func ResourceStoreError(err error, resource string) error {
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, sandbox.ErrNotFound) {
		return pkgerrors.NotFound(resource + " not found")
	}
	return pkgerrors.Internal("could not load " + resource)
}
