package services

import (
	"context"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A NUL byte survives JSON decoding and, if it reaches a Postgres text column,
// fails the write (SQLSTATE 22021) as an opaque 500. These name/title write paths
// must reject it up front via validateSafeText (they previously did not).

func TestOrgService_CreateOrg_RejectsNULInName(t *testing.T) {
	svc := NewOrgService(&mockOrgQuerier{}) // no DB call is reached; validation happens first
	_, err := svc.CreateOrg(context.Background(), testOrgUser(1, "owner"), CreateOrgRequest{Name: "evil\x00org"})
	requireAPIErrorStatus(t, err, 422)
}

func TestUserService_UpdateAuthenticatedUser_RejectsUnstorableProfileText(t *testing.T) {
	long := strings.Repeat("é", 256) // 256 characters, over the varchar(255) column
	for name, req := range map[string]UpdateUserRequest{
		"NUL in display name":   {DisplayName: strPtr("a\x00b")},
		"NUL in bio":            {Bio: strPtr("a\x00b")},
		"invalid UTF-8 bio":     {Bio: strPtr("a\xffb")},
		"display name too long": {DisplayName: &long},
	} {
		t.Run(name, func(t *testing.T) {
			svc := NewUserService(&mockUserQuerier{
				getUserByIDFn: func(context.Context, int64) (db.User, error) { return db.User{ID: 1}, nil },
				updateUserFn: func(context.Context, db.UpdateUserParams) (db.User, error) {
					t.Fatal("unstorable text must be rejected before the write")
					return db.User{}, nil
				},
			})
			_, err := svc.UpdateAuthenticatedUser(context.Background(), 1, req)
			requireAPIErrorStatus(t, err, 422)
		})
	}
}
