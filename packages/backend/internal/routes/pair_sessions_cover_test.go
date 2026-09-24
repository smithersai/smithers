package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type pairSessionsCovService struct {
	err       error
	errByCall map[string]error
	calls     []string

	createSession db.PairSession
	resolution    services.PairResolution
	members       []db.ListLivePairSessionMemberProfilesRow
	member        db.PairSessionMember
	session       db.PairSession
	inviteResult  services.InviteResult
	invites       []db.PairSessionInvite
	link          db.PairSessionLink
	links         []db.PairSessionLink
	prompt        db.PairPromptQueue
	queue         []db.PairPromptQueue
	draft         db.PairSessionDraft

	lastActor             int64
	lastRepositoryID      int64
	lastTargetUserID      int64
	lastSessionID         string
	lastSourceWorkspaceID string
	lastSlug              string
	lastRole              string
	lastMode              string
	lastEmail             string
	lastUsername          string
	lastLinkID            string
	lastPromptID          string
	lastClientID          string
	lastRunID             string
	lastStatus            string
	lastSource            string
	lastBody              string
	lastContent           string
	lastVersion           int64
	lastPresence          json.RawMessage
	lastLease             time.Duration
}

func pairSessionsCovNewService() *pairSessionsCovService {
	now := time.Unix(1700001000, 0).UTC()
	emailInvite := db.PairSessionInvite{
		ID:         "invite-email",
		SessionID:  "sess1",
		LowerEmail: pgtype.Text{String: "friend@example.com", Valid: true},
		Role:       services.PairRoleEditor,
		TokenHash:  "digest-email",
		InvitedBy:  42,
		ExpiresAt:  now.Add(24 * time.Hour),
		CreatedAt:  now,
	}
	usernameInvite := db.PairSessionInvite{
		ID:                  "invite-user",
		SessionID:           "sess1",
		LowerEmail:          pgtype.Text{String: "private@example.com", Valid: true},
		LowerGithubUsername: pgtype.Text{String: "octocat", Valid: true},
		Role:                services.PairRoleViewer,
		TokenHash:           "digest-user",
		InvitedBy:           42,
		ExpiresAt:           now.Add(24 * time.Hour),
		CreatedAt:           now,
	}
	link := db.PairSessionLink{
		ID:        "link1",
		SessionID: "sess1",
		Slug:      "slug-one",
		Role:      services.PairRoleViewer,
		CreatedBy: 42,
		CreatedAt: now,
	}
	prompt := db.PairPromptQueue{
		ID:           "prompt1",
		SessionID:    "sess1",
		Seq:          2,
		AuthorUserID: 42,
		Source:       "composer",
		Body:         "build the branch",
		Status:       "queued",
		CreatedAt:    now,
	}

	return &pairSessionsCovService{
		createSession: db.PairSession{
			ID:                "sess-new",
			OwnerUserID:       42,
			SourceWorkspaceID: "11111111-1111-1111-1111-111111111111",
			AccessMode:        "invite",
			Status:            "provisioning",
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		resolution: services.PairResolution{
			Session: db.PairSession{
				ID:                "sess1",
				OwnerUserID:       42,
				SourceWorkspaceID: "11111111-1111-1111-1111-111111111111",
				AccessMode:        "link",
				Status:            "active",
				CreatedAt:         now,
				UpdatedAt:         now,
			},
			Role:         services.PairRoleEditor,
			Materialized: true,
		},
		members: []db.ListLivePairSessionMemberProfilesRow{{
			SessionID:   "sess1",
			UserID:      77,
			Role:        services.PairRoleEditor,
			JoinedAt:    now,
			Username:    "octocat",
			DisplayName: "Octo Cat",
			AvatarUrl:   "https://example.test/avatar.png",
		}},
		member: db.PairSessionMember{
			SessionID: "sess1",
			UserID:    77,
			Role:      services.PairRoleViewer,
			JoinedAt:  now,
		},
		session: db.PairSession{
			ID:          "sess1",
			OwnerUserID: 42,
			AccessMode:  "link",
			Status:      "active",
			CreatedAt:   now,
			UpdatedAt:   now,
		},
		inviteResult: services.InviteResult{
			Invite:         emailInvite,
			Token:          "raw-token",
			Delivered:      true,
			DeliveryDetail: "queued",
		},
		invites: []db.PairSessionInvite{emailInvite, usernameInvite},
		link:    link,
		links:   []db.PairSessionLink{link},
		prompt:  prompt,
		queue:   []db.PairPromptQueue{prompt},
		draft: db.PairSessionDraft{
			SessionID: "sess1",
			Content:   "draft body",
			Version:   3,
			UpdatedBy: pgtype.Int8{Int64: 42, Valid: true},
			UpdatedAt: now,
		},
	}
}

func (s *pairSessionsCovService) errFor(call string) error {
	s.calls = append(s.calls, call)
	if s.errByCall != nil {
		if err, ok := s.errByCall[call]; ok {
			return err
		}
	}
	return s.err
}

func (s *pairSessionsCovService) called(call string) bool {
	for _, got := range s.calls {
		if got == call {
			return true
		}
	}
	return false
}

func (s *pairSessionsCovService) CreateSession(_ context.Context, ownerID, repositoryID int64, sourceWorkspaceID string) (db.PairSession, error) {
	s.lastActor, s.lastRepositoryID, s.lastSourceWorkspaceID = ownerID, repositoryID, sourceWorkspaceID
	if err := s.errFor("CreateSession"); err != nil {
		return db.PairSession{}, err
	}
	return s.createSession, nil
}

func (s *pairSessionsCovService) ResolveSession(_ context.Context, sessionID string, visitorID int64) (services.PairResolution, error) {
	s.lastActor, s.lastSessionID = visitorID, sessionID
	if err := s.errFor("ResolveSession"); err != nil {
		return services.PairResolution{}, err
	}
	return s.resolution, nil
}

func (s *pairSessionsCovService) PreviewSession(_ context.Context, sessionID string, visitorID int64) (services.PairResolution, error) {
	s.lastActor, s.lastSessionID = visitorID, sessionID
	if err := s.errFor("PreviewSession"); err != nil {
		return services.PairResolution{}, err
	}
	resolution := s.resolution
	resolution.Materialized = false
	return resolution, nil
}

func (s *pairSessionsCovService) ResolveByLink(_ context.Context, slug string, visitorID int64) (services.PairResolution, error) {
	s.lastActor, s.lastSlug = visitorID, slug
	if err := s.errFor("ResolveByLink"); err != nil {
		return services.PairResolution{}, err
	}
	return s.resolution, nil
}

func (s *pairSessionsCovService) PreviewByLink(_ context.Context, slug string, visitorID int64) (services.PairResolution, error) {
	s.lastActor, s.lastSlug = visitorID, slug
	if err := s.errFor("PreviewByLink"); err != nil {
		return services.PairResolution{}, err
	}
	resolution := s.resolution
	resolution.Materialized = false
	return resolution, nil
}

func (s *pairSessionsCovService) PreviewForSource(_ context.Context, sourceWorkspaceID string, visitorID int64) (services.PairResolution, error) {
	s.lastActor, s.lastSourceWorkspaceID = visitorID, sourceWorkspaceID
	if err := s.errFor("PreviewForSource"); err != nil {
		return services.PairResolution{}, err
	}
	resolution := s.resolution
	resolution.Materialized = false
	return resolution, nil
}

func (s *pairSessionsCovService) EndSession(_ context.Context, sessionID string, actorID int64) error {
	s.lastActor, s.lastSessionID = actorID, sessionID
	return s.errFor("EndSession")
}

func (s *pairSessionsCovService) ListMembers(_ context.Context, sessionID string, actorID int64) ([]db.PairSessionMember, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("ListMembers"); err != nil {
		return nil, err
	}
	return []db.PairSessionMember{s.member}, nil
}

func (s *pairSessionsCovService) ListMemberProfiles(_ context.Context, sessionID string, actorID int64) ([]db.ListLivePairSessionMemberProfilesRow, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("ListMemberProfiles"); err != nil {
		return nil, err
	}
	return s.members, nil
}

func (s *pairSessionsCovService) SetMemberRole(_ context.Context, sessionID string, actorID, targetUserID int64, role string) (db.PairSessionMember, error) {
	s.lastActor, s.lastSessionID, s.lastTargetUserID, s.lastRole = actorID, sessionID, targetUserID, role
	if err := s.errFor("SetMemberRole"); err != nil {
		return db.PairSessionMember{}, err
	}
	member := s.member
	member.UserID = targetUserID
	member.Role = role
	return member, nil
}

func (s *pairSessionsCovService) RevokeMember(_ context.Context, sessionID string, actorID, targetUserID int64) error {
	s.lastActor, s.lastSessionID, s.lastTargetUserID = actorID, sessionID, targetUserID
	return s.errFor("RevokeMember")
}

func (s *pairSessionsCovService) SetAccessMode(_ context.Context, sessionID string, actorID int64, mode string) (db.PairSession, error) {
	s.lastActor, s.lastSessionID, s.lastMode = actorID, sessionID, mode
	if err := s.errFor("SetAccessMode"); err != nil {
		return db.PairSession{}, err
	}
	session := s.session
	session.AccessMode = mode
	return session, nil
}

func (s *pairSessionsCovService) CreateInvite(_ context.Context, sessionID string, actorID int64, rawEmail, role string) (services.InviteResult, error) {
	s.lastActor, s.lastSessionID, s.lastEmail, s.lastRole = actorID, sessionID, rawEmail, role
	if err := s.errFor("CreateInvite"); err != nil {
		return services.InviteResult{}, err
	}
	result := s.inviteResult
	result.Invite.LowerEmail = pgtype.Text{String: strings.ToLower(rawEmail), Valid: true}
	result.Invite.LowerGithubUsername = pgtype.Text{}
	result.Invite.Role = role
	return result, nil
}

func (s *pairSessionsCovService) CreateInviteByUsername(_ context.Context, sessionID string, actorID int64, rawUsername, role string) (services.InviteResult, error) {
	s.lastActor, s.lastSessionID, s.lastUsername, s.lastRole = actorID, sessionID, rawUsername, role
	if err := s.errFor("CreateInviteByUsername"); err != nil {
		return services.InviteResult{}, err
	}
	result := s.inviteResult
	result.Invite.LowerEmail = pgtype.Text{String: "private@example.com", Valid: true}
	result.Invite.LowerGithubUsername = pgtype.Text{String: strings.ToLower(rawUsername), Valid: true}
	result.Invite.Role = role
	return result, nil
}

func (s *pairSessionsCovService) ListInvites(_ context.Context, sessionID string, actorID int64) ([]db.PairSessionInvite, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("ListInvites"); err != nil {
		return nil, err
	}
	return s.invites, nil
}

func (s *pairSessionsCovService) RevokeInvite(_ context.Context, sessionID string, actorID int64, rawEmail string) error {
	s.lastActor, s.lastSessionID, s.lastEmail = actorID, sessionID, rawEmail
	return s.errFor("RevokeInvite")
}

func (s *pairSessionsCovService) RevokeInviteByUsername(_ context.Context, sessionID string, actorID int64, rawUsername string) error {
	s.lastActor, s.lastSessionID, s.lastUsername = actorID, sessionID, rawUsername
	return s.errFor("RevokeInviteByUsername")
}

func (s *pairSessionsCovService) MintLink(_ context.Context, sessionID string, actorID int64, role string) (db.PairSessionLink, error) {
	s.lastActor, s.lastSessionID, s.lastRole = actorID, sessionID, role
	if err := s.errFor("MintLink"); err != nil {
		return db.PairSessionLink{}, err
	}
	link := s.link
	link.Role = role
	return link, nil
}

func (s *pairSessionsCovService) ListLinks(_ context.Context, sessionID string, actorID int64) ([]db.PairSessionLink, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("ListLinks"); err != nil {
		return nil, err
	}
	return s.links, nil
}

func (s *pairSessionsCovService) RevokeLink(_ context.Context, sessionID string, actorID int64, linkID string) error {
	s.lastActor, s.lastSessionID, s.lastLinkID = actorID, sessionID, linkID
	return s.errFor("RevokeLink")
}

func (s *pairSessionsCovService) Enqueue(_ context.Context, sessionID string, actorID int64, source, body string) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastSource, s.lastBody = actorID, sessionID, source, body
	if err := s.errFor("Enqueue"); err != nil {
		return db.PairPromptQueue{}, err
	}
	prompt := s.prompt
	prompt.Source = source
	prompt.Body = body
	return prompt, nil
}

