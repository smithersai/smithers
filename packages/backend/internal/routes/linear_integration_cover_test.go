package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type linearIntegrationCovErrReader struct{}

func (linearIntegrationCovErrReader) Read(_ []byte) (int, error) {
	return 0, errors.New("read failed")
}

func linearIntegrationCovEncryptedSetup(t *testing.T, secret string, result services.LinearOAuthCallbackResult) []byte {
	t.Helper()
	payload, err := json.Marshal(result)
	require.NoError(t, err)
	encrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(secret), payload)
	require.NoError(t, err)
	return encrypted
}

func TestLinearIntegration_Cov_OAuthStartSetupAndListIntegrations(t *testing.T) {
	now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	setupResult := services.LinearOAuthCallbackResult{
		AccessToken: "access",
		Viewer:      services.LinearViewer{ID: "viewer-1", Name: "Alice", Email: "alice@example.test"},
		Teams:       []services.LinearTeam{{ID: "team-1", Name: "Platform", Key: "PLT"}},
	}
	encryptedSetup := linearIntegrationCovEncryptedSetup(t, "linear-cover-secret", setupResult)
	queries := &mockRouteLinearQuerier{
		createOAuthStateFn: func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			assert.NotEmpty(t, arg.State)
			assert.NotEmpty(t, arg.ContextHash)
			assert.True(t, arg.ExpiresAt.After(now))
			return db.OauthState{StateKey: arg.State, ContextHash: arg.ContextHash, ExpiresAt: arg.ExpiresAt}, nil
		},
		getLinearOAuthSetupByUserFn: func(_ context.Context, arg db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
			assert.Equal(t, "setup-1", arg.SetupKey)
			assert.Equal(t, int64(7), arg.UserID)
			return db.LinearOauthSetup{SetupKey: arg.SetupKey, UserID: arg.UserID, PayloadEncrypted: encryptedSetup, ExpiresAt: now.Add(10 * time.Minute)}, nil
		},
		listLinearIntegrationsByUserFn: func(_ context.Context, userID int64) ([]db.LinearIntegration, error) {
			assert.Equal(t, int64(7), userID)
			return []db.LinearIntegration{
				{
					ID:               11,
					LinearTeamID:     "team-1",
					LinearTeamName:   "Platform",
					LinearTeamKey:    "PLT",
					JjhubRepoID:      101,
					JjhubRepoOwner:   "alice",
					JjhubRepoName:    "demo",
					IsActive:         true,
					LastSyncAt:       pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true},
					CreatedAt:        now,
					LinearActorID:    "viewer-1",
					LinearActorName:  "Alice",
					LinearActorEmail: "alice@example.test",
				},
			}, nil
		},
	}
	handler := &LinearIntegrationHandler{
		Service:    services.NewLinearIntegrationService(queries, mockRouteLinearClient{}, "linear-cover-secret"),
		AuthConfig: NewLinearAuthConfig(true),
	}

	startReq := httptest.NewRequest(http.MethodGet, "/api/auth/linear/start", nil)
	startReq = withUser(startReq, &db.User{ID: 7, Username: "alice"})
	startRec := httptest.NewRecorder()
	handler.GetLinearOAuthStart(startRec, startReq)
	require.Equal(t, http.StatusFound, startRec.Code)
	assert.Contains(t, startRec.Header().Get("Location"), "https://linear.example/oauth?state=")
	stateCookie := cookieByName(startRec.Result().Cookies(), linearOAuthStateCookieName)
	require.NotNil(t, stateCookie)
	assert.True(t, stateCookie.Secure)
	assert.True(t, stateCookie.HttpOnly)

	setupReq := httptest.NewRequest(http.MethodGet, "/api/linear/setup/setup-1", nil)
	setupReq = withRouteParams(setupReq, map[string]string{"setupKey": "setup-1"})
	setupReq = withUser(setupReq, &db.User{ID: 7, Username: "alice"})
	setupRec := httptest.NewRecorder()
	handler.GetLinearOAuthSetup(setupRec, setupReq)
	require.Equal(t, http.StatusOK, setupRec.Code)
	assert.JSONEq(t, `{"linear_actor":{"id":"viewer-1","name":"Alice","email":"alice@example.test"},"teams":[{"id":"team-1","name":"Platform","key":"PLT"}],"expires_at":"2026-07-06T12:10:00Z"}`, setupRec.Body.String())
	assert.NotContains(t, setupRec.Body.String(), "access")

	listReq := httptest.NewRequest(http.MethodGet, "/api/integrations/linear", nil)
	listReq = withUser(listReq, &db.User{ID: 7, Username: "alice"})
	listRec := httptest.NewRecorder()
	handler.ListLinearIntegrations(listRec, listReq)
	require.Equal(t, http.StatusOK, listRec.Code)
	var integrations []map[string]any
	require.NoError(t, json.Unmarshal(listRec.Body.Bytes(), &integrations))
	require.Len(t, integrations, 1)
	assert.Equal(t, "Platform", integrations[0]["linear_team_name"])
	assert.Equal(t, map[string]any{"id": "viewer-1", "name": "Alice", "email": "alice@example.test"}, integrations[0]["linear_actor"])
	assert.NotNil(t, integrations[0]["last_sync_at"])
}

