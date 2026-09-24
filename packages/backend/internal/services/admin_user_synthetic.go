package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminSyntheticUserProfile adds classification only to the privileged mutation response.
// ID intentionally retains the existing admin API numeric representation for compatibility.
type AdminSyntheticUserProfile struct {
	UserProfile
	Synthetic bool `json:"synthetic"`
}

func (s *AdminUserService) SetSynthetic(ctx context.Context, username string, synthetic bool) (AdminSyntheticUserProfile, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if username == "" {
		return AdminSyntheticUserProfile{}, pkgerrors.BadRequest("username is required")
	}
	actor, ok := AdminAuditActorFromContext(ctx)
	if !ok || actor.UserID == 0 {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("admin audit actor is required")
	}
	beginner, ok := s.queries.(interface {
		BeginTx(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("synthetic updates require transactions")
	}
	tx, err := beginner.BeginTx(ctx)
	if err != nil {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("failed to begin synthetic update").WithCause(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	queries := db.New(tx)
	user, err := queries.AdminSetUserSynthetic(ctx, db.AdminSetUserSyntheticParams{LowerUsername: username, Synthetic: synthetic})
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminSyntheticUserProfile{}, pkgerrors.NotFound("user not found")
	}
	if err != nil {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("failed to update synthetic status").WithCause(err)
	}
	metadata, err := json.Marshal(map[string]bool{"synthetic": synthetic})
	if err != nil {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("failed to encode synthetic audit metadata").WithCause(err)
	}
	if err := queries.InsertAuditLog(ctx, db.InsertAuditLogParams{
		EventType:  "admin.user.set_synthetic",
		ActorID:    pgtype.Int8{Int64: actor.UserID, Valid: true},
		ActorName:  actor.Username,
		IpAddress:  actor.IPAddress,
		TargetType: "user",
		TargetID:   pgtype.Int8{Int64: user.ID, Valid: true},
		TargetName: user.Username,
		Action:     "set_synthetic",
		Metadata:   metadata,
	}); err != nil {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("failed to audit synthetic update").WithCause(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminSyntheticUserProfile{}, pkgerrors.Internal("failed to commit synthetic update").WithCause(err)
	}
	return AdminSyntheticUserProfile{UserProfile: mapUserProfile(user), Synthetic: user.IsSynthetic}, nil
}
