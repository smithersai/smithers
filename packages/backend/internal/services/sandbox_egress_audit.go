package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type SandboxEgressAuditQuerier interface {
	ListSandboxEgressAuditByResource(context.Context, db.ListSandboxEgressAuditByResourceParams) ([]db.SandboxEgressAudit, error)
}

type SandboxEgressAuditService struct {
	q SandboxEgressAuditQuerier
}

func NewSandboxEgressAuditService(q SandboxEgressAuditQuerier) *SandboxEgressAuditService {
	return &SandboxEgressAuditService{q: q}
}

type SandboxEgressAuditEntry struct {
	OccurredAt         time.Time `json:"occurred_at"`
	Host               string    `json:"host"`
	Method             string    `json:"method"`
	Path               string    `json:"path"`
	Status             int32     `json:"status"`
	Allowed            bool      `json:"allowed"`
	SwappedSecretNames []string  `json:"swapped_secret_names"`
}

type SandboxEgressAuditList struct {
	Items      []SandboxEgressAuditEntry
	NextCursor string
}

type sandboxEgressCursor struct {
	OccurredAt time.Time `json:"occurred_at"`
	ID         int64     `json:"id"`
}

func (s *SandboxEgressAuditService) List(ctx context.Context, resourceKind, resourceID string, repositoryID int64, cursor string, limit int) (SandboxEgressAuditList, error) {
	if s == nil || s.q == nil {
		return SandboxEgressAuditList{}, pkgerrors.Internal("sandbox egress audit store unavailable")
	}
	if resourceKind != "agent_session" && resourceKind != "workspace" {
		return SandboxEgressAuditList{}, pkgerrors.BadRequest("invalid egress audit resource kind")
	}
	if limit < 1 || limit > 100 {
		limit = 30
	}
	position, err := decodeSandboxEgressCursor(cursor)
	if err != nil {
		return SandboxEgressAuditList{}, pkgerrors.BadRequest("invalid egress audit cursor")
	}
	rows, err := s.q.ListSandboxEgressAuditByResource(ctx, db.ListSandboxEgressAuditByResourceParams{
		ResourceKind:     resourceKind,
		ResourceID:       resourceID,
		RepositoryID:     pgtype.Int8{Int64: repositoryID, Valid: true},
		HasCursor:        cursor != "",
		CursorOccurredAt: position.OccurredAt,
		CursorID:         position.ID,
		PageSize:         int32(limit + 1),
	})
	if err != nil {
		return SandboxEgressAuditList{}, pkgerrors.Internal("list sandbox egress audit: " + err.Error())
	}
	result := SandboxEgressAuditList{Items: make([]SandboxEgressAuditEntry, 0, min(limit, len(rows)))}
	if len(rows) > limit {
		last := rows[limit-1]
		result.NextCursor = encodeSandboxEgressCursor(sandboxEgressCursor{OccurredAt: last.OccurredAt, ID: last.ID})
		rows = rows[:limit]
	}
	for _, row := range rows {
		result.Items = append(result.Items, SandboxEgressAuditEntry{
			OccurredAt: row.OccurredAt, Host: row.Host, Method: row.Method, Path: row.Path,
			Status: row.Status, Allowed: row.Allowed,
			SwappedSecretNames: append([]string{}, row.SwappedSecretNames...),
		})
	}
	return result, nil
}

func encodeSandboxEgressCursor(cursor sandboxEgressCursor) string {
	payload, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeSandboxEgressCursor(cursor string) (sandboxEgressCursor, error) {
	if cursor == "" {
		return sandboxEgressCursor{}, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return sandboxEgressCursor{}, err
	}
	var value sandboxEgressCursor
	decoderErr := json.Unmarshal(payload, &value)
	if decoderErr != nil || value.ID <= 0 || value.OccurredAt.IsZero() {
		return sandboxEgressCursor{}, errors.New("invalid cursor")
	}
	return value, nil
}
