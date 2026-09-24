package routes

import (
	"bytes"
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const linearFSecret = "linear-f-secret"

// linearFSync is a fake LinearSyncRouteService. StartInitialSync signals ran so
// the trigger handler's dispatch can be awaited deterministically.
type linearFSync struct {
	ran            chan struct{}
	alreadyRunning bool
	webhookErr     error
	gotBody        []byte
	gotSignature   string
}

func newLinearFSync() *linearFSync { return &linearFSync{ran: make(chan struct{}, 1)} }

func (s *linearFSync) StartInitialSync(_ db.LinearIntegration) bool {
	if s.alreadyRunning {
		return false
	}
	select {
	case s.ran <- struct{}{}:
	default:
	}
	return true
}

func (s *linearFSync) HandleLinearWebhook(_ context.Context, body []byte, signature string) error {
	s.gotBody = body
	s.gotSignature = signature
	return s.webhookErr
}

func linearFUser() *db.User { return &db.User{ID: 7, Username: "alice", LowerUsername: "alice"} }

// --- helper error branches: userCanAdminRepo and listAll* ---

func TestLinearIntegration_F_UserCanAdminRepoErrors(t *testing.T) {
	user := linearFUser()

	t.Run("is-org-owner error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, stderrors.New("db down")
			},
		}}
		_, err := h.userCanAdminRepo(context.Background(), user, db.Repository{ID: 10, OrgID: pgtype.Int8{Int64: 99, Valid: true}})
		require.Error(t, err)
	})

	t.Run("team-permission error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) { return false, nil },
			getHighestTeamPermissionFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
				return "", stderrors.New("db down")
			},
		}}
		_, err := h.userCanAdminRepo(context.Background(), user, db.Repository{ID: 11, OrgID: pgtype.Int8{Int64: 99, Valid: true}})
		require.Error(t, err)
	})

	t.Run("collaborator-permission error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			getCollaboratorPermissionFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "", stderrors.New("db down")
			},
		}}
		_, err := h.userCanAdminRepo(context.Background(), user, db.Repository{ID: 12})
		require.Error(t, err)
	})
}

func TestLinearIntegration_F_ListAllPaginationErrors(t *testing.T) {
	t.Run("user repos error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
				return nil, stderrors.New("db down")
			},
		}}
		_, err := h.listAllUserRepos(context.Background(), 7)
		require.Error(t, err)
	})

	t.Run("user orgs error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserOrgsFn: func(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
				return nil, stderrors.New("db down")
			},
		}}
		_, err := h.listAllUserOrgs(context.Background(), 7)
		require.Error(t, err)
	})

	t.Run("org repos error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listOrgReposFn: func(context.Context, db.ListOrgReposParams) ([]db.Repository, error) {
				return nil, stderrors.New("db down")
			},
		}}
		_, err := h.listAllOrgRepos(context.Background(), 99)
		require.Error(t, err)
	})
}

// --- ListLinearRepositoryOptions full traversal + error branches ---

func TestLinearIntegration_F_ListRepositoryOptionsSuccess(t *testing.T) {
	user := linearFUser()
	queries := &mockRouteLinearQuerier{
		listUserReposFn: func(_ context.Context, _ db.ListUserReposParams) ([]db.Repository, error) {
			return []db.Repository{
				{ID: 1, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "u1"},
				{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "u2", IsArchived: true},
				{ID: 3, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "u3"},
			}, nil
		},
		listUserOrgsFn: func(_ context.Context, _ db.ListUserOrgsParams) ([]db.Organization, error) {
			return []db.Organization{{ID: 99, Name: "acme"}}, nil
		},
		listOrgReposFn: func(_ context.Context, _ db.ListOrgReposParams) ([]db.Repository, error) {
			return []db.Repository{
				{ID: 4, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "o4"},
				{ID: 5, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "o5", IsArchived: true},
				{ID: 1, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "dup"},
				{ID: 6, OrgID: pgtype.Int8{Int64: 99, Valid: true}, Name: "o6"},
			}, nil
		},
		isOrgOwnerForRepoUserFn: func(_ context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return arg.RepositoryID == 4, nil
		},
	}
	h := &LinearIntegrationHandler{Repos: queries}
	req := withUser(httptest.NewRequest(http.MethodGet, "/api/integrations/linear/repositories", nil), user)
	rec := httptest.NewRecorder()
	h.ListLinearRepositoryOptions(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `"u1"`)
	assert.Contains(t, body, `"o4"`)
	assert.NotContains(t, body, `"u2"`)
	assert.NotContains(t, body, `"o5"`)
	assert.NotContains(t, body, `"o6"`)
	// sorted: acme/o4 before alice/u1
	assert.Less(t, strings.Index(body, `"o4"`), strings.Index(body, `"u1"`))
}

