package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// plainCodec is a reversible stand-in for the AES-GCM codec.
type plainCodec struct{}

func (plainCodec) EncryptString(p string) (string, error) { return "enc:" + p, nil }
func (plainCodec) DecryptString(c string) (string, error) {
	if !strings.HasPrefix(c, "enc:") {
		return "", errors.New("bad ciphertext")
	}
	return strings.TrimPrefix(c, "enc:"), nil
}

type revokingCodec struct {
	plainCodec
	revoke func()
}

func (c revokingCodec) DecryptString(ciphertext string) (string, error) {
	if c.revoke != nil {
		c.revoke()
	}
	return c.plainCodec.DecryptString(ciphertext)
}

type fakeProviderConnectionQuerier struct {
	rows       map[string]db.ProviderConnection
	grants     []db.ProviderConnectionGrant
	repos      map[int64]db.Repository
	members    map[[2]int64]string
	orgs       map[string]db.Organization
	preference map[int64]string
	seq        int
	failures   []db.MarkProviderConnectionRefreshFailureParams
}

func newFakePCQ() *fakeProviderConnectionQuerier {
	return &fakeProviderConnectionQuerier{rows: map[string]db.ProviderConnection{}, repos: map[int64]db.Repository{}, members: map[[2]int64]string{}, orgs: map[string]db.Organization{}, preference: map[int64]string{}}
}

