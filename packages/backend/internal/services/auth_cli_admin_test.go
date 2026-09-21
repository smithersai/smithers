package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type cliAdminQueries struct {
	*mockAuthQuerier
	mint func(context.Context, db.CreateAdminCLIAccessTokenParams) (db.CreateAdminCLIAccessTokenRow, error)
}

func (q *cliAdminQueries) CreateAdminCLIAccessToken(ctx context.Context, arg db.CreateAdminCLIAccessTokenParams) (db.CreateAdminCLIAccessTokenRow, error) {
	return q.mint(ctx, arg)
}

func TestAdminCLILoginTTL(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		want  time.Duration
		valid bool
	}{{"", time.Hour, true}, {"5m", 5 * time.Minute, true}, {"12h", 12 * time.Hour, true}, {"1h", time.Hour, true}, {"300s", 5 * time.Minute, true}, {"4m59s", 0, false}, {"12h1s", 0, false}, {"0", 0, false}, {"-1h", 0, false}, {"forever", 0, false}, {"9999999999999999999h", 0, false}} {
		t.Run(tc.raw, func(t *testing.T) {
			writes := 0
			q := &mockAuthQuerier{createOAuthStateFn: func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
				writes++
				request, err := decodeAdminCLIRequest(arg.RequestedScopes)
				require.NoError(t, err)
				require.Equal(t, tc.want, request.TTL)
				require.Equal(t, 4321, request.CallbackPort)
				require.Equal(t, strings.Repeat("A", 43), request.CallbackState)
				require.Equal(t, hashOAuthStateVerifier("verifier"), arg.ContextHash)
				return db.OauthState{}, nil
			}}
			s := NewAuthService(q, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
			_, err := s.StartAdminCLILogin(context.Background(), "verifier", tc.raw, 4321, strings.Repeat("A", 43), "")
			if tc.valid {
				require.NoError(t, err)
				require.Equal(t, 1, writes)
			} else {
				require.Error(t, err)
				require.Zero(t, writes)
			}
		})
	}
}

func TestAdminCLIPlainScopesStillRejected(t *testing.T) {
	s := NewAuthService(&mockAuthQuerier{}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	for _, scopes := range []string{"read:admin", "write:admin", "admin", "all", "write:repository,read:admin"} {
		_, err := s.StartGitHubOAuthWithScopes(context.Background(), "verifier", scopes)
		require.Error(t, err)
		_, err = s.StartAdminCLILogin(context.Background(), "verifier", "1h", 4321, "", scopes)
		require.Error(t, err)
	}
}

func newCLIAdminFixture(t *testing.T) (*AuthService, *cliAdminQueries, *time.Time, *db.User, *[]db.CreateAdminCLIAccessTokenParams) {
	t.Helper()
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	user := db.User{ID: 7, Username: "operator", IsAdmin: true}
	states := map[string]db.CreateOAuthStateParams{}
	mu := sync.Mutex{}
	minted := []db.CreateAdminCLIAccessTokenParams{}
	q := &cliAdminQueries{mockAuthQuerier: &mockAuthQuerier{}}
	q.createOAuthStateFn = func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
		mu.Lock()
		defer mu.Unlock()
		states[arg.State] = arg
		return db.OauthState{}, nil
	}
	q.consumeOAuthStateWithScopesFn = func(_ context.Context, arg db.ConsumeOAuthStateWithScopesParams) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		value, ok := states[arg.State]
		if !ok || value.ContextHash != arg.ContextHash || !now.Before(value.ExpiresAt) {
			return nil, pgx.ErrNoRows
		}
		delete(states, arg.State)
		return value.RequestedScopes, nil
	}
	q.getUserByIDFn = func(_ context.Context, id int64) (db.User, error) { require.Equal(t, user.ID, id); return user, nil }
	q.mint = func(_ context.Context, arg db.CreateAdminCLIAccessTokenParams) (db.CreateAdminCLIAccessTokenRow, error) {
		mu.Lock()
		defer mu.Unlock()
		minted = append(minted, arg)
		return db.CreateAdminCLIAccessTokenRow{ID: 42, UserID: arg.UserID, Name: "smithers-cli-admin", Scopes: arg.Scopes, ExpiresAt: arg.ExpiresAt, TokenLastEight: arg.TokenLastEight}, nil
	}
	s := NewAuthService(q, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	s.now = func() time.Time { return now }
	return s, q, &now, &user, &minted
}