func TestLinearIntegration_Cov_RepositoryOptionsAndAdminChecks(t *testing.T) {
	user := &db.User{ID: 7, Username: "alice"}
	personal := db.Repository{ID: 1, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "personal"}
	orgRepo := db.Repository{ID: 2, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "orgrepo"}
	queries := &mockRouteLinearQuerier{
		listUserReposFn: func(_ context.Context, arg db.ListUserReposParams) ([]db.Repository, error) {
			if arg.PageOffset == 0 {
				page := make([]db.Repository, linearRepoListPageSize)
				for i := range page {
					page[i] = db.Repository{ID: int64(i + 100), UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "page"}
				}
				return page, nil
			}
			assert.Equal(t, linearRepoListPageSize, arg.PageOffset)
			return []db.Repository{personal}, nil
		},
		listUserOrgsFn: func(_ context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error) {
			if arg.PageOffset == 0 {
				page := make([]db.Organization, linearRepoListPageSize)
				for i := range page {
					page[i] = db.Organization{ID: int64(i + 200), Name: "org"}
				}
				return page, nil
			}
			assert.Equal(t, linearRepoListPageSize, arg.PageOffset)
			return []db.Organization{{ID: 99, Name: "acme"}}, nil
		},
		listOrgReposFn: func(_ context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
			assert.Equal(t, int64(99), arg.OrgID.Int64)
			return []db.Repository{orgRepo}, nil
		},
		isOrgOwnerForRepoUserFn: func(_ context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			assert.Equal(t, int64(2), arg.RepositoryID)
			return true, nil
		},
		getHighestTeamPermissionFn: func(_ context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
		getCollaboratorPermissionFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
	}
	handler := &LinearIntegrationHandler{Repos: queries}

	userRepos, err := handler.listAllUserRepos(context.Background(), 7)
	require.NoError(t, err)
	assert.Len(t, userRepos, int(linearRepoListPageSize)+1)
	orgs, err := handler.listAllUserOrgs(context.Background(), 7)
	require.NoError(t, err)
	assert.Len(t, orgs, int(linearRepoListPageSize)+1)
	orgRepos, err := handler.listAllOrgRepos(context.Background(), 99)
	require.NoError(t, err)
	assert.Equal(t, []db.Repository{orgRepo}, orgRepos)

	canAdmin, err := handler.userCanAdminRepo(context.Background(), nil, personal)
	require.NoError(t, err)
	assert.False(t, canAdmin)
	canAdmin, err = handler.userCanAdminRepo(context.Background(), user, personal)
	require.NoError(t, err)
	assert.True(t, canAdmin)
	canAdmin, err = handler.userCanAdminRepo(context.Background(), user, orgRepo)
	require.NoError(t, err)
	assert.True(t, canAdmin)

	_, err = (&LinearIntegrationHandler{}).userCanAdminRepo(context.Background(), user, db.Repository{ID: 4})
	require.Error(t, err)

	noAuthReq := httptest.NewRequest(http.MethodGet, "/api/integrations/linear/repositories", nil)
	noAuthRec := httptest.NewRecorder()
	handler.ListLinearRepositoryOptions(noAuthRec, noAuthReq)
	require.Equal(t, http.StatusUnauthorized, noAuthRec.Code)

	noReposReq := httptest.NewRequest(http.MethodGet, "/api/integrations/linear/repositories", nil)
	noReposReq = withUser(noReposReq, user)
	noReposRec := httptest.NewRecorder()
	(&LinearIntegrationHandler{}).ListLinearRepositoryOptions(noReposRec, noReposReq)
	require.Equal(t, http.StatusInternalServerError, noReposRec.Code)
}

func TestLinearIntegration_Cov_ConfigureDeleteTriggerAndWebhookErrors(t *testing.T) {
	setup := services.LinearOAuthCallbackResult{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresAt:    time.Date(2026, 7, 6, 13, 0, 0, 0, time.UTC),
		Viewer:       services.LinearViewer{ID: "viewer-1", Name: "Alice"},
		Teams:        []services.LinearTeam{{ID: "team-ok", Name: "Platform", Key: "PLT"}},
	}
	encryptedSetup := linearIntegrationCovEncryptedSetup(t, "linear-cover-secret", setup)
	queries := &mockRouteLinearQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			if id == 404 {
				return db.Repository{}, errors.New("missing")
			}
			return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "demo"}, nil
		},
		consumeLinearOAuthSetupByUserFn: func(_ context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
			return db.ConsumeLinearOAuthSetupByUserRow{SetupKey: arg.SetupKey, UserID: arg.UserID, PayloadEncrypted: encryptedSetup}, nil
		},
		createLinearIntegrationFn: func(_ context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
			return db.LinearIntegration{ID: 50, UserID: arg.UserID, LinearTeamID: arg.LinearTeamID, LinearTeamName: arg.LinearTeamName, JjhubRepoOwner: arg.JjhubRepoOwner, JjhubRepoName: arg.JjhubRepoName, IsActive: true}, nil
		},
		deleteLinearIntegrationFn: func(_ context.Context, arg db.DeleteLinearIntegrationParams) error {
			assert.Equal(t, int64(50), arg.ID)
			assert.Equal(t, int64(7), arg.UserID)
			return nil
		},
		getLinearIntegrationByUserAndID: func(_ context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
			assert.Equal(t, int64(77), arg.ID)
			return db.LinearIntegration{}, pkgerrors.NotFound("integration not found")
		},
	}
	handler := &LinearIntegrationHandler{
		Service: services.NewLinearIntegrationService(queries, nil, "linear-cover-secret"),
		Repos:   queries,
	}

	unmatchedReq := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader([]byte(`{"setup_key":"setup-1","linear_team_id":"team-missing","repo_owner":"alice","repo_name":"demo","repo_id":101}`)))
	unmatchedReq = withUser(unmatchedReq, &db.User{ID: 7, Username: "alice"})
	unmatchedRec := httptest.NewRecorder()
	handler.ConfigureLinearIntegration(unmatchedRec, unmatchedReq)
	require.Equal(t, http.StatusBadRequest, unmatchedRec.Code)
	assert.Contains(t, unmatchedRec.Body.String(), "selected linear_team_id")

	missingRepoReq := httptest.NewRequest(http.MethodPost, "/api/integrations/linear", bytes.NewReader([]byte(`{"setup_key":"setup-1","linear_team_id":"team-ok","repo_owner":"alice","repo_name":"demo","repo_id":404}`)))
	missingRepoReq = withUser(missingRepoReq, &db.User{ID: 7, Username: "alice"})
	missingRepoRec := httptest.NewRecorder()
	handler.ConfigureLinearIntegration(missingRepoRec, missingRepoReq)
	require.Equal(t, http.StatusNotFound, missingRepoRec.Code)

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/integrations/linear/50", nil)
	deleteReq = withRouteParams(deleteReq, map[string]string{"id": "50"})
	deleteReq = withUser(deleteReq, &db.User{ID: 7, Username: "alice"})
	deleteRec := httptest.NewRecorder()
	handler.DeleteLinearIntegration(deleteRec, deleteReq)
	require.Equal(t, http.StatusNoContent, deleteRec.Code)

	badDeleteReq := httptest.NewRequest(http.MethodDelete, "/api/integrations/linear/nope", nil)
	badDeleteReq = withRouteParams(badDeleteReq, map[string]string{"id": "nope"})
	badDeleteReq = withUser(badDeleteReq, &db.User{ID: 7, Username: "alice"})
	badDeleteRec := httptest.NewRecorder()
	handler.DeleteLinearIntegration(badDeleteRec, badDeleteReq)
	require.Equal(t, http.StatusBadRequest, badDeleteRec.Code)

	triggerReq := httptest.NewRequest(http.MethodPost, "/api/integrations/linear/77/sync", nil)
	triggerReq = withRouteParams(triggerReq, map[string]string{"id": "77"})
	triggerReq = withUser(triggerReq, &db.User{ID: 7, Username: "alice"})
	triggerRec := httptest.NewRecorder()
	handler.TriggerInitialSync(triggerRec, triggerReq)
	require.Equal(t, http.StatusNotFound, triggerRec.Code)

	badTriggerReq := httptest.NewRequest(http.MethodPost, "/api/integrations/linear/nope/sync", nil)
	badTriggerReq = withRouteParams(badTriggerReq, map[string]string{"id": "nope"})
	badTriggerReq = withUser(badTriggerReq, &db.User{ID: 7, Username: "alice"})
	badTriggerRec := httptest.NewRecorder()
	handler.TriggerInitialSync(badTriggerRec, badTriggerReq)
	require.Equal(t, http.StatusBadRequest, badTriggerRec.Code)

	webhookReq := httptest.NewRequest(http.MethodPost, "/api/webhooks/linear", io.NopCloser(linearIntegrationCovErrReader{}))
	webhookRec := httptest.NewRecorder()
	handler.PostLinearWebhook(webhookRec, webhookReq)
	require.Equal(t, http.StatusBadRequest, webhookRec.Code)

	stateReq := httptest.NewRequest(http.MethodGet, "/callback", nil)
	stateReq.AddCookie(&http.Cookie{Name: linearOAuthStateCookieName, Value: " verifier "})
	assert.Equal(t, "verifier", linearOAuthStateFromRequest(stateReq))
	noCookieReq := httptest.NewRequest(http.MethodGet, "/callback", nil)
	assert.Empty(t, linearOAuthStateFromRequest(noCookieReq))

	rec := httptest.NewRecorder()
	setLinearOAuthStateCookie(rec, "state-1", false)
	clearLinearOAuthStateCookie(rec, true)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 2)
	assert.False(t, cookies[0].Secure)
	assert.Equal(t, -1, cookies[1].MaxAge)

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("setupKey", " ")
	setupMissingReq := httptest.NewRequest(http.MethodGet, "/api/integrations/linear/setup/%20", nil)
	setupMissingReq = setupMissingReq.WithContext(context.WithValue(setupMissingReq.Context(), chi.RouteCtxKey, rctx))
	setupMissingReq = withUser(setupMissingReq, &db.User{ID: 7, Username: "alice"})
	setupMissingRec := httptest.NewRecorder()
	handler.GetLinearOAuthSetup(setupMissingRec, setupMissingReq)
	require.Equal(t, http.StatusBadRequest, setupMissingRec.Code)
}