func TestLinearIntegration_F_ListRepositoryOptionsErrors(t *testing.T) {
	user := linearFUser()

	t.Run("user repos error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.ListLinearRepositoryOptions(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), user))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("user loop can-admin error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) {
				return []db.Repository{{ID: 3, OrgID: pgtype.Int8{Int64: 99, Valid: true}}}, nil
			},
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.ListLinearRepositoryOptions(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), user))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("orgs error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) { return nil, nil },
			listUserOrgsFn: func(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.ListLinearRepositoryOptions(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), user))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("org repos error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) { return nil, nil },
			listUserOrgsFn: func(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
				return []db.Organization{{ID: 99, Name: "acme"}}, nil
			},
			listOrgReposFn: func(context.Context, db.ListOrgReposParams) ([]db.Repository, error) {
				return nil, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.ListLinearRepositoryOptions(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), user))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("org loop can-admin error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			listUserReposFn: func(context.Context, db.ListUserReposParams) ([]db.Repository, error) { return nil, nil },
			listUserOrgsFn: func(context.Context, db.ListUserOrgsParams) ([]db.Organization, error) {
				return []db.Organization{{ID: 99, Name: "acme"}}, nil
			},
			listOrgReposFn: func(context.Context, db.ListOrgReposParams) ([]db.Repository, error) {
				return []db.Repository{{ID: 6, OrgID: pgtype.Int8{Int64: 99, Valid: true}}}, nil
			},
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, stderrors.New("db down")
			},
		}}
		rec := httptest.NewRecorder()
		h.ListLinearRepositoryOptions(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), user))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- GetLinearOAuthStart ---

func TestLinearIntegration_F_OAuthStart(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthStart(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("random error", func(t *testing.T) {
		withFailingAuthRandom(t)
		h := &LinearIntegrationHandler{
			Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, mockRouteLinearClient{}, linearFSecret),
		}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthStart(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser()))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		// nil linear client makes StartLinearOAuth return a BadRequest.
		h := &LinearIntegrationHandler{
			Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, linearFSecret),
		}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthStart(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser()))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

// --- GetLinearOAuthCallback ---