func TestAdminCLIConsentRequiredAndAudited(t *testing.T) {
	s, _, now, user, minted := newCLIAdminFixture(t)
	result := OAuthCallbackResult{User: *user, AdminCLI: &AdminCLIRequest{TTL: time.Hour, CallbackPort: 4321, CallbackState: strings.Repeat("A", 43)}}
	consent, err := s.PrepareAdminCLIConsent(context.Background(), result, "upstream-state", "verifier")
	require.NoError(t, err)
	require.Empty(t, *minted, "rendering consent must not create a PAT")
	require.ElementsMatch(t, []string{"write:organization", "write:repository", "write:user", "read:admin", "write:admin"}, consent.Scopes)
	require.Equal(t, now.Add(time.Hour), consent.ExpiresAt)
	require.Equal(t, 4321, consent.CallbackPort)
	for _, pair := range [][2]string{{"bad-verifier", consent.CSRF}, {"verifier", "bad-csrf"}, {"", ""}} {
		_, err = s.ApproveAdminCLILogin(context.Background(), consent.State, pair[0], pair[1], "127.0.0.1:20")
		require.Error(t, err)
		require.Empty(t, *minted)
	}
	// Lifetime starts at approval, even if the human deliberates on the page.
	*now = now.Add(2 * time.Minute)
	approved, err := s.ApproveAdminCLILogin(context.Background(), consent.State, "verifier", consent.CSRF, "127.0.0.1:20")
	require.NoError(t, err)
	require.Len(t, *minted, 1)
	arg := (*minted)[0]
	require.Equal(t, "operator", arg.ActorName)
	require.Equal(t, int64(7), arg.UserID)
	require.Equal(t, "127.0.0.1", arg.IpAddress)
	require.JSONEq(t, `{"ttl":"1h0m0s","callback_port":4321,"ip":"127.0.0.1"}`, string(arg.Metadata))
	require.Equal(t, now.Add(time.Hour), arg.ExpiresAt.Time)
	require.Equal(t, arg.ExpiresAt.Time, *approved.Token.ExpiresAt)
	require.ElementsMatch(t, consent.Scopes, strings.Split(arg.Scopes, ","))
	require.Equal(t, "smithers-cli-admin", approved.Token.Name)
	require.Equal(t, *result.AdminCLI, approved.Request, "consent must preserve the durable callback binding")
	require.True(t, strings.HasPrefix(approved.Token.Token, "smithers_"))
	hash := sha256.Sum256([]byte(approved.Token.Token))
	require.Equal(t, hex.EncodeToString(hash[:]), arg.TokenHash)
	_, err = s.ApproveAdminCLILogin(context.Background(), consent.State, "verifier", consent.CSRF, "")
	require.Error(t, err)
	require.Len(t, *minted, 1)
}

func TestAdminCLIRejectsNonAdminAndExpiredConsent(t *testing.T) {
	for _, tc := range []string{"non-admin", "demoted", "suspended", "expired", "audit-failed"} {
		t.Run(tc, func(t *testing.T) {
			s, q, now, user, minted := newCLIAdminFixture(t)
			if tc == "non-admin" {
				user.IsAdmin = false
			}
			consent, err := s.PrepareAdminCLIConsent(context.Background(), OAuthCallbackResult{User: *user, AdminCLI: &AdminCLIRequest{TTL: time.Hour, CallbackPort: 4321}}, "upstream", "verifier")
			if tc == "non-admin" {
				require.Error(t, err)
				require.Empty(t, *minted)
				return
			}
			require.NoError(t, err)
			switch tc {
			case "demoted":
				user.IsAdmin = false
			case "suspended":
				user.ProhibitLogin = true
			case "expired":
				*now = now.Add(10 * time.Minute)
			case "audit-failed":
				q.mint = func(context.Context, db.CreateAdminCLIAccessTokenParams) (db.CreateAdminCLIAccessTokenRow, error) {
					return db.CreateAdminCLIAccessTokenRow{}, fmt.Errorf("audit insert failed")
				}
			}
			approved, err := s.ApproveAdminCLILogin(context.Background(), consent.State, "verifier", consent.CSRF, "")
			require.Error(t, err)
			require.Empty(t, approved.Token.Token)
			require.Empty(t, *minted)
		})
	}
}

