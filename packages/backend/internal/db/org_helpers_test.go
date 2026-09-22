package db

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func mustCreateOrganization(t *testing.T, db DBTX, name string) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := db.QueryRow(
		context.Background(),
		`INSERT INTO organizations (name, lower_name, description) VALUES ($1, $2, '') RETURNING id`,
		name, lowerName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func mustCreateOrgRepo(t *testing.T, db DBTX, orgID int64, name string, isPublic bool) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := db.QueryRow(
		context.Background(),
		`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', $4, 'main', 1) RETURNING id`,
		orgID, name, lowerName, isPublic,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func mustAddOrgMember(t *testing.T, db DBTX, orgID, userID int64, role string) {
	t.Helper()
	_, err := db.Exec(
		context.Background(),
		`INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, $3)`,
		orgID, userID, role,
	)
	require.NoError(t, err)
}

func mustCreateTeam(t *testing.T, db DBTX, orgID int64, name string) int64 {
	t.Helper()
	lowerName := strings.ToLower(name)
	var id int64
	err := db.QueryRow(
		context.Background(),
		`INSERT INTO teams (organization_id, name, lower_name, permission) VALUES ($1, $2, $3, 'read') RETURNING id`,
		orgID, name, lowerName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func mustAddTeamMember(t *testing.T, db DBTX, teamID, userID int64) {
	t.Helper()
	_, err := db.Exec(
		context.Background(),
		`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`,
		teamID, userID,
	)
	require.NoError(t, err)
}

func mustAddTeamRepo(t *testing.T, db DBTX, teamID, repoID int64) {
	t.Helper()
	_, err := db.Exec(
		context.Background(),
		`INSERT INTO team_repos (team_id, repository_id) VALUES ($1, $2)`,
		teamID, repoID,
	)
	require.NoError(t, err)
}