func TestLinearIntegration_F_OAuthCallback(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthCallback(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("missing code and state", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthCallback(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser()))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("complete oauth error redirects", func(t *testing.T) {
		// nil client -> CompleteLinearOAuth errors -> redirect with error param.
		h := &LinearIntegrationHandler{
			Service:    services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, linearFSecret),
			AuthConfig: NewLinearAuthConfig(true),
		}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthCallback(rec, withUser(httptest.NewRequest(http.MethodGet, "/x?code=c&state=s", nil), linearFUser()))
		require.Equal(t, http.StatusFound, rec.Code)
		assert.Contains(t, rec.Header().Get("Location"), "/integrations/linear?error=")
	})

	t.Run("create setup error redirects", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			consumeOAuthStateFn: func(context.Context, db.ConsumeOAuthStateParams) (int64, error) { return 1, nil },
			createLinearOAuthSetupFn: func(context.Context, db.CreateLinearOAuthSetupParams) (db.LinearOauthSetup, error) {
				return db.LinearOauthSetup{}, stderrors.New("insert failed")
			},
		}
		client := mockRouteLinearClient{
			exchangeCodeFn: func(context.Context, string) (services.LinearTokenResult, error) {
				return services.LinearTokenResult{AccessToken: "at"}, nil
			},
			fetchViewerFn: func(context.Context, string) (services.LinearViewer, error) {
				return services.LinearViewer{ID: "v1"}, nil
			},
			fetchTeamsFn: func(context.Context, string) ([]services.LinearTeam, error) {
				return []services.LinearTeam{{ID: "t1"}}, nil
			},
		}
		h := &LinearIntegrationHandler{
			Service:    services.NewLinearIntegrationService(queries, client, linearFSecret),
			AuthConfig: NewLinearAuthConfig(false),
		}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthCallback(rec, withUser(httptest.NewRequest(http.MethodGet, "/x?code=c&state=s", nil), linearFUser()))
		require.Equal(t, http.StatusFound, rec.Code)
		location := rec.Header().Get("Location")
		assert.Contains(t, location, "/integrations/linear?error=")
		// Internal error detail must not be reflected into the redirect URL.
		assert.NotContains(t, location, "insert")
		assert.Contains(t, location, "linear+oauth+failed")
	})
}

// --- GetLinearOAuthSetup ---

func TestLinearIntegration_F_OAuthSetup(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.GetLinearOAuthSetup(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			getLinearOAuthSetupByUserFn: func(context.Context, db.GetLinearOAuthSetupByUserParams) (db.LinearOauthSetup, error) {
				return db.LinearOauthSetup{}, stderrors.New("db down")
			},
		}
		h := &LinearIntegrationHandler{Service: services.NewLinearIntegrationService(queries, nil, linearFSecret)}
		req := withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser())
		req = withRouteParams(req, map[string]string{"setupKey": "setup-1"})
		rec := httptest.NewRecorder()
		h.GetLinearOAuthSetup(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- ListLinearIntegrations ---

func TestLinearIntegration_F_ListIntegrations(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.ListLinearIntegrations(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			listLinearIntegrationsByUserFn: func(context.Context, int64) ([]db.LinearIntegration, error) {
				return nil, stderrors.New("db down")
			},
		}
		h := &LinearIntegrationHandler{Service: services.NewLinearIntegrationService(queries, nil, linearFSecret)}
		rec := httptest.NewRecorder()
		h.ListLinearIntegrations(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser()))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("remediation branch", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			listLinearIntegrationsByUserFn: func(context.Context, int64) ([]db.LinearIntegration, error) {
				return []db.LinearIntegration{
					{ID: 1, IsActive: false, WebhookSecret: "", CreatedAt: time.Now()},
				}, nil
			},
		}
		h := &LinearIntegrationHandler{Service: services.NewLinearIntegrationService(queries, nil, linearFSecret)}
		rec := httptest.NewRecorder()
		h.ListLinearIntegrations(rec, withUser(httptest.NewRequest(http.MethodGet, "/x", nil), linearFUser()))
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "webhook_secret_reconfigure_required")
	})
}

// --- ConfigureLinearIntegration ---