func TestAdminCLIRejectsConsentAsOAuthState(t *testing.T) {
	s, _, _, _, _ := newCLIAdminFixture(t)
	_, err := s.CompleteGitHubOAuth(context.Background(), "code", adminCLIConsentPrefix+"state", "verifier")
	require.Error(t, err)
}

func TestAdminCLIStatePayloadValidation(t *testing.T) {
	for _, raw := range []string{"invalid", `{"ttl":0}`, `{"ttl":3600000000000,"callback_port":1}`} {
		_, err := decodeAdminCLIRequest([]string{adminCLIRequestPrefix + raw})
		require.Error(t, err)
	}
	request, err := decodeAdminCLIRequest([]string{"write:user"})
	require.NoError(t, err)
	require.Nil(t, request)
	// Payloads are server-owned JSON, not a new user-controlled scope grammar.
	raw, _ := json.Marshal(AdminCLIRequest{TTL: time.Hour, CallbackPort: 4321, CallbackState: strings.Repeat("A", 43)})
	request, err = decodeAdminCLIRequest([]string{adminCLIRequestPrefix + string(raw)})
	require.NoError(t, err)
	require.Equal(t, 4321, request.CallbackPort)
	require.Equal(t, strings.Repeat("A", 43), request.CallbackState)
}

func TestAdminCLIOAuthCallbackDoesNotMintSessionOrToken(t *testing.T) {
	for _, isAdmin := range []bool{false, true} {
		t.Run(fmt.Sprint(isAdmin), func(t *testing.T) {
			s, q, _, user, minted := newCLIAdminFixture(t)
			user.IsAdmin = isAdmin
			q.getOAuthAccountByProviderUserIDFn = func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
				return db.OauthAccount{UserID: user.ID}, nil
			}
			q.upsertOAuthAccountFn = func(context.Context, db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
				return db.OauthAccount{}, nil
			}
			q.upsertEmailAddressFn = func(context.Context, db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error) {
				return db.UpsertEmailAddressRow{}, nil
			}
			q.createAuthSessionFn = func(context.Context, db.CreateAuthSessionParams) (db.AuthSession, error) {
				t.Error("admin OAuth must not create a browser session")
				return db.AuthSession{}, nil
			}
			s.githubClient = mockGitHubClient{
				exchangeCodeFn: func(context.Context, string) (GitHubTokenResult, error) {
					return GitHubTokenResult{AccessToken: "github-token"}, nil
				},
				fetchUserFn: func(context.Context, string) (GitHubUserProfile, error) {
					return GitHubUserProfile{ID: 101, Login: user.Username}, nil
				},
				fetchEmailsFn: func(context.Context, string) ([]GitHubEmail, error) {
					return []GitHubEmail{{Email: "operator@example.com", Primary: true, Verified: true}}, nil
				},
			}
			start, err := s.StartAdminCLILogin(context.Background(), "verifier", "1h", 4321, "", "")
			require.NoError(t, err)
			parsed, err := url.Parse(start)
			require.NoError(t, err)
			result, err := s.CompleteGitHubOAuth(context.Background(), "code", parsed.Query().Get("state"), "verifier")
			require.NoError(t, err)
			require.NotNil(t, result.AdminCLI)
			require.Equal(t, isAdmin, result.User.IsAdmin)
			require.Empty(t, result.SessionKey)
			require.Empty(t, result.TokenScopes)
			require.Empty(t, *minted)
		})
	}
}

func TestAdminCLIAuditIPv6(t *testing.T) {
	s, _, _, user, minted := newCLIAdminFixture(t)
	consent, err := s.PrepareAdminCLIConsent(context.Background(), OAuthCallbackResult{User: *user, AdminCLI: &AdminCLIRequest{TTL: time.Hour, CallbackPort: 4321}}, "upstream", "verifier")
	require.NoError(t, err)
	_, err = s.ApproveAdminCLILogin(context.Background(), consent.State, "verifier", consent.CSRF, "[2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff]:65535")
	require.NoError(t, err)
	require.Equal(t, "2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", (*minted)[0].IpAddress)
}
