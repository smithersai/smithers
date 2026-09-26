package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Use the actual assembled router, auth loader, OrgService and product SQL.
// An org member's restricted PAT sees the anonymous view, not member data.
func TestRouterOrganizationReadsRespectTokenScopePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "org-member", LowerUsername: "org-member", DisplayName: "Org member"})
	require.NoError(t, err)
	for _, visibility := range []string{"public", "private"} {
		org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: visibility, LowerName: visibility, Visibility: visibility})
		require.NoError(t, err)
		_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: owner.ID, Role: "owner"})
		require.NoError(t, err)
		for _, public := range []bool{true, false} {
			name := "member-only"
			if public {
				name = "public-repo"
			}
			_, err = q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, Name: name, LowerName: name, IsPublic: public, DefaultBookmark: "main"})
			require.NoError(t, err)
		}
	}
	router := buildRouterCompat(
		testConfigAllFlagsOn(),  // cfg
		q,                       // queries
		pool,                    // pool
		&routes.RepoHandler{},   // repoHandler
		&routes.AuthHandler{},   // authHandler
		&routes.UserHandler{},   // userHandler
		&routes.SSHKeyHandler{}, // sshKeyHandler
		&routes.LabelHandler{},  // labelHandler
		&routes.OrgHandler{Service: services.NewOrgServiceWithPool(q, pool)}, // orgHandler
		&routes.LandingHandler{},                                   // landingHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, // searchHandler
		&routes.IssueHandler{},                                     // issueHandler
		nil,                                                        // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}}, // gitHandler
		nil, // notificationHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminRepoHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
	for _, tc := range []struct {
		name, scopes string
		member       bool
	}{
		{"anonymous", "", false}, {"read-user", "read:user", false}, {"scopeless", "", false}, {"repo-bound", "read:organization,repo:1", false}, {"org-reader", "read:organization", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := ""
			if tc.name != "anonymous" {
				sum := sha256.Sum256([]byte(tc.name))
				token = "smithers_" + hex.EncodeToString(sum[:])[:40]
				hash := sha256.Sum256([]byte(token))
				hashString := hex.EncodeToString(hash[:])
				_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: tc.name, TokenHash: hashString, TokenLastEight: hashString[len(hashString)-8:], Scopes: tc.scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
				require.NoError(t, err)
			}
			request := func(path string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				if token != "" {
					req.Header.Set("Authorization", "Bearer "+token)
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec
			}
			for _, suffix := range []string{"", "/repos"} {
				rec := request("/api/orgs/private" + suffix)
				expected := http.StatusForbidden
				if tc.member {
					expected = http.StatusOK
				}
				require.Equal(t, expected, rec.Code, rec.Body.String())
			}
			rec := request("/api/orgs/public")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			rec = request("/api/orgs/public/repos")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var repos []routes.RepoResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &repos))
			expectedCount := 1
			if tc.member {
				expectedCount = 2
			}
			require.Len(t, repos, expectedCount, rec.Body.String())
			if !tc.member {
				require.Equal(t, "public-repo", repos[0].Name)
			}
		})
	}
}