func TestLinearIntegration_F_ConfigureIntegration(t *testing.T) {
	setup := services.LinearOAuthCallbackResult{
		AccessToken: "at",
		Viewer:      services.LinearViewer{ID: "v1"},
		Teams:       []services.LinearTeam{{ID: "team-ok", Name: "Platform", Key: "PLT"}},
	}
	encrypted := linearIntegrationCovEncryptedSetup(t, linearFSecret, setup)
	okBody := `{"setup_key":"setup-1","linear_team_id":"team-ok","repo_owner":"alice","repo_name":"demo","repo_id":101}`

	newHandler := func(q *mockRouteLinearQuerier) *LinearIntegrationHandler {
		return &LinearIntegrationHandler{
			Service: services.NewLinearIntegrationService(q, nil, linearFSecret),
			Repos:   q,
		}
	}

	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("decode error", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{bad")), linearFUser()))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("missing team or repo", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"repo_id":0}`)), linearFUser()))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("missing setup key", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"linear_team_id":"t","repo_id":5}`)), linearFUser()))
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("can-admin error", func(t *testing.T) {
		h := newHandler(&mockRouteLinearQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, OrgID: pgtype.Int8{Int64: 99, Valid: true}}, nil
			},
			isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
				return false, stderrors.New("db down")
			},
		})
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("forbidden not admin", func(t *testing.T) {
		h := newHandler(&mockRouteLinearQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, OrgID: pgtype.Int8{Int64: 99, Valid: true}}, nil
			},
		})
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("consume setup error", func(t *testing.T) {
		h := newHandler(&mockRouteLinearQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
			consumeLinearOAuthSetupByUserFn: func(context.Context, db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
				return db.ConsumeLinearOAuthSetupByUserRow{}, stderrors.New("db down")
			},
		})
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("configure integration error", func(t *testing.T) {
		h := newHandler(&mockRouteLinearQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
			consumeLinearOAuthSetupByUserFn: func(_ context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
				return db.ConsumeLinearOAuthSetupByUserRow{SetupKey: arg.SetupKey, UserID: arg.UserID, PayloadEncrypted: encrypted}, nil
			},
			createLinearIntegrationFn: func(context.Context, db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
				return db.LinearIntegration{}, stderrors.New("insert failed")
			},
		})
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("success", func(t *testing.T) {
		h := newHandler(&mockRouteLinearQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
			consumeLinearOAuthSetupByUserFn: func(_ context.Context, arg db.ConsumeLinearOAuthSetupByUserParams) (db.ConsumeLinearOAuthSetupByUserRow, error) {
				return db.ConsumeLinearOAuthSetupByUserRow{SetupKey: arg.SetupKey, UserID: arg.UserID, PayloadEncrypted: encrypted}, nil
			},
			createLinearIntegrationFn: func(_ context.Context, arg db.CreateLinearIntegrationParams) (db.LinearIntegration, error) {
				return db.LinearIntegration{ID: 50, LinearTeamID: arg.LinearTeamID, LinearTeamName: arg.LinearTeamName, JjhubRepoOwner: arg.JjhubRepoOwner, JjhubRepoName: arg.JjhubRepoName, IsActive: true}, nil
			},
		})
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), `"linear_team_name":"Platform"`)
	})

	t.Run("service owns repository check", func(t *testing.T) {
		// Configure uses the service's repository queries, not the handler's
		// repository-listing dependency, and still fails closed on permissions.
		h := &LinearIntegrationHandler{Service: services.NewLinearIntegrationService(&mockRouteLinearQuerier{}, nil, linearFSecret)}
		rec := httptest.NewRecorder()
		h.ConfigureLinearIntegration(rec, withUser(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(okBody)), linearFUser()))
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

// --- DeleteLinearIntegration ---

func TestLinearIntegration_F_DeleteIntegration(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.DeleteLinearIntegration(rec, httptest.NewRequest(http.MethodDelete, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service error", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			deleteLinearIntegrationFn: func(context.Context, db.DeleteLinearIntegrationParams) error {
				return stderrors.New("db down")
			},
		}
		h := &LinearIntegrationHandler{Service: services.NewLinearIntegrationService(queries, nil, linearFSecret)}
		req := withUser(httptest.NewRequest(http.MethodDelete, "/x", nil), linearFUser())
		req = withRouteParams(req, map[string]string{"id": "50"})
		rec := httptest.NewRecorder()
		h.DeleteLinearIntegration(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// --- TriggerInitialSync ---

func TestLinearIntegration_F_TriggerInitialSync(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &LinearIntegrationHandler{}
		rec := httptest.NewRecorder()
		h.TriggerInitialSync(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("success runs background sync", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			getLinearIntegrationByUserAndID: func(_ context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
				return db.LinearIntegration{ID: arg.ID}, nil
			},
		}
		sync := newLinearFSync()
		h := &LinearIntegrationHandler{
			Service: services.NewLinearIntegrationService(queries, nil, linearFSecret),
			Sync:    sync,
		}
		req := withUser(httptest.NewRequest(http.MethodPost, "/x", nil), linearFUser())
		req = withRouteParams(req, map[string]string{"id": "77"})
		rec := httptest.NewRecorder()
		h.TriggerInitialSync(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code)
		select {
		case <-sync.ran:
		case <-time.After(2 * time.Second):
			t.Fatal("background sync did not run")
		}
	})

	t.Run("conflict when sync already running", func(t *testing.T) {
		queries := &mockRouteLinearQuerier{
			getLinearIntegrationByUserAndID: func(_ context.Context, arg db.GetLinearIntegrationByUserAndIDParams) (db.LinearIntegration, error) {
				return db.LinearIntegration{ID: arg.ID}, nil
			},
		}
		sync := newLinearFSync()
		sync.alreadyRunning = true
		h := &LinearIntegrationHandler{
			Service: services.NewLinearIntegrationService(queries, nil, linearFSecret),
			Sync:    sync,
		}
		req := withUser(httptest.NewRequest(http.MethodPost, "/x", nil), linearFUser())
		req = withRouteParams(req, map[string]string{"id": "77"})
		rec := httptest.NewRecorder()
		h.TriggerInitialSync(rec, req)
		require.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "sync_already_running")
	})
}

// --- PostLinearWebhook ---

func TestLinearIntegration_F_PostWebhook(t *testing.T) {
	t.Run("handler error", func(t *testing.T) {
		sync := newLinearFSync()
		sync.webhookErr = pkgerrors.BadRequest("invalid signature")
		h := &LinearIntegrationHandler{Sync: sync}
		req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader([]byte(`{"a":1}`)))
		req.Header.Set("Linear-Signature", "sig")
		rec := httptest.NewRecorder()
		h.PostLinearWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Equal(t, "sig", sync.gotSignature)
	})

	t.Run("success", func(t *testing.T) {
		sync := newLinearFSync()
		h := &LinearIntegrationHandler{Sync: sync}
		req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader([]byte(`{"a":1}`)))
		rec := httptest.NewRecorder()
		h.PostLinearWebhook(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, []byte(`{"a":1}`), sync.gotBody)
	})
}

