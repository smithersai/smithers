package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateOrganization(t *testing.T) {
	q, _ := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "Acme",
		LowerName:   "acme",
		Description: "Acme Org",
		Visibility:  "public",
	})
	require.NoError(t, err)
	assert.Equal(t, "acme", org.LowerName)
	assert.Equal(t, "public", org.Visibility)
}

func TestAddOrgMember_UniquePerUserOrg(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "Wrench",
		LowerName:   "wrench",
		Description: "",
		Visibility:  "private",
	})
	require.NoError(t, err)

	userID := mustCreateUser(t, pool, "org-member")

	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
		Role:           "member",
	})
	require.NoError(t, err)

	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
		Role:           "member",
	})
	require.Error(t, err)
}

func TestAddTeamMember_AndTeamRepoMapping(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "team-org",
		LowerName:   "team-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Core",
		LowerName:      "core",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)

	userID := mustCreateUser(t, pool, "team-member")
	var repoID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'team-repo', 'team-repo', '', TRUE, 'main') RETURNING id`,
		org.ID,
	).Scan(&repoID)
	require.NoError(t, err)

	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: team.ID, UserID: userID})
	require.NoError(t, err)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: team.ID, UserID: userID})
		return err
	})

	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{TeamID: team.ID, RepositoryID: repoID})
	require.NoError(t, err)

	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{TeamID: team.ID, RepositoryID: repoID})
	require.Error(t, err)
}

func TestOrganizationLookupAndUpdate(t *testing.T) {
	q, _ := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "lookup-org",
		LowerName:   "lookup-org",
		Description: "before",
		Visibility:  "public",
	})
	require.NoError(t, err)

	foundByID, err := q.GetOrgByID(context.Background(), org.ID)
	require.NoError(t, err)
	assert.Equal(t, org.ID, foundByID.ID)

	foundByName, err := q.GetOrgByLowerName(context.Background(), "lookup-org")
	require.NoError(t, err)
	assert.Equal(t, org.ID, foundByName.ID)

	updated, err := q.UpdateOrganization(context.Background(), UpdateOrganizationParams{
		ID:          org.ID,
		Name:        org.Name,
		LowerName:   org.LowerName,
		Description: "after",
		Visibility:  "limited",
		Website:     "https://example.com",
		Location:    "Austin",
	})
	require.NoError(t, err)
	assert.Equal(t, org.Name, updated.Name)
	assert.Equal(t, org.LowerName, updated.LowerName)
	assert.Equal(t, "after", updated.Description)
	assert.Equal(t, "limited", updated.Visibility)
}

func TestOrgMembershipQueries(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "members-org",
		LowerName:   "members-org",
		Description: "",
		Visibility:  "private",
	})
	require.NoError(t, err)

	userID := mustCreateUser(t, pool, "org-owner")
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
		Role:           "owner",
	})
	require.NoError(t, err)

	member, err := q.GetOrgMember(context.Background(), GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
	})
	require.NoError(t, err)
	assert.Equal(t, "owner", member.Role)

	err = q.UpdateOrgMemberRole(context.Background(), UpdateOrgMemberRoleParams{
		OrganizationID: org.ID,
		UserID:         userID,
		Role:           "member",
	})
	require.NoError(t, err)

	members, err := q.ListOrgMembers(context.Background(), ListOrgMembersParams{
		OrganizationID: org.ID,
		PageSize:       10,
		PageOffset:     0,
	})
	require.NoError(t, err)
	require.Len(t, members, 1)
	assert.Equal(t, "member", members[0].Role)

	count, err := q.CountOrgMembers(context.Background(), org.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)

	userOrgs, err := q.ListUserOrgs(context.Background(), ListUserOrgsParams{
		UserID:     userID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, userOrgs, 1)
	assert.Equal(t, org.ID, userOrgs[0].ID)

	err = q.RemoveOrgMember(context.Background(), RemoveOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
	})
	require.NoError(t, err)

	_, err = q.GetOrgMember(context.Background(), GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestTeamQueries(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "team-queries-org",
		LowerName:   "team-queries-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Platform",
		LowerName:      "platform",
		Description:    "team",
		Permission:     "write",
	})
	require.NoError(t, err)

	foundByID, err := q.GetTeamByID(context.Background(), team.ID)
	require.NoError(t, err)
	assert.Equal(t, team.ID, foundByID.ID)

	foundByOrgAndName, err := q.GetTeamByOrgAndLowerName(context.Background(), GetTeamByOrgAndLowerNameParams{
		OrganizationID: org.ID,
		LowerName:      "platform",
	})
	require.NoError(t, err)
	assert.Equal(t, team.ID, foundByOrgAndName.ID)

	updated, err := q.UpdateTeam(context.Background(), UpdateTeamParams{
		ID:          team.ID,
		Name:        "Core Platform",
		LowerName:   "core-platform",
		Description: "updated",
		Permission:  "admin",
	})
	require.NoError(t, err)
	assert.Equal(t, "core-platform", updated.LowerName)
	assert.Equal(t, "admin", updated.Permission)

	userID := mustCreateUser(t, pool, "team-queries-member")
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{
		TeamID: updated.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	teamMembers, err := q.ListTeamMembers(context.Background(), ListTeamMembersParams{
		TeamID:     updated.ID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, teamMembers, 1)
	assert.Equal(t, userID, teamMembers[0].ID)

	repoID := mustCreateRepo(t, pool, userID, "team-visible-repo")
	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{
		TeamID:       updated.ID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)

	repos, err := q.ListTeamRepos(context.Background(), ListTeamReposParams{
		TeamID:     updated.ID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, repoID, repos[0].ID)

	err = q.RemoveTeamMember(context.Background(), RemoveTeamMemberParams{
		TeamID: updated.ID,
		UserID: userID,
	})
	require.NoError(t, err)

	err = q.RemoveTeamRepo(context.Background(), RemoveTeamRepoParams{
		TeamID:       updated.ID,
		RepositoryID: repoID,
	})
	require.NoError(t, err)

	teams, err := q.ListOrgTeams(context.Background(), ListOrgTeamsParams{
		OrganizationID: org.ID,
		PageSize:       10,
		PageOffset:     0,
	})
	require.NoError(t, err)
	require.Len(t, teams, 1)
	assert.Equal(t, updated.ID, teams[0].ID)

	teamCount, err := q.CountOrgTeams(context.Background(), org.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), teamCount)

	err = q.DeleteTeam(context.Background(), updated.ID)
	require.NoError(t, err)

	_, err = q.GetTeamByID(context.Background(), updated.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestAddTeamMemberIfOrgMember_EnforcesOrgMembership(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "safe-team-org",
		LowerName:   "safe-team-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Core",
		LowerName:      "core",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)

	memberID := mustCreateUser(t, pool, "safe-team-member")
	outsiderID := mustCreateUser(t, pool, "safe-team-outsider")

	// Add member to the org.
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         memberID,
		Role:           "member",
	})
	require.NoError(t, err)

	// Org member can be added to team via safe query.
	tm, err := q.AddTeamMemberIfOrgMember(context.Background(), AddTeamMemberIfOrgMemberParams{
		TeamID: team.ID,
		UserID: memberID,
	})
	require.NoError(t, err)
	assert.Equal(t, memberID, tm.UserID)
	assert.Equal(t, team.ID, tm.TeamID)

	// Non-org-member should fail (INSERT returns no rows → pgx.ErrNoRows).
	_, err = q.AddTeamMemberIfOrgMember(context.Background(), AddTeamMemberIfOrgMemberParams{
		TeamID: team.ID,
		UserID: outsiderID,
	})
	require.Error(t, err)
}

func TestAddTeamRepoIfOrgRepo_EnforcesOrgOwnership(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "repo-guard-org",
		LowerName:   "repo-guard-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Platform",
		LowerName:      "platform",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)

	// Create an org repo.
	var orgRepoID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'org-safe-repo', 'org-safe-repo', '', TRUE, 'main') RETURNING id`,
		org.ID,
	).Scan(&orgRepoID)
	require.NoError(t, err)

	// Create a user repo (not owned by the org).
	userID := mustCreateUser(t, pool, "repo-guard-user")
	userRepoID := mustCreateRepo(t, pool, userID, "user-only-repo")

	// Org repo can be added via safe query.
	tr, err := q.AddTeamRepoIfOrgRepo(context.Background(), AddTeamRepoIfOrgRepoParams{
		TeamID:       team.ID,
		RepositoryID: orgRepoID,
	})
	require.NoError(t, err)
	assert.Equal(t, orgRepoID, tr.RepositoryID)

	// Non-org repo should fail.
	_, err = q.AddTeamRepoIfOrgRepo(context.Background(), AddTeamRepoIfOrgRepoParams{
		TeamID:       team.ID,
		RepositoryID: userRepoID,
	})
	require.Error(t, err)
}

