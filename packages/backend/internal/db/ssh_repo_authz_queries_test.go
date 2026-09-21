package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetRepoByOwnerAndName_ResolvesUserOwnedAndOrgOwned(t *testing.T) {
	q, pool := newQueries(t)

	userOwnerID := mustCreateUser(t, pool, "RepoOwner")
	userRepo, err := q.CreateRepo(context.Background(), CreateRepoParams{
		StorageSetID:    "s1",
		UserID:          pgtype.Int8{Int64: userOwnerID, Valid: true},
		Name:            "Mixed-Repo",
		LowerName:       "mixed-repo",
		Description:     "user-owned",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "Acme",
		LowerName:   "acme",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)
	orgRepo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		StorageSetID:    "s1",
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "Platform",
		LowerName:       "platform",
		Description:     "org-owned",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	tests := []struct {
		name            string
		ownerLookup     string
		repoLookup      string
		expectedRepoID  int64
		expectUserOwner bool
	}{
		{
			name:            "user-owned repository by username namespace",
			ownerLookup:     "repoowner",
			repoLookup:      "MIXED-REPO",
			expectedRepoID:  userRepo.ID,
			expectUserOwner: true,
		},
		{
			name:            "org-owned repository by organization namespace",
			ownerLookup:     "ACME",
			repoLookup:      "platform",
			expectedRepoID:  orgRepo.ID,
			expectUserOwner: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo, err := q.GetRepoByOwnerAndName(context.Background(), GetRepoByOwnerAndNameParams{
				Owner: tc.ownerLookup,
				Name:  tc.repoLookup,
			})
			require.NoError(t, err)
			assert.Equal(t, tc.expectedRepoID, repo.ID)

			if tc.expectUserOwner {
				assert.True(t, repo.UserID.Valid)
				assert.False(t, repo.OrgID.Valid)
			} else {
				assert.False(t, repo.UserID.Valid)
				assert.True(t, repo.OrgID.Valid)
			}
		})
	}
}

func TestIsOrgOwnerForRepoUser_ReturnsTrueOnlyForOwnerRole(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "owner-check-org",
		LowerName:   "owner-check-org",
		Description: "",
		Visibility:  "private",
	})
	require.NoError(t, err)
	repo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		StorageSetID:    "s1",
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "owner-check-repo",
		LowerName:       "owner-check-repo",
		Description:     "",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	orgOwnerID := mustCreateUser(t, pool, "org-owner-user")
	orgMemberID := mustCreateUser(t, pool, "org-member-user")
	outsiderID := mustCreateUser(t, pool, "org-outsider-user")

	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         orgOwnerID,
		Role:           "owner",
	})
	require.NoError(t, err)
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         orgMemberID,
		Role:           "member",
	})
	require.NoError(t, err)

	isOwner, err := q.IsOrgOwnerForRepoUser(context.Background(), IsOrgOwnerForRepoUserParams{
		RepositoryID: repo.ID,
		UserID:       orgOwnerID,
	})
	require.NoError(t, err)
	assert.True(t, isOwner)

	isOwner, err = q.IsOrgOwnerForRepoUser(context.Background(), IsOrgOwnerForRepoUserParams{
		RepositoryID: repo.ID,
		UserID:       orgMemberID,
	})
	require.NoError(t, err)
	assert.False(t, isOwner)

	isOwner, err = q.IsOrgOwnerForRepoUser(context.Background(), IsOrgOwnerForRepoUserParams{
		RepositoryID: repo.ID,
		UserID:       outsiderID,
	})
	require.NoError(t, err)
	assert.False(t, isOwner)
}

func TestGetCollaboratorPermissionForRepoUser_ReturnsPermissionAndEmptyWhenMissing(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "collab-user")
	ownerID := mustCreateUser(t, pool, "collab-owner")
	outsiderID := mustCreateUser(t, pool, "collab-outsider")
	repoID := mustCreateRepo(t, pool, ownerID, "collab-repo")

	permission, err := q.GetCollaboratorPermissionForRepoUser(context.Background(), GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "", permission)

	_, err = q.AddCollaborator(context.Background(), AddCollaboratorParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
		Permission:   "write",
	})
	require.NoError(t, err)

	permission, err = q.GetCollaboratorPermissionForRepoUser(context.Background(), GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "write", permission)

	permission, err = q.GetCollaboratorPermissionForRepoUser(context.Background(), GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: outsiderID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "", permission)
}