func (f *fakeProviderConnectionQuerier) CreateProviderConnection(_ context.Context, a db.CreateProviderConnectionParams) (db.ProviderConnection, error) {
	f.seq++
	row := db.ProviderConnection{ID: "conn-" + string(rune('0'+f.seq)), OwnerType: a.OwnerType, UserID: a.UserID, OrgID: a.OrgID, Provider: a.Provider, Kind: a.Kind, Label: a.Label, AccountEmail: a.AccountEmail, AccountID: a.AccountID, Plan: a.Plan, AccessTokenEncrypted: a.AccessTokenEncrypted, RefreshTokenEncrypted: a.RefreshTokenEncrypted, AccessExpiresAt: a.AccessExpiresAt, NextRefreshAt: a.NextRefreshAt, State: "active", CreatedBy: a.CreatedBy, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	f.rows[row.ID] = row
	return row, nil
}
func (f *fakeProviderConnectionQuerier) GetProviderConnection(_ context.Context, id string) (db.ProviderConnection, error) {
	row, ok := f.rows[id]
	if !ok {
		return db.ProviderConnection{}, pgx.ErrNoRows
	}
	return row, nil
}
func (f *fakeProviderConnectionQuerier) ListUserProviderConnections(_ context.Context, userID pgtype.Int8) ([]db.ProviderConnection, error) {
	var out []db.ProviderConnection
	for _, r := range f.rows {
		if r.OwnerType == "user" && r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) ListOrgProviderConnections(_ context.Context, orgID pgtype.Int8) ([]db.ProviderConnection, error) {
	var out []db.ProviderConnection
	for _, r := range f.rows {
		if r.OwnerType == "org" && r.OrgID == orgID {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) RevokeProviderConnection(_ context.Context, a db.RevokeProviderConnectionParams) (int64, error) {
	r := f.rows[a.ID]
	r.State = "revoked"
	r.LastError = a.LastError
	f.rows[a.ID] = r
	return 1, nil
}
func (f *fakeProviderConnectionQuerier) UpdateProviderConnectionTokens(_ context.Context, a db.UpdateProviderConnectionTokensParams) error {
	r := f.rows[a.ID]
	if r.State == "revoked" {
		return nil
	}
	r.AccessTokenEncrypted, r.RefreshTokenEncrypted, r.AccessExpiresAt, r.NextRefreshAt = a.AccessTokenEncrypted, a.RefreshTokenEncrypted, a.AccessExpiresAt, a.NextRefreshAt
	r.State, r.RefreshFailures, r.LastError = "active", 0, ""
	r.LastRefreshAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	f.rows[a.ID] = r
	return nil
}
func (f *fakeProviderConnectionQuerier) MarkProviderConnectionRefreshFailure(_ context.Context, a db.MarkProviderConnectionRefreshFailureParams) error {
	f.failures = append(f.failures, a)
	r := f.rows[a.ID]
	if r.State == "revoked" {
		return nil
	}
	r.RefreshFailures, r.NextRefreshAt, r.LastError, r.State = a.RefreshFailures, a.NextRefreshAt, a.LastError, a.State
	f.rows[a.ID] = r
	return nil
}
func (f *fakeProviderConnectionQuerier) ClaimProviderConnectionForRefresh(_ context.Context, a db.ClaimProviderConnectionForRefreshParams) (db.ProviderConnection, error) {
	for id, r := range f.rows {
		if r.State != "active" || len(r.RefreshTokenEncrypted) == 0 {
			continue
		}
		if r.AccessExpiresAt.Valid && r.AccessExpiresAt.Time.After(a.ExpiresBefore) {
			continue
		}
		if r.NextRefreshAt.Valid && r.NextRefreshAt.Time.After(time.Now()) {
			continue
		}
		r.NextRefreshAt = pgtype.Timestamptz{Time: a.LeaseUntil, Valid: true}
		f.rows[id] = r
		return r, nil
	}
	return db.ProviderConnection{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) ResolveActiveOrgProviderConnection(_ context.Context, a db.ResolveActiveOrgProviderConnectionParams) (db.ProviderConnection, error) {
	for _, r := range f.rows {
		if r.OwnerType == "org" && r.OrgID == a.OrgID && r.Provider == a.Provider && r.State == "active" {
			return r, nil
		}
	}
	return db.ProviderConnection{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) ResolveActiveUserProviderConnectionForRepository(_ context.Context, a db.ResolveActiveUserProviderConnectionForRepositoryParams) (db.ProviderConnection, error) {
	repo := f.repos[a.RepositoryID]
	for _, r := range f.rows {
		if r.OwnerType != "user" || r.UserID != a.UserID || r.Provider != a.Provider || r.State != "active" {
			continue
		}
		if repo.UserID.Valid && repo.UserID == a.UserID {
			return r, nil
		}
		for _, g := range f.grants {
			if g.ConnectionID != r.ID {
				continue
			}
			if g.AllRepositories || (g.RepositoryID.Valid && g.RepositoryID.Int64 == a.RepositoryID) || (g.OrgID.Valid && repo.OrgID.Valid && g.OrgID.Int64 == repo.OrgID.Int64) {
				return r, nil
			}
		}
	}
	return db.ProviderConnection{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) AddProviderConnectionGrant(_ context.Context, a db.AddProviderConnectionGrantParams) (db.ProviderConnectionGrant, error) {
	g := db.ProviderConnectionGrant{ID: int64(len(f.grants) + 1), ConnectionID: a.ConnectionID, RepositoryID: a.RepositoryID, OrgID: a.OrgID, AllRepositories: a.AllRepositories}
	f.grants = append(f.grants, g)
	return g, nil
}
func (f *fakeProviderConnectionQuerier) ListProviderConnectionGrants(_ context.Context, id string) ([]db.ProviderConnectionGrant, error) {
	var out []db.ProviderConnectionGrant
	for _, g := range f.grants {
		if g.ConnectionID == id {
			out = append(out, g)
		}
	}
	return out, nil
}
func (f *fakeProviderConnectionQuerier) DeleteProviderConnectionGrant(_ context.Context, a db.DeleteProviderConnectionGrantParams) (int64, error) {
	for i, g := range f.grants {
		if g.ID == a.ID && g.ConnectionID == a.ConnectionID {
			f.grants = append(f.grants[:i], f.grants[i+1:]...)
			return 1, nil
		}
	}
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) UpsertRepositoryProviderConnectionPreference(_ context.Context, a db.UpsertRepositoryProviderConnectionPreferenceParams) error {
	f.preference[a.RepositoryID] = a.Preference
	return nil
}
func (f *fakeProviderConnectionQuerier) GetRepositoryProviderConnectionPreference(_ context.Context, id int64) (string, error) {
	p, ok := f.preference[id]
	if !ok {
		return "", pgx.ErrNoRows
	}
	return p, nil
}
func (f *fakeProviderConnectionQuerier) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	r, ok := f.repos[id]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return r, nil
}
func (f *fakeProviderConnectionQuerier) GetOrgByLowerName(_ context.Context, name string) (db.Organization, error) {
	o, ok := f.orgs[name]
	if !ok {
		return db.Organization{}, pgx.ErrNoRows
	}
	return o, nil
}
func (f *fakeProviderConnectionQuerier) GetOrgMember(_ context.Context, a db.GetOrgMemberParams) (db.OrgMember, error) {
	role, ok := f.members[[2]int64{a.OrganizationID, a.UserID}]
	if !ok {
		return db.OrgMember{}, pgx.ErrNoRows
	}
	return db.OrgMember{OrganizationID: a.OrganizationID, UserID: a.UserID, Role: role}, nil
}

type stubRefresher struct {
	tokens RefreshedTokens
	err    error
	calls  int
}

func (s *stubRefresher) Refresh(context.Context, string, string) (RefreshedTokens, error) {
	s.calls++
	return s.tokens, s.err
}

func newPCService(q *fakeProviderConnectionQuerier, r ProviderTokenRefresher) *ProviderConnectionService {
	return NewProviderConnectionService(q, plainCodec{}, r)
}

func TestProviderConnection_ConnectValidatesKindsAndTokens(t *testing.T) {
	q := newFakePCQ()
	svc := newPCService(q, nil)
	actor := &db.User{ID: 7, Username: "will"}

	_, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "claude", AccessToken: "not-a-setup-token"})
	require.Error(t, err, "a Claude connection without a refresh token must be a setup token")

	_, err = svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "acc", RefreshToken: "ref"})
	require.Error(t, err, "codex needs the account id")

	out, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-abc"})
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionKindSetupToken, out.Kind)
	assert.False(t, out.HasRefreshToken)
	assert.Equal(t, "active", out.State)

	exp := time.Now().Add(time.Hour)
	out, err = svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "acc", RefreshToken: "ref", AccountID: "acct_1", AccessExpiresAt: &exp})
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionKindOAuth, out.Kind)
	assert.True(t, out.HasRefreshToken)
	row := q.rows[out.ID]
	assert.Equal(t, "enc:acc", string(row.AccessTokenEncrypted), "tokens are stored through the codec")
	assert.Equal(t, "enc:ref", string(row.RefreshTokenEncrypted))
}

