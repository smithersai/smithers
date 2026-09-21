package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockChangesetRouteService struct {
	createFn func(ctx context.Context, actor *db.User, orgName string, input services.CreateChangesetInput) (services.ChangesetResponse, error)
	getFn    func(ctx context.Context, viewer *db.User, orgName string, id int64) (services.ChangesetResponse, error)
	listFn   func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]services.ChangesetResponse, error)
	landFn   func(ctx context.Context, actor *db.User, orgName string, id int64) (services.ChangesetResponse, error)
}

func (m *mockChangesetRouteService) CreateChangeset(ctx context.Context, actor *db.User, orgName string, input services.CreateChangesetInput) (services.ChangesetResponse, error) {
	return m.createFn(ctx, actor, orgName, input)
}

func (m *mockChangesetRouteService) GetChangeset(ctx context.Context, viewer *db.User, orgName string, id int64) (services.ChangesetResponse, error) {
	return m.getFn(ctx, viewer, orgName, id)
}

func (m *mockChangesetRouteService) ListChangesets(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]services.ChangesetResponse, error) {
	return m.listFn(ctx, viewer, orgName, page, perPage)
}

func (m *mockChangesetRouteService) LandChangeset(ctx context.Context, actor *db.User, orgName string, id int64) (services.ChangesetResponse, error) {
	return m.landFn(ctx, actor, orgName, id)
}

func sampleChangeset() services.ChangesetResponse {
	return services.ChangesetResponse{
		ID:              42,
		Organization:    "acme",
		Superproject:    "acme/superproject",
		ChangeID:        "spchange0000000000000000000001",
		CommitID:        strings.Repeat("1", 40),
		ParentChangeIDs: []string{},
		TargetBookmark:  "main",
		State:           "pending",
		Members: []services.ChangesetMemberResponse{
			{RepositoryID: 11, Repository: "acme/api", Path: "api", ChangeID: "aaaa", CommitID: strings.Repeat("a", 40), TargetBookmark: "main"},
		},
	}
}

func TestChangesetHandler_Create(t *testing.T) {
	t.Parallel()
	h := ChangesetHandler{Service: &mockChangesetRouteService{
		createFn: func(ctx context.Context, actor *db.User, orgName string, input services.CreateChangesetInput) (services.ChangesetResponse, error) {
			require.NotNil(t, actor)
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, "ship", input.Description)
			require.Len(t, input.Members, 2)
			assert.Equal(t, "api", input.Members[0].Repo)
			assert.Equal(t, "aaaa", input.Members[0].ChangeID)
			return sampleChangeset(), nil
		},
	}}
	body := `{"description":"ship","members":[{"repo":"api","change_id":"aaaa"},{"repo":"web","change_id":"bbbb"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/changesets", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withTestUser(req, &db.User{ID: 1, Username: "alice"})
	rec := httptest.NewRecorder()

	h.CreateChangeset(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var got services.ChangesetResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, int64(42), got.ID)
	assert.Equal(t, "acme/superproject", got.Superproject)
}

func TestChangesetHandler_CreateRequiresAuth(t *testing.T) {
	t.Parallel()
	h := ChangesetHandler{Service: &mockChangesetRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/changesets", strings.NewReader(`{}`))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	rec := httptest.NewRecorder()

	h.CreateChangeset(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestChangesetHandler_GetAndLand(t *testing.T) {
	t.Parallel()
	landed := sampleChangeset()
	landed.State = "landed"
	landed.LandedCommitID = landed.CommitID
	h := ChangesetHandler{Service: &mockChangesetRouteService{
		getFn: func(ctx context.Context, viewer *db.User, orgName string, id int64) (services.ChangesetResponse, error) {
			assert.Equal(t, int64(42), id)
			return sampleChangeset(), nil
		},
		landFn: func(ctx context.Context, actor *db.User, orgName string, id int64) (services.ChangesetResponse, error) {
			assert.Equal(t, "acme", orgName)
			assert.Equal(t, int64(42), id)
			return landed, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/changesets/42", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "id": "42"})
	req = withTestUser(req, &db.User{ID: 1})
	rec := httptest.NewRecorder()
	h.GetChangeset(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	req = httptest.NewRequest(http.MethodPost, "/api/orgs/acme/changesets/42/land", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "id": "42"})
	req = withTestUser(req, &db.User{ID: 1})
	rec = httptest.NewRecorder()
	h.LandChangeset(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var got services.ChangesetResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, "landed", got.State)
	assert.Equal(t, landed.CommitID, got.LandedCommitID)

	// Invalid ids and service conflicts map to the right statuses.
	req = httptest.NewRequest(http.MethodPost, "/api/orgs/acme/changesets/abc/land", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "id": "abc"})
	req = withTestUser(req, &db.User{ID: 1})
	rec = httptest.NewRecorder()
	h.LandChangeset(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	h.Service = &mockChangesetRouteService{landFn: func(ctx context.Context, actor *db.User, orgName string, id int64) (services.ChangesetResponse, error) {
		return services.ChangesetResponse{}, errors.Conflict("changeset is already landed")
	}}
	req = httptest.NewRequest(http.MethodPost, "/api/orgs/acme/changesets/42/land", nil)
	req = withRouteParams(req, map[string]string{"org": "acme", "id": "42"})
	req = withTestUser(req, &db.User{ID: 1})
	rec = httptest.NewRecorder()
	h.LandChangeset(rec, req)
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestChangesetHandler_List(t *testing.T) {
	t.Parallel()
	h := ChangesetHandler{Service: &mockChangesetRouteService{
		listFn: func(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]services.ChangesetResponse, error) {
			assert.Equal(t, 2, page)
			assert.Equal(t, 5, perPage)
			return nil, nil
		},
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/changesets?page=2&per_page=5", nil)
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withTestUser(req, &db.User{ID: 1})
	rec := httptest.NewRecorder()
	h.ListChangesets(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "[]", strings.TrimSpace(rec.Body.String()))
}
