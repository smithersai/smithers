package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The ownership resolver asks which of the repository's organization teams a
// reviewer belongs to. The join must follow repositories.org_id: the query
// used to name a column the table does not have, so every landing that
// carried a submitted approval failed with SQLSTATE 42703 and surfaced as
// "invalid ownership configuration".
func TestListTeamNamesForUserByRepository_FollowsRepositoryOrganization(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	slug := randSlug(t)[:16]

	userID := mustCreateUser(t, pool, "team-names-"+slug)
	orgID := mustCreateOrganization(t, pool, "org-"+slug)
	otherOrgID := mustCreateOrganization(t, pool, "other-"+slug)
	repoID := mustCreateOrgRepo(t, pool, orgID, "repo-"+slug, true)

	reviewers := mustCreateTeam(t, pool, orgID, "Reviewers")
	mustAddTeamMember(t, pool, reviewers, userID)
	// Membership in another organization's team must not count for this
	// repository, and a team the user is not on stays out.
	foreign := mustCreateTeam(t, pool, otherOrgID, "Foreign")
	mustAddTeamMember(t, pool, foreign, userID)
	_ = mustCreateTeam(t, pool, orgID, "Others")

	names, err := q.ListTeamNamesForUserByRepository(ctx, ListTeamNamesForUserByRepositoryParams{RepositoryID: repoID, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, []string{"reviewers"}, names)
}
