package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestProtectedBookmark_Upsert_RejectsMalformedGlob(t *testing.T) {
	for _, pattern := range []string{"[", "release/[0-9", "a\\"} {
		t.Run(pattern, func(t *testing.T) {
			q := &mockProtectedBookmarkQuerier{}
			_, err := NewProtectedBookmarkService(q).UpsertProtectedBookmark(context.Background(), &db.User{ID: 1, IsAdmin: true}, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: pattern})
			require.Equal(t, 422, apiStatus(t, err))
			require.Empty(t, q.lastUpsertArg.Pattern, "malformed pattern must not be stored")
		})
	}
}

func TestProtectedBookmark_Delete_TrimsPatternLikeUpsert(t *testing.T) {
	q := &mockProtectedBookmarkQuerier{}
	svc := NewProtectedBookmarkService(q)
	actor := &db.User{ID: 1, IsAdmin: true}
	_, err := svc.UpsertProtectedBookmark(context.Background(), actor, "alice", "demo", UpsertProtectedBookmarkInput{Pattern: " main "})
	require.NoError(t, err)
	require.NoError(t, svc.DeleteProtectedBookmark(context.Background(), actor, "alice", "demo", " main "))
	require.Equal(t, q.lastUpsertArg.Pattern, q.lastDeleteArg.Pattern)
}

func TestProtectedBookmark_AdminAccess_PermissionQueryErrorIsInternal(t *testing.T) {
	boom := errors.New("db down")
	repo := db.Repository{ID: 11, UserID: pgtype.Int8{Int64: 99, Valid: true}, OrgID: pgtype.Int8{Int64: 5, Valid: true}}
	for name, q := range map[string]*mockProtectedBookmarkQuerier{
		"org owner": {isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) { return false, boom }},
		"team":      {getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) { return "", boom }},
		"collab":    {getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) { return "", boom }},
	} {
		t.Run(name, func(t *testing.T) {
			err := NewProtectedBookmarkService(q).requireAdminAccess(context.Background(), repo, &db.User{ID: 1})
			require.Equal(t, 500, apiStatus(t, err))
		})
	}
}