func TestProviderConnection_WebRequestIsIdempotentAndAccountScoped(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	svc := newPCService(q, nil)
	alice, bob := &db.User{ID: 7}, &db.User{ID: 8}
	first, err := svc.ConnectForUser(context.Background(), alice, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-oat01-first"})
	require.NoError(t, err)
	replayed, err := svc.ConnectForUser(context.Background(), alice, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-oat01-second"})
	require.NoError(t, err)
	assert.Equal(t, first.ID, replayed.ID)
	assert.Equal(t, 1, len(q.rows))
	assert.Equal(t, "enc:sk-ant-oat01-first", string(q.rows[first.ID].AccessTokenEncrypted))
	foreign, err := svc.ResolveForRun(context.Background(), 8, 2, "claude")
	require.NoError(t, err)
	assert.Nil(t, foreign, "a collaborator cannot resolve the owner's connection")
	other, err := svc.ConnectForUser(context.Background(), bob, ConnectProviderInput{Provider: "claude", Label: "web-request-1", AccessToken: "sk-ant-oat01-bob"})
	require.NoError(t, err)
	assert.NotEqual(t, first.ID, other.ID)
	assert.Equal(t, 2, len(q.rows))
}

func TestProviderConnection_OrgConnectRequiresOwner(t *testing.T) {
	q := newFakePCQ()
	q.orgs["acme"] = db.Organization{ID: 3, Name: "acme", LowerName: "acme"}
	q.members[[2]int64{3, 7}] = "member"
	q.members[[2]int64{3, 8}] = "owner"
	svc := newPCService(q, nil)
	_, err := svc.ConnectForOrg(context.Background(), &db.User{ID: 7}, "acme", ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-x"})
	require.Error(t, err)
	out, err := svc.ConnectForOrg(context.Background(), &db.User{ID: 8}, "acme", ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-x"})
	require.NoError(t, err)
	assert.Equal(t, "org", out.OwnerType)
	// A member may list, and a non-member may not.
	_, err = svc.ListForOrg(context.Background(), &db.User{ID: 7}, "acme")
	require.NoError(t, err)
	_, err = svc.ListForOrg(context.Background(), &db.User{ID: 9}, "acme")
	require.Error(t, err)
}

func TestProviderConnection_ResolvePrecedence(t *testing.T) {
	q := newFakePCQ()
	q.repos[1] = db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 3, Valid: true}}
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	q.orgs["acme"] = db.Organization{ID: 3, LowerName: "acme"}
	q.members[[2]int64{3, 8}] = "owner"
	svc := newPCService(q, nil)
	owner := &db.User{ID: 8}
	user := &db.User{ID: 7}
	orgConn, err := svc.ConnectForOrg(context.Background(), owner, "acme", ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-org"})
	require.NoError(t, err)
	userConn, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-user"})
	require.NoError(t, err)

	// Org repo, default org_first: the org connection wins.
	resolved, err := svc.ResolveForRun(context.Background(), 7, 1, "smithers")
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, orgConn.ID, resolved.ConnectionID)
	assert.Equal(t, "sk-ant-oat01-org", resolved.AccessToken)

	// user_first on the org repo: the user has no grant, so still the org.
	require.NoError(t, svc.SetRepositoryPreference(context.Background(), 1, ProviderConnectionPreferenceUserFirst))
	resolved, err = svc.ResolveForRun(context.Background(), 7, 1, "smithers")
	require.NoError(t, err)
	assert.Equal(t, orgConn.ID, resolved.ConnectionID)

	// With an org grant the user connection wins under user_first.
	_, err = svc.AddGrant(context.Background(), user, userConn.ID, ProviderConnectionGrantInput{OrgID: ptrInt64(3)})
	require.NoError(t, err)
	resolved, err = svc.ResolveForRun(context.Background(), 7, 1, "smithers")
	require.NoError(t, err)
	assert.Equal(t, userConn.ID, resolved.ConnectionID)

	// The user's own repo needs no grant.
	resolved, err = svc.ResolveForRun(context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Equal(t, userConn.ID, resolved.ConnectionID)

	// platform_only never resolves; a codex run finds no codex connection.
	require.NoError(t, svc.SetRepositoryPreference(context.Background(), 2, ProviderConnectionPreferencePlatformOnly))
	resolved, err = svc.ResolveForRun(context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)
	resolved, err = svc.ResolveForRun(context.Background(), 7, 1, "codex")
	require.NoError(t, err)
	assert.Nil(t, resolved)

	// A revoked connection is skipped.
	require.NoError(t, svc.Revoke(context.Background(), user, userConn.ID))
	resolved, err = svc.ResolveForRun(context.Background(), 7, 2, "smithers")
	require.NoError(t, err)
	assert.Nil(t, resolved)
}

func TestProviderConnection_RevocationDuringResolutionFailsClosed(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	owner := &db.User{ID: 7}
	svc := newPCService(q, nil)
	connection, err := svc.ConnectForUser(context.Background(), owner, ConnectProviderInput{Provider: "claude", AccessToken: "sk-ant-oat01-fixture"})
	require.NoError(t, err)
	decrypted := false
	svc.codec = revokingCodec{revoke: func() {
		if decrypted {
			return
		}
		decrypted = true
		require.NoError(t, svc.Revoke(context.Background(), owner, connection.ID))
	}}
	resolved, err := svc.ResolveForRun(context.Background(), 7, 2, "claude")
	require.NoError(t, err)
	assert.Nil(t, resolved)
	assert.True(t, decrypted)
	assert.Equal(t, "revoked", q.rows[connection.ID].State)
	require.NoError(t, q.UpdateProviderConnectionTokens(context.Background(), db.UpdateProviderConnectionTokensParams{ID: connection.ID, AccessTokenEncrypted: []byte("enc:new-token")}))
	assert.Equal(t, "revoked", q.rows[connection.ID].State, "a late refresh must not reactivate a revoked connection")
}

func TestProviderConnection_RefreshLoopStates(t *testing.T) {
	q := newFakePCQ()
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "acc2", RefreshToken: "ref2", ExpiresAt: time.Now().Add(2 * time.Hour)}}
	svc := newPCService(q, refresher)
	user := &db.User{ID: 7}
	soon := time.Now().Add(10 * time.Minute)
	conn, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "codex", AccessToken: "acc1", RefreshToken: "ref1", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)

	did, err := svc.RefreshDue(context.Background())
	require.NoError(t, err)
	assert.True(t, did)
	assert.Equal(t, 1, refresher.calls)
	row := q.rows[conn.ID]
	assert.Equal(t, "enc:acc2", string(row.AccessTokenEncrypted))
	assert.Equal(t, "enc:ref2", string(row.RefreshTokenEncrypted), "a rotated refresh token replaces the old one")
	assert.True(t, row.NextRefreshAt.Time.After(time.Now()))

	// Nothing due now.
	did, err = svc.RefreshDue(context.Background())
	require.NoError(t, err)
	assert.False(t, did)

	// Transient failures back off and eventually mark refresh_failed.
	row.AccessExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true}
	row.NextRefreshAt = pgtype.Timestamptz{}
	q.rows[conn.ID] = row
	refresher.err = errors.New("503 from provider")
	for i := 0; i < providerConnectionMaxFailures; i++ {
		r := q.rows[conn.ID]
		r.NextRefreshAt = pgtype.Timestamptz{}
		q.rows[conn.ID] = r
		_, _ = svc.RefreshDue(context.Background())
	}
	assert.Equal(t, ProviderConnectionStateRefreshFailed, q.rows[conn.ID].State)
	assert.Contains(t, q.rows[conn.ID].LastError, "503")

	// invalid_grant means the token was revoked or reused elsewhere.
	conn2, err := svc.ConnectForUser(context.Background(), user, ConnectProviderInput{Provider: "codex", AccessToken: "a", RefreshToken: "r", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)
	refresher.err = ErrProviderRefreshInvalidGrant
	_, _ = svc.RefreshDue(context.Background())
	assert.Equal(t, ProviderConnectionStateRevoked, q.rows[conn2.ID].State)
}

