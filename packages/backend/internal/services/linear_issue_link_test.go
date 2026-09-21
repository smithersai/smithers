package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeLinearIssueLinkQuerier struct {
	repo                db.Repository
	issue               db.Issue
	integrations        []db.LinearIntegration
	issueMap            db.LinearIssueMap
	getMapErr           error
	createMapErr        error
	deleteRows          int64
	createdMap          db.CreateLinearIssueMapParams
	deletedMapID        int64
	listIntegrationsErr error
}

func (q *fakeLinearIssueLinkQuerier) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if arg.Owner != "alice" || arg.LowerName != "demo" {
		return db.Repository{}, pgx.ErrNoRows
	}
	return q.repo, nil
}

func (q *fakeLinearIssueLinkQuerier) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (q *fakeLinearIssueLinkQuerier) GetHighestTeamPermissionForRepoUser(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (q *fakeLinearIssueLinkQuerier) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (q *fakeLinearIssueLinkQuerier) GetIssueByNumber(_ context.Context, arg db.GetIssueByNumberParams) (db.Issue, error) {
	if arg.RepositoryID != q.repo.ID || arg.Number != q.issue.Number {
		return db.Issue{}, pgx.ErrNoRows
	}
	return q.issue, nil
}

func (q *fakeLinearIssueLinkQuerier) ListLinearIntegrationsByRepo(_ context.Context, repoID int64) ([]db.LinearIntegration, error) {
	if q.listIntegrationsErr != nil {
		return nil, q.listIntegrationsErr
	}
	if repoID != q.repo.ID {
		return nil, pgx.ErrNoRows
	}
	return q.integrations, nil
}

func (q *fakeLinearIssueLinkQuerier) GetLinearIssueMapBySmithersIssueID(context.Context, int64) (db.LinearIssueMap, error) {
	return q.issueMap, q.getMapErr
}

func (q *fakeLinearIssueLinkQuerier) CreateLinearIssueMap(_ context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error) {
	q.createdMap = arg
	if q.createMapErr != nil {
		return db.LinearIssueMap{}, q.createMapErr
	}
	return db.LinearIssueMap{
		ID:               31,
		IntegrationID:    arg.IntegrationID,
		JjhubIssueID:     arg.JjhubIssueID,
		JjhubIssueNumber: arg.JjhubIssueNumber,
		LinearIssueID:    arg.LinearIssueID,
		LinearIdentifier: arg.LinearIdentifier,
	}, nil
}

func (q *fakeLinearIssueLinkQuerier) DeleteLinearIssueMapByID(_ context.Context, id int64) (int64, error) {
	q.deletedMapID = id
	return q.deleteRows, nil
}

type fakeLinearIssueIntegrationAccess struct {
	token string
}

func (a *fakeLinearIssueIntegrationAccess) RefreshTokenIfNeeded(_ context.Context, integration db.LinearIntegration) (db.LinearIntegration, error) {
	return integration, nil
}

func (a *fakeLinearIssueIntegrationAccess) GetDecryptedAccessToken(context.Context, db.LinearIntegration) (string, error) {
	return a.token, nil
}

type fakeLinearIssueLookupClient struct {
	issue         LinearIssue
	gotToken      string
	gotIdentifier string
}

func (c *fakeLinearIssueLookupClient) FetchIssue(_ context.Context, token, identifier string) (LinearIssue, error) {
	c.gotToken = token
	c.gotIdentifier = identifier
	return c.issue, nil
}

func newLinearIssueLinkTestService() (*LinearIssueLinkService, *fakeLinearIssueLinkQuerier, *fakeLinearIssueLookupClient, *db.User) {
	actor := &db.User{ID: 7, Username: "alice"}
	repo := db.Repository{ID: 11, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: actor.ID, Valid: true}}
	issue := db.Issue{ID: 19, RepositoryID: repo.ID, Number: 4}
	integration := db.LinearIntegration{ID: 23, JjhubRepoID: repo.ID, LinearTeamID: "team-eng", LinearTeamKey: "ENG"}
	q := &fakeLinearIssueLinkQuerier{
		repo:         repo,
		issue:        issue,
		integrations: []db.LinearIntegration{integration},
		getMapErr:    pgx.ErrNoRows,
		deleteRows:   1,
	}
	client := &fakeLinearIssueLookupClient{issue: LinearIssue{
		ID:         "linear-482",
		Identifier: "ENG-482",
		Team:       LinearTeam{ID: integration.LinearTeamID, Key: "ENG"},
	}}
	svc := NewLinearIssueLinkService(q, &fakeLinearIssueIntegrationAccess{token: "access-token"}, client)
	return svc, q, client, actor
}

