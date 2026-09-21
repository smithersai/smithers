package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetLandedChangesetForChangeFindsSuperprojectAndMember(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "changeset-revert-author")
	orgID := mustCreateOrganization(t, pool, "changeset-revert-org")
	superprojectID := mustCreateOrgRepo(t, pool, orgID, "superproject", false)
	memberID := mustCreateOrgRepo(t, pool, orgID, "api", false)

	created, err := q.CreateChangeset(ctx, CreateChangesetParams{
		OrganizationID: orgID, SuperprojectRepositoryID: superprojectID,
		ChangeID: "super-change", CommitID: "super-commit", ParentChangeIds: []byte(`[]`),
		TargetBookmark: "main", CreatedBy: pgtype.Int8{Int64: userID, Valid: true},
	})
	require.NoError(t, err)
	_, err = q.AddChangesetMember(ctx, AddChangesetMemberParams{
		ChangesetID: created.ID, RepositoryID: memberID, Path: "api",
		ChangeID: "member-change", CommitID: "member-commit", TargetBookmark: "main",
	})
	require.NoError(t, err)
	landed, err := q.MarkChangesetLanded(ctx, MarkChangesetLandedParams{ID: created.ID, LandedCommitID: "landed-super-commit"})
	require.NoError(t, err)

	byMember, err := q.GetLandedChangesetForChange(ctx, GetLandedChangesetForChangeParams{
		RepositoryID: memberID, ChangeID: "member-change",
	})
	require.NoError(t, err)
	assert.Equal(t, landed.ID, byMember.ID)

	bySuperproject, err := q.GetLandedChangesetForChange(ctx, GetLandedChangesetForChangeParams{
		RepositoryID: superprojectID, ChangeID: "super-change",
	})
	require.NoError(t, err)
	assert.Equal(t, landed.ID, bySuperproject.ID)
}
