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

func TestProtectedBookmark_Cov_AdminAccessViaOrgTeamAndCollaborator(t *testing.T) {
	actor := &db.User{ID: 7, Username: "maintainer"}

	for _, tc := range []struct {
		name       string
		orgOwner   bool
		teamPerm   string
		collabPerm string
	}{
		{name: "org owner", orgOwner: true},
		{name: "team admin", teamPerm: "admin"},
		{name: "collaborator admin", collabPerm: "admin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockProtectedBookmarkQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return db.Repository{ID: 4, UserID: pgtype.Int8{Int64: 99, Valid: true}, OrgID: pgtype.Int8{Int64: 5, Valid: true}}, nil
				},
				isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
					return tc.orgOwner, nil
				},
				getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.teamPerm, nil
				},
				getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
					return tc.collabPerm, nil
				},
				listProtectedBookmarksByRepoFn: func(_ context.Context, arg db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
					if arg.PageOffset != 0 || arg.PageSize != 30 {
						t.Fatalf("pagination = %+v, want default offset 0 size 30", arg)
					}
					return []db.ProtectedBookmark{{ID: 1, Pattern: "main"}}, nil
				},
			}

			rows, err := NewProtectedBookmarkService(q).ListProtectedBookmarks(context.Background(), actor, "alice", "demo", 0, 0)
			if err != nil {
				t.Fatalf("ListProtectedBookmarks returned error: %v", err)
			}
			if len(rows) != 1 || rows[0].Pattern != "main" {
				t.Fatalf("rows = %+v", rows)
			}
		})
	}
}

func TestProtectedBookmark_Cov_DeleteAndInternalErrors(t *testing.T) {
	actor := &db.User{ID: 1, IsAdmin: true}

	t.Run("delete success uses trimmed pattern", func(t *testing.T) {
		q := &mockProtectedBookmarkQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 44}, nil
			},
		}
		err := NewProtectedBookmarkService(q).DeleteProtectedBookmark(context.Background(), actor, "alice", "demo", " release/* ")
		if err != nil {
			t.Fatalf("DeleteProtectedBookmark returned error: %v", err)
		}
		if q.lastDeleteArg.Pattern != "release/*" || q.lastDeleteArg.RepositoryID != 44 {
			t.Fatalf("delete args = %+v", q.lastDeleteArg)
		}
	})

	t.Run("list db error maps internal", func(t *testing.T) {
		q := &mockProtectedBookmarkQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 44}, nil
			},
			listProtectedBookmarksByRepoFn: func(context.Context, db.ListProtectedBookmarksByRepoParams) ([]db.ProtectedBookmark, error) {
				return nil, errors.New("boom")
			},
		}
		_, err := NewProtectedBookmarkService(q).ListProtectedBookmarks(context.Background(), actor, "alice", "demo", 1, 1)
		apiErr, ok := err.(*pkgerrors.APIError)
		if !ok || apiErr.Status != http.StatusInternalServerError {
			t.Fatalf("err = %#v, want internal", err)
		}
	})
}
