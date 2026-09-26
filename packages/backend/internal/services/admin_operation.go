package services

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminOperationLog records operator mutations as admin.<target>.<action>
// audit rows attributed to the acting admin in the request context.
type AdminOperationLog struct {
	q AuditQueries
}

// NewAdminOperationLog creates the audit trail shared by product and
// deployment admin operations.
func NewAdminOperationLog(q AuditQueries) *AdminOperationLog {
	return &AdminOperationLog{q: q}
}

// Operation commits intent before any external action. Both records share an
// operation ID and the target metadata; run may add outcome details to
// metadata before the second record. If the process dies or outcome
// persistence fails, the attempted record remains for operator reconciliation.
func (l *AdminOperationLog) Operation(ctx context.Context, target, id, action string, metadata map[string]any, run func() error) error {
	if err := requireAdminActor(ctx); err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["operation_id"] = uuid.NewString()
	metadata["outcome"] = "attempted"
	if err := l.record(ctx, target, id, action, metadata); err != nil {
		return err
	}
	operationErr := run()
	metadata["outcome"] = "succeeded"
	if operationErr != nil {
		metadata["outcome"] = "failed"
	}
	// Retry completion writes independently of client cancellation. The durable
	// attempt is never replaced, even if all completion writes fail.
	var auditErr error
	for attempt := 0; attempt < 3; attempt++ {
		auditErr = l.record(ctx, target, id, action, metadata)
		if auditErr == nil {
			break
		}
	}
	if auditErr != nil {
		slog.Error("admin operation outcome audit failed; durable attempt requires reconciliation", "operation_id", metadata["operation_id"], "target", id, "action", action)
	}
	if operationErr != nil {
		return operationErr
	}
	return auditErr
}

func (l *AdminOperationLog) record(ctx context.Context, target, id, action string, metadata map[string]any) error {
	actor, _ := AdminAuditActorFromContext(ctx)
	body, err := json.Marshal(metadata)
	if err != nil {
		return pkgerrors.Internal("encode admin audit").WithCause(err)
	}
	auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err = l.q.InsertAuditLog(auditCtx, db.InsertAuditLogParams{
		EventType: "admin." + target + "." + action, ActorID: pgtype.Int8{Int64: actor.UserID, Valid: true},
		ActorName: actor.Username, TargetType: target, TargetName: id, Action: action, Metadata: body, IpAddress: actor.IPAddress,
	}); err != nil {
		return pkgerrors.Internal("record admin audit").WithCause(err)
	}
	return nil
}

func requireAdminActor(ctx context.Context) error {
	actor, ok := AdminAuditActorFromContext(ctx)
	if !ok || actor.UserID <= 0 {
		return pkgerrors.Unauthorized("admin actor required")
	}
	return nil
}