func TestProviderConnection_DispatchRefreshesExpiringTokenSynchronously(t *testing.T) {
	q := newFakePCQ()
	q.repos[2] = db.Repository{ID: 2, UserID: pgtype.Int8{Int64: 7, Valid: true}}
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", ExpiresAt: time.Now().Add(time.Hour)}}
	svc := newPCService(q, refresher)
	soon := time.Now().Add(time.Minute)
	_, err := svc.ConnectForUser(context.Background(), &db.User{ID: 7}, ConnectProviderInput{Provider: "codex", AccessToken: "stale", RefreshToken: "r", AccountID: "acct", AccessExpiresAt: &soon})
	require.NoError(t, err)
	resolved, err := svc.ResolveForRun(context.Background(), 7, 2, "codex")
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, "fresh", resolved.AccessToken)
	assert.Equal(t, 1, refresher.calls)
}

func TestHTTPProviderTokenRefresher_ClaudeAndCodex(t *testing.T) {
	var seen []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		switch r.URL.Path {
		case "/claude":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "sk-ant-oat01-new", "refresh_token": "sk-ant-ort01-new", "expires_in": 3600})
		case "/codex":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "codex-new", "refresh_token": "codex-ref-new", "id_token": testIDToken(t, "acct_9", "pro", "p@example.com")})
		case "/revoked":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		}
	}))
	defer server.Close()
	r := NewHTTPProviderTokenRefresher(ProviderConnectionsConfig{ClaudeTokenURL: server.URL + "/claude", ClaudeClientID: "cid-claude", CodexTokenURL: server.URL + "/codex", CodexClientID: "cid-codex"}, server.Client())

	claude, err := r.Refresh(context.Background(), "claude", "sk-ant-ort01-old")
	require.NoError(t, err)
	assert.Equal(t, "sk-ant-oat01-new", claude.AccessToken)
	assert.WithinDuration(t, time.Now().Add(time.Hour), claude.ExpiresAt, 5*time.Second)
	assert.Equal(t, "cid-claude", seen[0]["client_id"])
	assert.Equal(t, "refresh_token", seen[0]["grant_type"])

	codex, err := r.Refresh(context.Background(), "codex", "codex-ref-old")
	require.NoError(t, err)
	assert.Equal(t, "acct_9", codex.AccountID)
	assert.Equal(t, "pro", codex.Plan)
	assert.Equal(t, "p@example.com", codex.AccountEmail)
	assert.Equal(t, "openid profile email", seen[1]["scope"])

	r2 := NewHTTPProviderTokenRefresher(ProviderConnectionsConfig{ClaudeTokenURL: server.URL + "/revoked"}, server.Client())
	_, err = r2.Refresh(context.Background(), "claude", "dead")
	assert.ErrorIs(t, err, ErrProviderRefreshInvalidGrant)
}

