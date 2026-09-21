package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// fakeImportOrgDB is the organization half of the import seam: a slug either
// names an organization on this deployment or it does not, and membership is
// what decides whether an import may use that namespace.
type fakeImportOrgDB struct {
	orgs        map[string]db.Organization
	members     map[int64]map[int64]string
	createdOrg  []db.CreateOrgRepoParams
	getOrgErr   error
	memberErr   error
	createOrgFn func(db.CreateOrgRepoParams) (db.Repository, error)
}

func (f *fakeImportOrgDB) GetOrgByLowerName(_ context.Context, lowerName string) (db.Organization, error) {
	if f.getOrgErr != nil {
		return db.Organization{}, f.getOrgErr
	}
	org, ok := f.orgs[lowerName]
	if !ok {
		return db.Organization{}, pgx.ErrNoRows
	}
	return org, nil
}

func (f *fakeImportOrgDB) GetOrgMember(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	if f.memberErr != nil {
		return db.OrgMember{}, f.memberErr
	}
	role, ok := f.members[arg.OrganizationID][arg.UserID]
	if !ok {
		return db.OrgMember{}, pgx.ErrNoRows
	}
	return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: role}, nil
}

func (f *fakeImportOrgDB) CreateOrgRepo(_ context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
	f.createdOrg = append(f.createdOrg, arg)
	if f.createOrgFn != nil {
		return f.createOrgFn(arg)
	}
	return db.Repository{ID: 77, OrgID: arg.OrgID, Name: arg.Name, LowerName: arg.LowerName}, nil
}

// recordingImportDB captures the repo_owner slug the import job row is created
// with; the shared row stub returns canned columns, so the argument is the only
// honest witness of which namespace was resolved.
type recordingImportDB struct {
	*githubImportHDB
	repoOwner string
}

func (d *recordingImportDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if sql == createImportJobSQL && len(args) > 4 {
		if owner, ok := args[4].(string); ok {
			d.repoOwner = owner
		}
	}
	return d.githubImportHDB.QueryRow(ctx, sql, args...)
}

func smithersaiOrgDB(memberIDs ...int64) *fakeImportOrgDB {
	members := map[int64]string{}
	for _, id := range memberIDs {
		members[id] = "member"
	}
	return &fakeImportOrgDB{
		orgs:    map[string]db.Organization{"smithersai": {ID: 9, Name: "smithersai", LowerName: "smithersai"}},
		members: map[int64]map[int64]string{9: members},
	}
}

// An org-owned GitHub repository imported by a member of that organization on
// Cloud lands in the organization's namespace, not the importing user's.
func TestGitHubImport_OrgOwnedSourceLandsInOrgNamespace(t *testing.T) {
	ctx := context.Background()
	failedCh := make(chan struct{})
	dbase := &recordingImportDB{githubImportHDB: &githubImportHDB{username: "alice", failedCh: failedCh}}
	api := githubImportHAPI(t, http.StatusInternalServerError, nil)
	svc := NewGitHubImportService(
		dbase, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{},
		"https://plue.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportOrgs(smithersaiOrgDB(1)),
	)
	svc.asyncTimeout = time.Second

	_, err := svc.StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "smithersai", Repo: "smithers"})
	require.NoError(t, err)
	assert.Equal(t, "smithersai", dbase.repoOwner,
		"an org-owned source mirrors into the org namespace, never the importer's")

	select {
	case <-failedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("background import did not settle")
	}
}

// A non-member does NOT get a quiet copy under their own account. Taking
// somebody else's organization repository into your namespace is a fork, and a
// fork is an explicit action.
func TestGitHubImport_OrgOwnedSourceRefusesNonMemberInsteadOfUserFallback(t *testing.T) {
	ctx := context.Background()
	dbase := &recordingImportDB{githubImportHDB: &githubImportHDB{username: "alice"}}
	svc := NewGitHubImportService(
		dbase, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{},
		"https://plue.test",
		WithGitHubImportOrgs(smithersaiOrgDB()),
	)

	_, err := svc.StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "smithersai", Repo: "smithers"})

	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeOrgMembershipRequired, apiErr.Code)
	assert.Equal(t, http.StatusForbidden, apiErr.Status)
	assert.Empty(t, dbase.repoOwner,
		"a refused org import must not fall back to creating a job in the user namespace")
}