func (s *pairSessionsCovService) ListQueue(_ context.Context, sessionID string, actorID int64) ([]db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("ListQueue"); err != nil {
		return nil, err
	}
	return s.queue, nil
}

func (s *pairSessionsCovService) Claim(_ context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastPromptID, s.lastClientID, s.lastLease = actorID, sessionID, promptID, clientID, lease
	if err := s.errFor("Claim"); err != nil {
		return db.PairPromptQueue{}, err
	}
	return s.prompt, nil
}

func (s *pairSessionsCovService) Start(_ context.Context, sessionID string, actorID int64, promptID, clientID, runID string) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastPromptID, s.lastClientID, s.lastRunID = actorID, sessionID, promptID, clientID, runID
	if err := s.errFor("Start"); err != nil {
		return db.PairPromptQueue{}, err
	}
	return s.prompt, nil
}

func (s *pairSessionsCovService) Renew(_ context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastPromptID, s.lastClientID, s.lastLease = actorID, sessionID, promptID, clientID, lease
	if err := s.errFor("Renew"); err != nil {
		return db.PairPromptQueue{}, err
	}
	return s.prompt, nil
}

func (s *pairSessionsCovService) Finish(_ context.Context, sessionID string, actorID int64, promptID, clientID, status string) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastPromptID, s.lastClientID, s.lastStatus = actorID, sessionID, promptID, clientID, status
	if err := s.errFor("Finish"); err != nil {
		return db.PairPromptQueue{}, err
	}
	prompt := s.prompt
	prompt.Status = status
	return prompt, nil
}