func TestLinearIssueLinkService_LinkIssue(t *testing.T) {
	t.Parallel()

	svc, q, client, actor := newLinearIssueLinkTestService()
	linked, err := svc.LinkIssue(context.Background(), actor, "Alice", "Demo", 4, LinearIssueLinkInput{Identifier: "  eng-482  "})
	require.NoError(t, err)

	assert.Equal(t, "access-token", client.gotToken)
	assert.Equal(t, "eng-482", client.gotIdentifier)
	assert.Equal(t, int64(23), q.createdMap.IntegrationID)
	assert.Equal(t, int64(19), q.createdMap.JjhubIssueID)
	assert.Equal(t, int64(4), q.createdMap.JjhubIssueNumber)
	assert.Equal(t, "linear-482", q.createdMap.LinearIssueID)
	assert.Equal(t, "ENG-482", q.createdMap.LinearIdentifier)
	assert.Equal(t, LinearIssueReference{Identifier: "ENG-482", URL: "https://linear.app/issue/ENG-482"}, linked)
}

func TestLinearIssueLinkService_RejectsWrongTeamAndDuplicateLinks(t *testing.T) {
	t.Parallel()

	t.Run("wrong Linear team", func(t *testing.T) {
		svc, q, client, actor := newLinearIssueLinkTestService()
		client.issue.Team.ID = "team-other"
		_, err := svc.LinkIssue(context.Background(), actor, "alice", "demo", 4, LinearIssueLinkInput{Identifier: "ENG-482"})
		assert.Equal(t, 422, issueAPIStatus(t, err))
		assert.Zero(t, q.createdMap)
	})

	t.Run("Smithers issue already linked", func(t *testing.T) {
		svc, q, _, actor := newLinearIssueLinkTestService()
		q.getMapErr = nil
		q.issueMap = db.LinearIssueMap{ID: 55, JjhubIssueID: q.issue.ID}
		_, err := svc.LinkIssue(context.Background(), actor, "alice", "demo", 4, LinearIssueLinkInput{Identifier: "ENG-482"})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})

	t.Run("Linear issue already linked elsewhere", func(t *testing.T) {
		svc, q, _, actor := newLinearIssueLinkTestService()
		q.createMapErr = &pgconn.PgError{Code: "23505"}
		_, err := svc.LinkIssue(context.Background(), actor, "alice", "demo", 4, LinearIssueLinkInput{Identifier: "ENG-482"})
		assert.Equal(t, 422, issueAPIStatus(t, err))
	})
}

func TestLinearIssueLinkService_RequiresMatchingActiveIntegration(t *testing.T) {
	t.Parallel()

	svc, q, _, actor := newLinearIssueLinkTestService()
	q.integrations = nil
	_, err := svc.LinkIssue(context.Background(), actor, "alice", "demo", 4, LinearIssueLinkInput{Identifier: "ENG-482"})
	assert.Equal(t, 400, issueAPIStatus(t, err))

	q.integrations = []db.LinearIntegration{{ID: 9, LinearTeamKey: "OPS"}}
	_, err = svc.LinkIssue(context.Background(), actor, "alice", "demo", 4, LinearIssueLinkInput{Identifier: "ENG-482"})
	assert.Equal(t, 422, issueAPIStatus(t, err))
}

func TestLinearIssueLinkService_UnlinkIssue(t *testing.T) {
	t.Parallel()

	svc, q, _, actor := newLinearIssueLinkTestService()
	q.getMapErr = nil
	q.issueMap = db.LinearIssueMap{ID: 55, JjhubIssueID: q.issue.ID}
	require.NoError(t, svc.UnlinkIssue(context.Background(), actor, "alice", "demo", 4))
	assert.Equal(t, int64(55), q.deletedMapID)

	q.getMapErr = pgx.ErrNoRows
	err := svc.UnlinkIssue(context.Background(), actor, "alice", "demo", 4)
	assert.Equal(t, 404, issueAPIStatus(t, err))
}

func TestIssueService_GetIssueIncludesLinearReference(t *testing.T) {
	t.Parallel()

	repo := issueRepo(nil)
	q := &mockIssueQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLinearIssueMapFn: func(_ context.Context, issueID int64) (db.LinearIssueMap, error) {
			return db.LinearIssueMap{JjhubIssueID: issueID, LinearIdentifier: "ENG-482"}, nil
		},
	}
	got, err := NewIssueService(q).GetIssue(context.Background(), nil, "alice", "demo", 4)
	require.NoError(t, err)
	require.NotNil(t, got.Linear)
	assert.Equal(t, "ENG-482", got.Linear.Identifier)
	assert.Equal(t, "https://linear.app/issue/ENG-482", got.Linear.URL)
}