// The Linear picker must grant exactly what repository middleware grants:
// team and collaborator permissions rank through ParsePermissionLevel, so an
// "owner" grant is admin-able, and an unknown grant is an error, never silence.
func TestLinearIntegration_F_UserCanAdminRepoMatchesRepoPermission(t *testing.T) {
	user := linearFUser()
	orgRepo := db.Repository{ID: 20, OrgID: pgtype.Int8{Int64: 99, Valid: true}}

	for _, tc := range []struct {
		name, team, collab string
		want               bool
	}{
		{"team owner", "owner", "", true},
		{"team admin with padding", " Admin ", "", true},
		{"collaborator owner", "", "owner", true},
		{"team write", "write", "", false},
		{"collaborator read", "", "read", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
				isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) { return false, nil },
				getHighestTeamPermissionFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
					return tc.team, nil
				},
				getCollaboratorPermissionFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
					return tc.collab, nil
				},
			}}
			got, err := h.userCanAdminRepo(context.Background(), user, orgRepo)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}

	t.Run("unknown grant is an error", func(t *testing.T) {
		h := &LinearIntegrationHandler{Repos: &mockRouteLinearQuerier{
			getCollaboratorPermissionFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "superuser", nil
			},
		}}
		_, err := h.userCanAdminRepo(context.Background(), user, db.Repository{ID: 21})
		require.Error(t, err)
	})
}