func (s *pairSessionsCovService) Cancel(_ context.Context, sessionID string, actorID int64, promptID string) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID, s.lastPromptID = actorID, sessionID, promptID
	if err := s.errFor("Cancel"); err != nil {
		return db.PairPromptQueue{}, err
	}
	prompt := s.prompt
	prompt.Status = "cancelled"
	return prompt, nil
}

func (s *pairSessionsCovService) GetDraft(_ context.Context, sessionID string, actorID int64) (db.PairSessionDraft, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("GetDraft"); err != nil {
		return db.PairSessionDraft{}, err
	}
	return s.draft, nil
}

func (s *pairSessionsCovService) PutDraft(_ context.Context, sessionID string, actorID int64, content string, version int64) (db.PairSessionDraft, error) {
	s.lastActor, s.lastSessionID, s.lastContent, s.lastVersion = actorID, sessionID, content, version
	if err := s.errFor("PutDraft"); err != nil {
		return db.PairSessionDraft{}, err
	}
	draft := s.draft
	draft.Content = content
	draft.Version = version
	return draft, nil
}

func (s *pairSessionsCovService) SubmitDraft(_ context.Context, sessionID string, actorID int64) (db.PairPromptQueue, error) {
	s.lastActor, s.lastSessionID = actorID, sessionID
	if err := s.errFor("SubmitDraft"); err != nil {
		return db.PairPromptQueue{}, err
	}
	return s.prompt, nil
}