func TestCountUserOrgs(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "count-user-orgs")

	org1, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "count-org-one",
		LowerName:   "count-org-one",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)
	org2, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "count-org-two",
		LowerName:   "count-org-two",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org1.ID,
		UserID:         userID,
		Role:           "member",
	})
	require.NoError(t, err)
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org2.ID,
		UserID:         userID,
		Role:           "member",
	})
	require.NoError(t, err)

	count, err := q.CountUserOrgs(context.Background(), userID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}

func TestCountTeamMembers(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "count-team-members-org",
		LowerName:   "count-team-members-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)
	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Core",
		LowerName:      "core",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)

	userOne := mustCreateUser(t, pool, "count-team-member-one")
	userTwo := mustCreateUser(t, pool, "count-team-member-two")

	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{
		TeamID: team.ID,
		UserID: userOne,
	})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{
		TeamID: team.ID,
		UserID: userTwo,
	})
	require.NoError(t, err)

	count, err := q.CountTeamMembers(context.Background(), team.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}

func TestCountTeamRepos(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "count-team-repos-org",
		LowerName:   "count-team-repos-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)
	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Core",
		LowerName:      "core",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)

	var repoOneID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'repo-one', 'repo-one', '', TRUE, 'main') RETURNING id`,
		org.ID,
	).Scan(&repoOneID)
	require.NoError(t, err)
	var repoTwoID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'repo-two', 'repo-two', '', TRUE, 'main') RETURNING id`,
		org.ID,
	).Scan(&repoTwoID)
	require.NoError(t, err)

	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{
		TeamID:       team.ID,
		RepositoryID: repoOneID,
	})
	require.NoError(t, err)
	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{
		TeamID:       team.ID,
		RepositoryID: repoTwoID,
	})
	require.NoError(t, err)

	count, err := q.CountTeamRepos(context.Background(), team.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}
