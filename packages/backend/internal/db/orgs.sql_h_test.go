package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type orgsSQLHDB = chunk4SQLHDB
type orgsSQLHRow = chunk4SQLHRow
type orgsSQLHRows = chunk4SQLHRows

func TestOrgsSQL_H_ListCountAndDeleteMemberships(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	orgSlug := "org-h-" + randSlug(t)
	org, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name:        orgSlug,
		LowerName:   orgSlug,
		Description: "chunk h org",
		Visibility:  "private",
	})
	require.NoError(t, err)
	secondOrgSlug := "org-h-second-" + randSlug(t)
	secondOrg, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name:        secondOrgSlug,
		LowerName:   secondOrgSlug,
		Description: "chunk h second org",
		Visibility:  "public",
	})
	require.NoError(t, err)

	ownerID := mustCreateUser(t, pool, uniqueTestUsername(t))
	memberID := mustCreateUser(t, pool, uniqueTestUsername(t))
	_, err = q.AddOrgMember(ctx, AddOrgMemberParams{OrganizationID: org.ID, UserID: ownerID, Role: "owner"})
	require.NoError(t, err)
	_, err = q.AddOrgMember(ctx, AddOrgMemberParams{OrganizationID: org.ID, UserID: memberID, Role: "member"})
	require.NoError(t, err)

	team, err := q.CreateTeam(ctx, CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "Core H",
		LowerName:      "core-h-" + randSlug(t),
		Description:    "core team",
		Permission:     "write",
	})
	require.NoError(t, err)
	_, err = q.AddTeamMember(ctx, AddTeamMemberParams{TeamID: team.ID, UserID: memberID})
	require.NoError(t, err)
	repoID := mustCreateOrgRepo(t, pool, org.ID, "org-h-repo-"+randSlug(t), true)
	_, err = q.AddTeamRepo(ctx, AddTeamRepoParams{TeamID: team.ID, RepositoryID: repoID})
	require.NoError(t, err)

	allCount, err := q.CountAllOrgs(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(2), allCount)
	ownerCount, err := q.CountOrgOwners(ctx, org.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), ownerCount)
	zeroOwnerCount, err := q.CountOrgOwners(ctx, secondOrg.ID)
	require.NoError(t, err)
	assert.Zero(t, zeroOwnerCount)

	orgs, err := q.ListAllOrgs(ctx, ListAllOrgsParams{PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, orgs, 2)
	assert.Equal(t, org.ID, orgs[0].ID)
	emptyOrgs, err := q.ListAllOrgs(ctx, ListAllOrgsParams{PageOffset: 99, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyOrgs)

	members, err := q.ListOrgMembers(ctx, ListOrgMembersParams{OrganizationID: org.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, members, 2)
	assert.Equal(t, ownerID, members[0].ID)
	assert.Equal(t, "owner", members[0].Role)

	teams, err := q.ListOrgTeams(ctx, ListOrgTeamsParams{OrganizationID: org.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, teams, 1)
	assert.Equal(t, team.ID, teams[0].ID)

	teamMembers, err := q.ListTeamMembers(ctx, ListTeamMembersParams{TeamID: team.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, teamMembers, 1)
	assert.Equal(t, memberID, teamMembers[0].ID)

	teamRepos, err := q.ListTeamRepos(ctx, ListTeamReposParams{TeamID: team.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, teamRepos, 1)
	assert.Equal(t, repoID, teamRepos[0].ID)

	userOrgs, err := q.ListUserOrgs(ctx, ListUserOrgsParams{UserID: memberID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, userOrgs, 1)
	assert.Equal(t, org.ID, userOrgs[0].ID)
	emptyUserOrgs, err := q.ListUserOrgs(ctx, ListUserOrgsParams{UserID: 999999, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, emptyUserOrgs)

	require.NoError(t, q.DeleteTeamMembershipsForOrgUser(ctx, DeleteTeamMembershipsForOrgUserParams{
		UserID:         memberID,
		OrganizationID: org.ID,
	}))
	teamMembers, err = q.ListTeamMembers(ctx, ListTeamMembersParams{TeamID: team.ID, PageOffset: 0, PageSize: 10})
	require.NoError(t, err)
	assert.Empty(t, teamMembers)
	require.NoError(t, q.DeleteTeamMembershipsForOrgUser(ctx, DeleteTeamMembershipsForOrgUserParams{
		UserID:         memberID,
		OrganizationID: org.ID,
	}))
}

func TestOrgsSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("orgs h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"ListAllOrgs", func(q *Queries) error {
			_, err := q.ListAllOrgs(context.Background(), ListAllOrgsParams{PageSize: 1})
			return err
		}},
		{"ListOrgMembers", func(q *Queries) error {
			_, err := q.ListOrgMembers(context.Background(), ListOrgMembersParams{OrganizationID: 1, PageSize: 1})
			return err
		}},
		{"ListOrgTeams", func(q *Queries) error {
			_, err := q.ListOrgTeams(context.Background(), ListOrgTeamsParams{OrganizationID: 1, PageSize: 1})
			return err
		}},
		{"ListTeamMembers", func(q *Queries) error {
			_, err := q.ListTeamMembers(context.Background(), ListTeamMembersParams{TeamID: 1, PageSize: 1})
			return err
		}},
		{"ListTeamRepos", func(q *Queries) error {
			_, err := q.ListTeamRepos(context.Background(), ListTeamReposParams{TeamID: 1, PageSize: 1})
			return err
		}},
		{"ListUserOrgs", func(q *Queries) error {
			_, err := q.ListUserOrgs(context.Background(), ListUserOrgsParams{UserID: 1, PageSize: 1})
			return err
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(orgsSQLHDB{queryErr: sentinel})), sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(orgsSQLHDB{rows: &orgsSQLHRows{next: true, scanErr: sentinel}})), sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			require.ErrorIs(t, tc.call(New(orgsSQLHDB{rows: &orgsSQLHRows{err: sentinel}})), sentinel)
		})
	}
}

func TestOrgsSQL_H_QueryRowAndExecErrorBranches(t *testing.T) {
	sentinel := errors.New("orgs h failed")
	rowQ := New(orgsSQLHDB{row: orgsSQLHRow{err: sentinel}})
	_, err := rowQ.CountAllOrgs(context.Background())
	require.ErrorIs(t, err, sentinel)
	_, err = rowQ.CountOrgOwners(context.Background(), 1)
	require.ErrorIs(t, err, sentinel)

	execQ := New(orgsSQLHDB{execErr: sentinel})
	require.ErrorIs(t, execQ.DeleteTeamMembershipsForOrgUser(context.Background(), DeleteTeamMembershipsForOrgUserParams{}), sentinel)
}

type chunk4SQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db chunk4SQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db chunk4SQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &chunk4SQLHRows{}, nil
}

func (db chunk4SQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return chunk4SQLHRow{err: errors.New("chunk4 h row failed")}
}

type chunk4SQLHRow struct {
	err error
}

func (r chunk4SQLHRow) Scan(...any) error {
	return r.err
}

type chunk4SQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *chunk4SQLHRows) Close() {}

func (r *chunk4SQLHRows) Err() error {
	return r.err
}

func (r *chunk4SQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *chunk4SQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *chunk4SQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *chunk4SQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("chunk4 h scan unexpectedly succeeded")
}

func (r *chunk4SQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *chunk4SQLHRows) RawValues() [][]byte {
	return nil
}

func (r *chunk4SQLHRows) Conn() *pgx.Conn {
	return nil
}