func (s *pairSessionsCovService) Heartbeat(_ context.Context, sessionID string, actorID int64, presence json.RawMessage) error {
	s.lastActor, s.lastSessionID, s.lastPresence = actorID, sessionID, append(json.RawMessage(nil), presence...)
	return s.errFor("Heartbeat")
}

func pairSessionsCovRequest(method, target, body string) *http.Request {
	if body == "" {
		return httptest.NewRequest(method, target, nil)
	}
	return httptest.NewRequest(method, target, strings.NewReader(body))
}

func pairSessionsCovServe(h *PairSessionHandler, req *http.Request, userID int64) *httptest.ResponseRecorder {
	// Session-authenticated requests carry the CSRF double-submit pair, like a
	// real cookie-authed SPA: the preview GETs enforce it as defense in depth.
	req.Header.Set("X-CSRF-Token", "cov-csrf")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "cov-csrf"})
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
				User:        &db.User{ID: userID, Username: "cov-user"},
				IsTokenAuth: false,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	h.Mount(router)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func pairSessionsCovDirectRequest(method, target, body string, params map[string]string) *http.Request {
	req := pairSessionsCovRequest(method, target, body)
	rctx := chi.NewRouteContext()
	for key, value := range params {
		rctx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestPairSessions_Cov_InviteJSONRedactsAndSelectsPublicKey(t *testing.T) {
	now := time.Unix(1700002000, 0).UTC()
	invites := []db.PairSessionInvite{
		{
			ID:         "email",
			SessionID:  "sess1",
			LowerEmail: pgtype.Text{String: "friend@example.com", Valid: true},
			Role:       services.PairRoleViewer,
			TokenHash:  "secret-digest",
			ExpiresAt:  now,
			CreatedAt:  now,
		},
		{
			ID:                  "username",
			SessionID:           "sess1",
			LowerEmail:          pgtype.Text{String: "private@example.com", Valid: true},
			LowerGithubUsername: pgtype.Text{String: "octocat", Valid: true},
			Role:                services.PairRoleEditor,
			TokenHash:           "secret-digest",
			ExpiresAt:           now,
			CreatedAt:           now,
		},
		{
			ID:        "unkeyed",
			SessionID: "sess1",
			Role:      services.PairRoleViewer,
			TokenHash: "secret-digest",
			ExpiresAt: now,
			CreatedAt: now,
		},
	}

	out := pairInvitesJSON(invites)
	require.Len(t, out, 3)
	assert.Equal(t, "friend@example.com", out[0]["lower_email"])
	assert.NotContains(t, out[0], "token_hash")
	assert.Equal(t, "octocat", out[1]["lower_github_username"])
	assert.NotContains(t, out[1], "lower_email", "username-keyed invites must not leak a stored email")
	assert.NotContains(t, out[1], "token_hash")
	assert.NotContains(t, out[2], "lower_email")
	assert.NotContains(t, out[2], "lower_github_username")
	assert.Equal(t, services.PairRoleViewer, out[2]["role"])
}

func TestPairSessions_Cov_DirectHandlersRejectMissingActor(t *testing.T) {
	h := NewPairSessionHandler(pairSessionsCovNewService())
	cases := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		target  string
		body    string
		params  map[string]string
	}{
		{"create", h.Create, http.MethodPost, "/api/pair-sessions", `{"repositoryId":1}`, nil},
		{"lookup", h.LookupForSource, http.MethodGet, "/api/pair-sessions", "", nil},
		{"resolve", h.Resolve, http.MethodGet, "/api/pair-sessions/sess1", "", map[string]string{"id": "sess1"}},
		{"resolve_by_link", h.ResolveByLink, http.MethodGet, "/api/pair-sessions/by-link/slug", "", map[string]string{"slug": "slug"}},
		{"end", h.End, http.MethodPost, "/api/pair-sessions/sess1/end", "", map[string]string{"id": "sess1"}},
		{"list_members", h.ListMembers, http.MethodGet, "/api/pair-sessions/sess1/members", "", map[string]string{"id": "sess1"}},
		{"set_member_role", h.SetMemberRole, http.MethodPatch, "/api/pair-sessions/sess1/members/7", `{"role":"viewer"}`, map[string]string{"id": "sess1", "userId": "7"}},
		{"revoke_member", h.RevokeMember, http.MethodDelete, "/api/pair-sessions/sess1/members/7", "", map[string]string{"id": "sess1", "userId": "7"}},
		{"set_access", h.SetAccessMode, http.MethodPatch, "/api/pair-sessions/sess1/access", `{"mode":"link"}`, map[string]string{"id": "sess1"}},
		{"create_invite", h.CreateInvite, http.MethodPost, "/api/pair-sessions/sess1/invites", `{"email":"a@example.com","role":"viewer"}`, map[string]string{"id": "sess1"}},
		{"list_invites", h.ListInvites, http.MethodGet, "/api/pair-sessions/sess1/invites", "", map[string]string{"id": "sess1"}},
		{"revoke_invite", h.RevokeInvite, http.MethodDelete, "/api/pair-sessions/sess1/invites?email=a@example.com", "", map[string]string{"id": "sess1"}},
		{"mint_link", h.MintLink, http.MethodPost, "/api/pair-sessions/sess1/links", `{"role":"viewer"}`, map[string]string{"id": "sess1"}},
		{"list_links", h.ListLinks, http.MethodGet, "/api/pair-sessions/sess1/links", "", map[string]string{"id": "sess1"}},
		{"revoke_link", h.RevokeLink, http.MethodDelete, "/api/pair-sessions/sess1/links/11111111-1111-1111-1111-111111111111", "", map[string]string{"id": "sess1", "linkId": "11111111-1111-1111-1111-111111111111"}},
		{"list_queue", h.ListQueue, http.MethodGet, "/api/pair-sessions/sess1/queue", "", map[string]string{"id": "sess1"}},
		{"enqueue", h.Enqueue, http.MethodPost, "/api/pair-sessions/sess1/queue", `{"source":"user","body":"x"}`, map[string]string{"id": "sess1"}},
		{"claim", h.Claim, http.MethodPost, "/api/pair-sessions/sess1/queue/33333333-3333-3333-3333-333333333333/claim", `{"clientId":"c1"}`, map[string]string{"id": "sess1", "promptId": "33333333-3333-3333-3333-333333333333"}},
		{"start", h.Start, http.MethodPost, "/api/pair-sessions/sess1/queue/33333333-3333-3333-3333-333333333333/start", `{"clientId":"c1","runId":"r1"}`, map[string]string{"id": "sess1", "promptId": "33333333-3333-3333-3333-333333333333"}},
		{"renew", h.Renew, http.MethodPost, "/api/pair-sessions/sess1/queue/33333333-3333-3333-3333-333333333333/renew", `{"clientId":"c1"}`, map[string]string{"id": "sess1", "promptId": "33333333-3333-3333-3333-333333333333"}},
		{"finish", h.Finish, http.MethodPost, "/api/pair-sessions/sess1/queue/33333333-3333-3333-3333-333333333333/finish", `{"clientId":"c1","status":"completed"}`, map[string]string{"id": "sess1", "promptId": "33333333-3333-3333-3333-333333333333"}},
		{"cancel", h.Cancel, http.MethodPost, "/api/pair-sessions/sess1/queue/33333333-3333-3333-3333-333333333333/cancel", "", map[string]string{"id": "sess1", "promptId": "33333333-3333-3333-3333-333333333333"}},
		{"get_draft", h.GetDraft, http.MethodGet, "/api/pair-sessions/sess1/draft", "", map[string]string{"id": "sess1"}},
		{"put_draft", h.PutDraft, http.MethodPut, "/api/pair-sessions/sess1/draft", `{"content":"x","version":1}`, map[string]string{"id": "sess1"}},
		{"submit_draft", h.SubmitDraft, http.MethodPost, "/api/pair-sessions/sess1/draft/submit", "", map[string]string{"id": "sess1"}},
		{"presence", h.Presence, http.MethodPost, "/api/pair-sessions/sess1/presence", `{"presence":{"cursor":1}}`, map[string]string{"id": "sess1"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.handler(rec, pairSessionsCovDirectRequest(tc.method, tc.target, tc.body, tc.params))

			require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "authentication required")
		})
	}
}

