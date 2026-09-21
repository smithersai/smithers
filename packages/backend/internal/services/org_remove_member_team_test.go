package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Removing an org member must also strip that user's team memberships for the
// org. team_members has no cascade from org_members, so without this the removed
// user keeps team-based repo access (read/write/admin). The cleanup must also run
// BEFORE the org_members delete, so a partial failure can never leave the user
// removed-from-org-but-still-on-its-teams.
func TestOrgService_RemoveOrgMember_StripsTeamMemberships(t *testing.T) {
	t.Parallel()

	var order []string
	s := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
		q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		}
		q.countOrgOwnersFn = func(ctx context.Context, organizationID int64) (int64, error) {
			return 2, nil
		}
		q.deleteTeamMembershipsForOrgUserFn = func(ctx context.Context, arg db.DeleteTeamMembershipsForOrgUserParams) error {
			order = append(order, "team")
			assert.Equal(t, int64(7), arg.OrganizationID)
			assert.Equal(t, int64(2), arg.UserID)
			return nil
		}
		q.removeOrgMemberFn = func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
			order = append(order, "org")
			return nil
		}
	}))

	err := s.RemoveOrgMember(context.Background(), testOrgUser(1, "owner"), "acme", "bob")
	require.NoError(t, err)
	assert.Equal(t, []string{"team", "org"}, order, "team memberships must be stripped before org membership")
}