func TestAddCollaborator_RejectsDuplicateRepositoryUserPair(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "dup-collab-owner")
	collabID := mustCreateUser(t, pool, "dup-collab-user")
	repoID := mustCreateRepo(t, pool, ownerID, "dup-collab-repo")

	_, err := q.AddCollaborator(context.Background(), AddCollaboratorParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: collabID, Valid: true},
		Permission:   "read",
	})
	require.NoError(t, err)

	_, err = q.AddCollaborator(context.Background(), AddCollaboratorParams{
		RepositoryID: repoID,
		UserID:       pgtype.Int8{Int64: collabID, Valid: true},
		Permission:   "admin",
	})
	require.Error(t, err)
	assert.Contains(t, strings.ToLower(err.Error()), "unique")
}

func TestGetHighestTeamPermissionForRepoUser_ReturnsMaxPermission(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "team-permission-org",
		LowerName:   "team-permission-org",
		Description: "",
		Visibility:  "private",
	})
	require.NoError(t, err)
	repo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		StorageSetID:    "s1",
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "team-repo",
		LowerName:       "team-repo",
		Description:     "",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	noTeamUserID := mustCreateUser(t, pool, "team-none-user")
	readUserID := mustCreateUser(t, pool, "team-read-user")
	writeUserID := mustCreateUser(t, pool, "team-write-user")
	adminUserID := mustCreateUser(t, pool, "team-admin-user")
	multiTeamUserID := mustCreateUser(t, pool, "team-multi-user")

	// Team grants only count while the user is still an org member (stale
	// team_members rows must not confer access), so enroll everyone but the
	// no-team user in the organization.
	for _, uid := range []int64{readUserID, writeUserID, adminUserID, multiTeamUserID} {
		_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
			OrganizationID: org.ID,
			UserID:         uid,
			Role:           "member",
		})
		require.NoError(t, err)
	}

	readTeam, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Readers",
		LowerName:      "readers",
		Description:    "",
		Permission:     "read",
	})
	require.NoError(t, err)
	writeTeam, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Writers",
		LowerName:      "writers",
		Description:    "",
		Permission:     "write",
	})
	require.NoError(t, err)
	adminTeam, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Admins",
		LowerName:      "admins",
		Description:    "",
		Permission:     "admin",
	})
	require.NoError(t, err)

	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{TeamID: readTeam.ID, RepositoryID: repo.ID})
	require.NoError(t, err)
	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{TeamID: writeTeam.ID, RepositoryID: repo.ID})
	require.NoError(t, err)
	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{TeamID: adminTeam.ID, RepositoryID: repo.ID})
	require.NoError(t, err)

	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: readTeam.ID, UserID: readUserID})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: writeTeam.ID, UserID: writeUserID})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: adminTeam.ID, UserID: adminUserID})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: readTeam.ID, UserID: multiTeamUserID})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{TeamID: adminTeam.ID, UserID: multiTeamUserID})
	require.NoError(t, err)

	tests := []struct {
		name               string
		userID             int64
		expectedPermission string
	}{
		{
			name:               "no team access",
			userID:             noTeamUserID,
			expectedPermission: "",
		},
		{
			name:               "read permission",
			userID:             readUserID,
			expectedPermission: "read",
		},
		{
			name:               "write permission",
			userID:             writeUserID,
			expectedPermission: "write",
		},
		{
			name:               "admin permission",
			userID:             adminUserID,
			expectedPermission: "admin",
		},
		{
			name:               "multiple teams chooses highest permission",
			userID:             multiTeamUserID,
			expectedPermission: "admin",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			permission, err := q.GetHighestTeamPermissionForRepoUser(context.Background(), GetHighestTeamPermissionForRepoUserParams{
				RepositoryID: repo.ID,
				UserID:       tc.userID,
			})
			require.NoError(t, err)
			assert.Equal(t, tc.expectedPermission, permission)
		})
	}
}