func TestPairSessions_Cov_SuccessRoutesForwardArgumentsAndJSON(t *testing.T) {
	const validSource = "11111111-1111-1111-1111-111111111111"
	cases := []struct {
		name       string
		call       string
		method     string
		target     string
		body       string
		wantStatus int
		assertFn   func(*testing.T, *pairSessionsCovService, *httptest.ResponseRecorder)
	}{
		{
			name:       "create",
			call:       "CreateSession",
			method:     http.MethodPost,
			target:     "/api/pair-sessions",
			body:       `{"repositoryId":88,"sourceWorkspaceId":"` + validSource + `"}`,
			wantStatus: http.StatusCreated,
			assertFn: func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
				assert.Equal(t, int64(42), svc.lastActor)
				assert.Equal(t, int64(88), svc.lastRepositoryID)
				assert.Equal(t, validSource, svc.lastSourceWorkspaceID)
				assert.Contains(t, rec.Body.String(), `"sessionId":"sess-new"`)
			},
		},
		{
			name:       "lookup_empty_source",
			call:       "PreviewForSource",
			method:     http.MethodGet,
			target:     "/api/pair-sessions",
			wantStatus: http.StatusOK,
			assertFn: func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
				assert.Equal(t, "", svc.lastSourceWorkspaceID)
				assert.Contains(t, rec.Body.String(), `"role":"editor"`)
				assert.Contains(t, rec.Body.String(), `"userId":42`)
			},
		},
		{
			name:       "lookup_valid_source",
			call:       "PreviewForSource",
			method:     http.MethodGet,
			target:     "/api/pair-sessions?sourceWorkspaceId=" + validSource,
			wantStatus: http.StatusOK,
			assertFn: func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
				assert.Equal(t, validSource, svc.lastSourceWorkspaceID)
			},
		},
		{"resolve", "PreviewSession", http.MethodGet, "/api/pair-sessions/sess1", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "sess1", svc.lastSessionID)
			assert.Contains(t, rec.Body.String(), `"materialized":false`)
		}},
		{"resolve_by_link", "PreviewByLink", http.MethodGet, "/api/pair-sessions/by-link/share-slug", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
			assert.Equal(t, "share-slug", svc.lastSlug)
		}},
		{"end", "EndSession", http.MethodPost, "/api/pair-sessions/sess1/end", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "sess1", svc.lastSessionID)
			assert.JSONEq(t, `{"ended":true}`, rec.Body.String())
		}},
		{"list_members", "ListMemberProfiles", http.MethodGet, "/api/pair-sessions/sess1/members", "", http.StatusOK, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"username":"octocat"`)
		}},
		{"set_member_role", "SetMemberRole", http.MethodPatch, "/api/pair-sessions/sess1/members/77", `{"role":"viewer"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, int64(77), svc.lastTargetUserID)
			assert.Equal(t, services.PairRoleViewer, svc.lastRole)
			assert.Contains(t, rec.Body.String(), `"role":"viewer"`)
		}},
		{"revoke_member", "RevokeMember", http.MethodDelete, "/api/pair-sessions/sess1/members/77", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, int64(77), svc.lastTargetUserID)
			assert.JSONEq(t, `{"revoked":true}`, rec.Body.String())
		}},
		{"set_access", "SetAccessMode", http.MethodPatch, "/api/pair-sessions/sess1/access", `{"mode":"link"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "link", svc.lastMode)
			assert.Contains(t, rec.Body.String(), `"access_mode":"link"`)
		}},
		{"create_invite_email", "CreateInvite", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"email":"friend@example.com","role":"editor"}`, http.StatusCreated, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "friend@example.com", svc.lastEmail)
			assert.Contains(t, rec.Body.String(), `"token":"raw-token"`)
			assert.NotContains(t, rec.Body.String(), "token_hash")
		}},
		{"create_invite_username", "CreateInviteByUsername", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"username":"OctoCat","role":"viewer"}`, http.StatusCreated, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "OctoCat", svc.lastUsername)
			assert.Contains(t, rec.Body.String(), `"lower_github_username":"octocat"`)
			assert.NotContains(t, rec.Body.String(), "lower_email")
		}},
		{"list_invites", "ListInvites", http.MethodGet, "/api/pair-sessions/sess1/invites", "", http.StatusOK, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"lower_email":"friend@example.com"`)
			assert.Contains(t, rec.Body.String(), `"lower_github_username":"octocat"`)
			assert.NotContains(t, rec.Body.String(), "token_hash")
			assert.NotContains(t, rec.Body.String(), "private@example.com")
		}},
		{"revoke_invite_email_query", "RevokeInvite", http.MethodDelete, "/api/pair-sessions/sess1/invites?email=%20friend@example.com%20", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "friend@example.com", svc.lastEmail)
			assert.JSONEq(t, `{"revoked":true}`, rec.Body.String())
		}},
		{"revoke_invite_username_body", "RevokeInviteByUsername", http.MethodDelete, "/api/pair-sessions/sess1/invites", `{"username":" octocat "}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
			assert.Equal(t, "octocat", svc.lastUsername)
		}},
		{"mint_link", "MintLink", http.MethodPost, "/api/pair-sessions/sess1/links", `{"role":"editor"}`, http.StatusCreated, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, services.PairRoleEditor, svc.lastRole)
			assert.Contains(t, rec.Body.String(), `"slug":"slug-one"`)
		}},
		{"list_links", "ListLinks", http.MethodGet, "/api/pair-sessions/sess1/links", "", http.StatusOK, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"links":[`)
			assert.Contains(t, rec.Body.String(), `"slug":"slug-one"`)
		}},
		{"revoke_link", "RevokeLink", http.MethodDelete, "/api/pair-sessions/sess1/links/11111111-1111-1111-1111-111111111111", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "11111111-1111-1111-1111-111111111111", svc.lastLinkID)
			assert.JSONEq(t, `{"revoked":true}`, rec.Body.String())
		}},
		{"list_queue", "ListQueue", http.MethodGet, "/api/pair-sessions/sess1/queue", "", http.StatusOK, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"queue":[`)
			assert.Contains(t, rec.Body.String(), `"id":"prompt1"`)
		}},
		{"enqueue", "Enqueue", http.MethodPost, "/api/pair-sessions/sess1/queue", `{"source":"solo","body":"ship it"}`, http.StatusCreated, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "solo", svc.lastSource)
			assert.Equal(t, "ship it", svc.lastBody)
			assert.Contains(t, rec.Body.String(), `"body":"ship it"`)
		}},
		{"claim", "Claim", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/claim", `{"clientId":"client-a"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
			assert.Equal(t, "22222222-2222-2222-2222-222222222222", svc.lastPromptID)
			assert.Equal(t, "client-a", svc.lastClientID)
			assert.Equal(t, pairSessionClaimLease, svc.lastLease)
		}},
		{"start", "Start", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/start", `{"clientId":"client-a","runId":"run-1"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
			assert.Equal(t, "run-1", svc.lastRunID)
		}},
		{"renew", "Renew", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/renew", `{"clientId":"client-a"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, _ *httptest.ResponseRecorder) {
			assert.Equal(t, pairSessionClaimLease, svc.lastLease)
		}},
		{"finish", "Finish", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/finish", `{"clientId":"client-a","status":"completed"}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "completed", svc.lastStatus)
			assert.Contains(t, rec.Body.String(), `"status":"completed"`)
		}},
		{"cancel", "Cancel", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/cancel", "", http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "22222222-2222-2222-2222-222222222222", svc.lastPromptID)
			assert.Contains(t, rec.Body.String(), `"status":"cancelled"`)
		}},
		{"get_draft", "GetDraft", http.MethodGet, "/api/pair-sessions/sess1/draft", "", http.StatusOK, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"content":"draft body"`)
		}},
		{"put_draft", "PutDraft", http.MethodPut, "/api/pair-sessions/sess1/draft", `{"content":"new draft","version":4}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Equal(t, "new draft", svc.lastContent)
			assert.Equal(t, int64(4), svc.lastVersion)
			assert.Contains(t, rec.Body.String(), `"version":4`)
		}},
		{"submit_draft", "SubmitDraft", http.MethodPost, "/api/pair-sessions/sess1/draft/submit", "", http.StatusCreated, func(t *testing.T, _ *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.Contains(t, rec.Body.String(), `"id":"prompt1"`)
		}},
		{"presence", "Heartbeat", http.MethodPost, "/api/pair-sessions/sess1/presence", `{"presence":{"cursor":3}}`, http.StatusOK, func(t *testing.T, svc *pairSessionsCovService, rec *httptest.ResponseRecorder) {
			assert.JSONEq(t, `{"cursor":3}`, string(svc.lastPresence))
			assert.JSONEq(t, `{"ok":true}`, rec.Body.String())
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, tc.body), 42)

			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())
			assert.True(t, svc.called(tc.call), "expected service call %s, got %v", tc.call, svc.calls)
			tc.assertFn(t, svc, rec)
		})
	}
}