func TestCodexGuestAuthJSONCarriesNoCredential(t *testing.T) {
	doc := CodexGuestAuthJSON("acct_42", "p@example.com", "pro", time.Now())
	var parsed struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	require.NoError(t, json.Unmarshal(doc, &parsed))
	assert.Equal(t, "chatgpt", parsed.AuthMode)
	assert.Equal(t, sandbox.EgressProxyPlaceholder(codexAccessTokenEnvName), parsed.Tokens.AccessToken)
	assert.Equal(t, "acct_42", parsed.Tokens.AccountID)
	accountID, email, plan := codexIdentityClaims(parsed.Tokens.IDToken)
	assert.Equal(t, "acct_42", accountID)
	assert.Equal(t, "p@example.com", email)
	assert.Equal(t, "pro", plan)
	assert.Len(t, strings.Split(parsed.Tokens.IDToken, "."), 3)
}

func testIDToken(t *testing.T, accountID, plan, email string) string {
	t.Helper()
	claims, _ := json.Marshal(map[string]any{"email": email, "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": accountID, "chatgpt_plan_type": plan}})
	return "eyJhbGciOiJSUzI1NiJ9." + base64URL(claims) + ".sig"
}

func base64URL(b []byte) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var out strings.Builder
	for i := 0; i < len(b); i += 3 {
		var chunk [3]byte
		n := copy(chunk[:], b[i:])
		v := uint32(chunk[0])<<16 | uint32(chunk[1])<<8 | uint32(chunk[2])
		out.WriteByte(table[v>>18&63])
		out.WriteByte(table[v>>12&63])
		if n > 1 {
			out.WriteByte(table[v>>6&63])
		}
		if n > 2 {
			out.WriteByte(table[v&63])
		}
	}
	return out.String()
}

func TestProviderConnection_ManualRefreshRecoversFailedConnection(t *testing.T) {
	q := newFakePCQ()
	refresher := &stubRefresher{tokens: RefreshedTokens{AccessToken: "fresh", RefreshToken: "rotated", ExpiresAt: time.Now().Add(time.Hour)}}
	svc := newPCService(q, refresher)
	actor := &db.User{ID: 7}
	connection, err := svc.ConnectForUser(context.Background(), actor, ConnectProviderInput{Provider: "codex", AccessToken: "old", RefreshToken: "refresh", AccountID: "acct"})
	require.NoError(t, err)
	row := q.rows[connection.ID]
	row.State, row.RefreshFailures, row.LastError = ProviderConnectionStateRefreshFailed, 5, "temporary provider failure"
	q.rows[connection.ID] = row
	updated, err := svc.RefreshNow(context.Background(), actor, connection.ID)
	require.NoError(t, err)
	assert.Equal(t, ProviderConnectionStateActive, updated.State)
	assert.Equal(t, "enc:fresh", string(q.rows[connection.ID].AccessTokenEncrypted))
	assert.Zero(t, q.rows[connection.ID].RefreshFailures)
}
