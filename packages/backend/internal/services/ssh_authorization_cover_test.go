package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSSHAuthorization_Cov_PublicReadArchivedAndPermissionErrors(t *testing.T) {
	t.Run("public repo allows read after empty permissions", func(t *testing.T) {
		svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
			getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
				return db.GetRepoByOwnerAndNameRow{ID: 1, IsPublic: true, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
			},
		})
		if err := svc.Authorize(context.Background(), 7, "alice", "demo", AccessModeRead); err != nil {
			t.Fatalf("Authorize public read returned error: %v", err)
		}
	})

	t.Run("archived repo denies write before owner", func(t *testing.T) {
		svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
			getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
				return db.GetRepoByOwnerAndNameRow{ID: 1, IsArchived: true, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
		})
		err := svc.Authorize(context.Background(), 7, "alice", "demo", AccessModeWrite)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusForbidden {
			t.Fatalf("archived err = %#v", err)
		}
	})

	t.Run("permission lookup errors map internal", func(t *testing.T) {
		svc := NewSSHAuthorizationService(&mockSSHAuthzQuerier{
			getRepoByOwnerAndNameFn: func(context.Context, db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
				return db.GetRepoByOwnerAndNameRow{ID: 1, OrgID: pgtype.Int8{Int64: 2, Valid: true}}, nil
			},
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, errors.New("db down")
			},
		})
		err := svc.Authorize(context.Background(), 7, "acme", "demo", AccessModeRead)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("org owner err = %#v", err)
		}
	})
}

func TestSSHAuthorization_Cov_PermissionAllowsInvalidMode(t *testing.T) {
	if permissionAllows("admin", AccessMode("execute")) {
		t.Fatal("invalid access mode should not be allowed")
	}
	if permissionAllows("read", AccessModeWrite) {
		t.Fatal("read permission should not allow write")
	}
}