func TestPairSessions_Cov_ServiceErrorsMapToAPIResponses(t *testing.T) {
	cases := []struct {
		name   string
		call   string
		method string
		target string
		body   string
	}{
		{"create", "CreateSession", http.MethodPost, "/api/pair-sessions", `{"repositoryId":88,"sourceWorkspaceId":"11111111-1111-1111-1111-111111111111"}`},
		{"lookup", "PreviewForSource", http.MethodGet, "/api/pair-sessions?sourceWorkspaceId=11111111-1111-1111-1111-111111111111", ""},
		{"resolve", "PreviewSession", http.MethodGet, "/api/pair-sessions/sess1", ""},
		{"resolve_by_link", "PreviewByLink", http.MethodGet, "/api/pair-sessions/by-link/share-slug", ""},
		{"end", "EndSession", http.MethodPost, "/api/pair-sessions/sess1/end", ""},
		{"list_members", "ListMemberProfiles", http.MethodGet, "/api/pair-sessions/sess1/members", ""},
		{"set_member_role", "SetMemberRole", http.MethodPatch, "/api/pair-sessions/sess1/members/77", `{"role":"viewer"}`},
		{"revoke_member", "RevokeMember", http.MethodDelete, "/api/pair-sessions/sess1/members/77", ""},
		{"set_access", "SetAccessMode", http.MethodPatch, "/api/pair-sessions/sess1/access", `{"mode":"link"}`},
		{"create_invite_email", "CreateInvite", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"email":"friend@example.com","role":"editor"}`},
		{"create_invite_username", "CreateInviteByUsername", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"username":"octocat","role":"viewer"}`},
		{"list_invites", "ListInvites", http.MethodGet, "/api/pair-sessions/sess1/invites", ""},
		{"revoke_invite_email", "RevokeInvite", http.MethodDelete, "/api/pair-sessions/sess1/invites?email=friend@example.com", ""},
		{"revoke_invite_username", "RevokeInviteByUsername", http.MethodDelete, "/api/pair-sessions/sess1/invites", `{"username":"octocat"}`},
		{"mint_link", "MintLink", http.MethodPost, "/api/pair-sessions/sess1/links", `{"role":"viewer"}`},
		{"list_links", "ListLinks", http.MethodGet, "/api/pair-sessions/sess1/links", ""},
		{"revoke_link", "RevokeLink", http.MethodDelete, "/api/pair-sessions/sess1/links/11111111-1111-1111-1111-111111111111", ""},
		{"list_queue", "ListQueue", http.MethodGet, "/api/pair-sessions/sess1/queue", ""},
		{"enqueue", "Enqueue", http.MethodPost, "/api/pair-sessions/sess1/queue", `{"source":"solo","body":"ship it"}`},
		{"claim", "Claim", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/claim", `{"clientId":"client-a"}`},
		{"start", "Start", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/start", `{"clientId":"client-a","runId":"run-1"}`},
		{"renew", "Renew", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/renew", `{"clientId":"client-a"}`},
		{"finish", "Finish", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/finish", `{"clientId":"client-a","status":"completed"}`},
		{"cancel", "Cancel", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/cancel", ""},
		{"get_draft", "GetDraft", http.MethodGet, "/api/pair-sessions/sess1/draft", ""},
		{"put_draft", "PutDraft", http.MethodPut, "/api/pair-sessions/sess1/draft", `{"content":"new draft","version":4}`},
		{"submit_draft", "SubmitDraft", http.MethodPost, "/api/pair-sessions/sess1/draft/submit", ""},
		{"presence", "Heartbeat", http.MethodPost, "/api/pair-sessions/sess1/presence", `{"presence":{"cursor":3}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			svc.errByCall = map[string]error{tc.call: pkgerrors.Forbidden("blocked by role")}
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, tc.body), 42)

			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			assert.True(t, svc.called(tc.call), "expected service call %s, got %v", tc.call, svc.calls)
			assert.Contains(t, rec.Body.String(), "blocked by role")
		})
	}
}

func TestPairSessions_Cov_GenericServiceErrorIsInternal(t *testing.T) {
	svc := pairSessionsCovNewService()
	svc.errByCall = map[string]error{"EndSession": errors.New("database detail that must not leak")}
	h := NewPairSessionHandler(svc)

	rec := pairSessionsCovServe(h, pairSessionsCovRequest(http.MethodPost, "/api/pair-sessions/sess1/end", ""), 42)

	require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "pair session error")
	assert.NotContains(t, rec.Body.String(), "database detail")
}

func TestPairSessions_Cov_BadInputBranches(t *testing.T) {
	t.Run("malformed source workspace id is rejected before service call", func(t *testing.T) {
		svc := pairSessionsCovNewService()
		h := NewPairSessionHandler(svc)

		rec := pairSessionsCovServe(h, pairSessionsCovRequest(http.MethodGet, "/api/pair-sessions?sourceWorkspaceId=not-a-uuid", ""), 42)

		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "invalid sourceWorkspaceId")
		assert.Empty(t, svc.calls)
	})

	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"create", http.MethodPost, "/api/pair-sessions", `{`},
		{"set_member_role", http.MethodPatch, "/api/pair-sessions/sess1/members/77", `{`},
		{"set_access", http.MethodPatch, "/api/pair-sessions/sess1/access", `{`},
		{"create_invite", http.MethodPost, "/api/pair-sessions/sess1/invites", `{`},
		{"revoke_invite_body", http.MethodDelete, "/api/pair-sessions/sess1/invites", `{`},
		{"mint_link", http.MethodPost, "/api/pair-sessions/sess1/links", `{`},
		{"enqueue", http.MethodPost, "/api/pair-sessions/sess1/queue", `{`},
		{"claim", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/claim", `{`},
		{"start", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/start", `{`},
		{"renew", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/renew", `{`},
		{"finish", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/finish", `{`},
		{"put_draft", http.MethodPut, "/api/pair-sessions/sess1/draft", `{`},
		{"presence", http.MethodPost, "/api/pair-sessions/sess1/presence", `{`},
	} {
		t.Run("invalid_json_"+tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, tc.body), 42)

			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "invalid body")
			assert.Empty(t, svc.calls)
		})
	}

	for _, tc := range []struct {
		name   string
		method string
		target string
	}{
		{"set_member_role_alpha", http.MethodPatch, "/api/pair-sessions/sess1/members/abc"},
		{"revoke_member_zero", http.MethodDelete, "/api/pair-sessions/sess1/members/0"},
	} {
		t.Run("invalid_user_id_"+tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, `{"role":"viewer"}`), 42)

			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "invalid user id")
			assert.Empty(t, svc.calls)
		})
	}

	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"claim", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/claim", `{"clientId":" "}`},
		{"renew", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/renew", `{"clientId":""}`},
		{"finish", http.MethodPost, "/api/pair-sessions/sess1/queue/22222222-2222-2222-2222-222222222222/finish", `{"clientId":" ","status":"done"}`},
	} {
		t.Run("missing_client_id_"+tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, tc.body), 42)

			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "clientId is required")
			assert.Empty(t, svc.calls)
		})
	}

	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"create_invite_neither", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"role":"viewer"}`},
		{"create_invite_both", http.MethodPost, "/api/pair-sessions/sess1/invites", `{"email":"a@example.com","username":"octocat","role":"viewer"}`},
		{"revoke_invite_neither", http.MethodDelete, "/api/pair-sessions/sess1/invites", `{}`},
		{"revoke_invite_both", http.MethodDelete, "/api/pair-sessions/sess1/invites", `{"email":"a@example.com","username":"octocat"}`},
	} {
		t.Run("invite_key_validation_"+tc.name, func(t *testing.T) {
			svc := pairSessionsCovNewService()
			h := NewPairSessionHandler(svc)
			rec := pairSessionsCovServe(h, pairSessionsCovRequest(tc.method, tc.target, tc.body), 42)

			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "provide exactly one of email or username")
			assert.Empty(t, svc.calls)
		})
	}
}