// A source owner that is not an organization here still mirrors into the
// importing user's namespace: that path is unchanged.
func TestGitHubImport_NonOrgSourceKeepsUserNamespace(t *testing.T) {
	ctx := context.Background()
	failedCh := make(chan struct{})
	dbase := &recordingImportDB{githubImportHDB: &githubImportHDB{username: "alice", failedCh: failedCh}}
	api := githubImportHAPI(t, http.StatusInternalServerError, nil)
	svc := NewGitHubImportService(
		dbase, githubImportHRepoDB{}, githubImportHTokenDB{}, &githubImportHRepoHost{}, githubImportHDecrypter{},
		"https://plue.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportOrgs(smithersaiOrgDB(1)),
	)
	svc.asyncTimeout = time.Second

	_, err := svc.StartImport(ctx, ImportGitHubRepoInput{UserID: 1, Owner: "octocat", Repo: "hello-world"})
	require.NoError(t, err)
	assert.Equal(t, "alice", dbase.repoOwner)

	select {
	case <-failedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("background import did not settle")
	}
}

// Template seeds are published from a first-party organization but are meant to
// be copied into the caller's own namespace, so they skip org resolution even
// when the caller belongs to that organization.
func TestGitHubImport_TemplateSeedKeepsUserNamespace(t *testing.T) {
	ctx := context.Background()
	orgs := smithersaiOrgDB(1)
	svc := NewGitHubImportService(
		&githubImportHDB{username: "alice"}, githubImportHRepoDB{}, githubImportHTokenDB{},
		&githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test",
		WithGitHubImportOrgs(orgs),
	)

	owner, err := svc.resolveImportOwner(ctx, 1, "smithersai", "template-ts-lib")

	require.NoError(t, err)
	assert.Equal(t, "alice", owner.Name)
	assert.False(t, owner.OrgID.Valid)
}

// The repositories row for an org namespace is inserted as an org row, so the
// repo resolves at /{org}/{repo} and the organization owns the bill.
func TestGitHubImport_CreateImportRepoRowUsesOrgInsert(t *testing.T) {
	ctx := context.Background()
	orgs := smithersaiOrgDB(1)
	svc := NewGitHubImportService(
		&githubImportHDB{username: "alice"}, githubImportHRepoDB{}, githubImportHTokenDB{},
		&githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test",
		WithGitHubImportOrgs(orgs),
	)
	params := db.CreateRepoParams{Name: "Smithers", LowerName: "smithers", DefaultBookmark: "main"}

	orgRepo, err := svc.createImportRepoRow(ctx, importOwner{
		Name: "smithersai", OrgID: pgtype.Int8{Int64: 9, Valid: true},
	}, params)
	require.NoError(t, err)
	assert.True(t, orgRepo.OrgID.Valid)
	require.Len(t, orgs.createdOrg, 1)
	assert.Equal(t, int64(9), orgs.createdOrg[0].OrgID.Int64)
	assert.Equal(t, "smithers", orgs.createdOrg[0].LowerName)

	userRepo, err := svc.createImportRepoRow(ctx, importOwner{Name: "alice"}, db.CreateRepoParams{
		UserID: pgtype.Int8{Int64: 1, Valid: true}, Name: "Smithers", LowerName: "smithers",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(42), userRepo.ID, "a user namespace still uses the user insert")
	assert.Len(t, orgs.createdOrg, 1, "the user path must not touch the org insert")
}

// The worker re-resolves the persisted repo_owner slug: an organization slug
// carries its id so the reservation is made against the org, and any other slug
// stays a plain user namespace.
func TestGitHubImport_ImportOwnerForSlug(t *testing.T) {
	ctx := context.Background()
	svc := NewGitHubImportService(
		&githubImportHDB{username: "alice"}, githubImportHRepoDB{}, githubImportHTokenDB{},
		&githubImportHRepoHost{}, githubImportHDecrypter{}, "https://plue.test",
		WithGitHubImportOrgs(smithersaiOrgDB(1)),
	)

	org, err := svc.importOwnerForSlug(ctx, "SmithersAI")
	require.NoError(t, err)
	assert.Equal(t, "smithersai", org.Name)
	assert.Equal(t, int64(9), org.OrgID.Int64)

	user, err := svc.importOwnerForSlug(ctx, "alice")
	require.NoError(t, err)
	assert.Equal(t, "alice", user.Name)
	assert.False(t, user.OrgID.Valid)
}
