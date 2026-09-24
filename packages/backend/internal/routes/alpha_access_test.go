package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type capturingAlphaAuditQuerier struct{ rows []db.InsertAuditLogParams }

func (q *capturingAlphaAuditQuerier) InsertAuditLog(_ context.Context, row db.InsertAuditLogParams) error {
	q.rows = append(q.rows, row)
	return nil
}

func alphaAuditHandler(service AlphaAccessRouteService, audit *capturingAlphaAuditQuerier) AlphaAccessHandler {
	return AlphaAccessHandler{Service: service, AuditService: services.NewAuditService(audit)}
}

type mockAlphaAccessRouteService struct {
	joinWaitlistFn    func(ctx context.Context, input services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error)
	listWhitelistFn   func(ctx context.Context) ([]services.AlphaWhitelistEntry, error)
	addWhitelistFn    func(ctx context.Context, actor *db.User, input services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error)
	removeWhitelistFn func(ctx context.Context, input services.RemoveWhitelistEntryInput) error
	listWaitlistFn    func(ctx context.Context, input services.ListWaitlistInput) (services.AlphaWaitlistListResult, error)
	approveWaitlistFn func(ctx context.Context, actor *db.User, email string) (services.AlphaWaitlistEntry, error)
}

func (m mockAlphaAccessRouteService) JoinWaitlist(ctx context.Context, input services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error) {
	return m.joinWaitlistFn(ctx, input)
}

func (m mockAlphaAccessRouteService) ListWhitelistEntries(ctx context.Context) ([]services.AlphaWhitelistEntry, error) {
	return m.listWhitelistFn(ctx)
}

func (m mockAlphaAccessRouteService) AddWhitelistEntry(ctx context.Context, actor *db.User, input services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
	return m.addWhitelistFn(ctx, actor, input)
}

func (m mockAlphaAccessRouteService) RemoveWhitelistEntry(ctx context.Context, input services.RemoveWhitelistEntryInput) error {
	return m.removeWhitelistFn(ctx, input)
}

func (m mockAlphaAccessRouteService) ListWaitlistEntries(ctx context.Context, input services.ListWaitlistInput) (services.AlphaWaitlistListResult, error) {
	return m.listWaitlistFn(ctx, input)
}

func (m mockAlphaAccessRouteService) ApproveWaitlistEntry(ctx context.Context, actor *db.User, email string) (services.AlphaWaitlistEntry, error) {
	return m.approveWaitlistFn(ctx, actor, email)
}

func TestAlphaAccessHandler_PostWaitlistJoin(t *testing.T) {
	t.Parallel()

	audit := &capturingAlphaAuditQuerier{}
	handler := alphaAuditHandler(mockAlphaAccessRouteService{
		joinWaitlistFn: func(ctx context.Context, input services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error) {
			assert.Equal(t, "invitee@example.com", input.Email)
			assert.Equal(t, "cli", input.Source)
			return services.AlphaWaitlistEntry{
				ID:        77,
				Email:     input.Email,
				Status:    services.WaitlistStatusPending,
				Source:    input.Source,
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
			}, nil
		},
	}, audit)

	req := httptest.NewRequest(http.MethodPost, "/api/alpha/waitlist", strings.NewReader(`{"email":"invitee@example.com","source":"cli"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.PostWaitlistJoin(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var body services.AlphaWaitlistEntry
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, int64(77), body.ID)
	assert.Equal(t, "invitee@example.com", body.Email)
}

func TestAlphaAccessHandler_PostAdminWhitelist_RequiresAuth(t *testing.T) {
	t.Parallel()

	handler := AlphaAccessHandler{
		Service: mockAlphaAccessRouteService{
			addWhitelistFn: func(ctx context.Context, actor *db.User, input services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
				t.Fatal("service should not be called without auth")
				return services.AlphaWhitelistEntry{}, nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/whitelist", strings.NewReader(`{"identity_type":"email","identity_value":"a@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.PostAdminWhitelist(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAlphaAccessHandler_PostAdminWhitelist(t *testing.T) {
	t.Parallel()

	audit := &capturingAlphaAuditQuerier{}
	handler := alphaAuditHandler(mockAlphaAccessRouteService{
		addWhitelistFn: func(ctx context.Context, actor *db.User, input services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
			require.NotNil(t, actor)
			assert.Equal(t, int64(1), actor.ID)
			assert.Equal(t, services.WhitelistIdentityEmail, input.IdentityType)
			return services.AlphaWhitelistEntry{
				ID:            8,
				IdentityType:  input.IdentityType,
				IdentityValue: "a@example.com",
				CreatedAt:     time.Now().UTC(),
				UpdatedAt:     time.Now().UTC(),
			}, nil
		},
	}, audit)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/whitelist", strings.NewReader(`{"identity_type":"email","identity_value":"a@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "alice", IsAdmin: true},
	}))
	rec := httptest.NewRecorder()
	handler.PostAdminWhitelist(rec, req)

	assert.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, audit.rows, 1)
	row := audit.rows[0]
	assert.Equal(t, "admin.alpha.whitelist.add", row.EventType)
	assert.True(t, row.ActorID.Valid)
	assert.Equal(t, int64(1), row.ActorID.Int64)
	assert.Equal(t, "alice", row.ActorName)
	assert.Equal(t, "alpha_whitelist", row.TargetType)
	assert.True(t, row.TargetID.Valid)
	assert.Equal(t, int64(8), row.TargetID.Int64)
	assert.Equal(t, "a@example.com", row.TargetName)
	assert.Equal(t, "add", row.Action)
	assert.JSONEq(t, `{"identity_type":"email","identity_value":"a@example.com"}`, string(row.Metadata))
	assert.NotEmpty(t, row.IpAddress)
}

func TestAlphaAccessHandler_DeleteAdminWhitelist(t *testing.T) {
	t.Parallel()

	audit := &capturingAlphaAuditQuerier{}
	handler := alphaAuditHandler(mockAlphaAccessRouteService{
		removeWhitelistFn: func(ctx context.Context, input services.RemoveWhitelistEntryInput) error {
			assert.Equal(t, services.WhitelistIdentityEmail, input.IdentityType)
			assert.Equal(t, "a@example.com", input.IdentityValue)
			return nil
		},
	}, audit)

	req := httptest.NewRequest(http.MethodDelete, "/api/admin/alpha/whitelist/email/a%40example.com", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("identity_type", "email")
	routeCtx.URLParams.Add("identity_value", "A%40EXAMPLE.COM")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 3, Username: "admin", IsAdmin: true}}))
	rec := httptest.NewRecorder()
	handler.DeleteAdminWhitelist(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	require.Len(t, audit.rows, 1)
	row := audit.rows[0]
	assert.Equal(t, "admin.alpha.whitelist.remove", row.EventType)
	assert.True(t, row.ActorID.Valid)
	assert.Equal(t, int64(3), row.ActorID.Int64)
	assert.Equal(t, "admin", row.ActorName)
	assert.Equal(t, "alpha_whitelist", row.TargetType)
	assert.False(t, row.TargetID.Valid)
	assert.Equal(t, "a@example.com", row.TargetName)
	assert.Equal(t, "remove", row.Action)
	assert.JSONEq(t, `{"identity_type":"email","identity_value":"a@example.com"}`, string(row.Metadata))
	assert.NotEmpty(t, row.IpAddress)
}

func TestAlphaAccessHandler_PostAdminWaitlistApprove(t *testing.T) {
	t.Parallel()

	audit := &capturingAlphaAuditQuerier{}
	handler := alphaAuditHandler(mockAlphaAccessRouteService{
		approveWaitlistFn: func(ctx context.Context, actor *db.User, email string) (services.AlphaWaitlistEntry, error) {
			require.NotNil(t, actor)
			assert.Equal(t, int64(2), actor.ID)
			assert.Equal(t, "invitee@example.com", email)
			return services.AlphaWaitlistEntry{
				ID:        23,
				Email:     email,
				Status:    services.WaitlistStatusApproved,
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
			}, nil
		},
	}, audit)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/waitlist/approve", strings.NewReader(`{"email":"invitee@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 2, Username: "admin", IsAdmin: true},
	}))
	rec := httptest.NewRecorder()
	handler.PostAdminWaitlistApprove(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body services.AlphaWaitlistEntry
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, services.WaitlistStatusApproved, body.Status)
	require.Len(t, audit.rows, 1)
	row := audit.rows[0]
	assert.Equal(t, "admin.alpha.waitlist.approve", row.EventType)
	assert.True(t, row.ActorID.Valid)
	assert.Equal(t, int64(2), row.ActorID.Int64)
	assert.Equal(t, "admin", row.ActorName)
	assert.Equal(t, "alpha_waitlist", row.TargetType)
	assert.True(t, row.TargetID.Valid)
	assert.Equal(t, int64(23), row.TargetID.Int64)
	assert.Equal(t, "invitee@example.com", row.TargetName)
	assert.Equal(t, "approve", row.Action)
	assert.JSONEq(t, `{"email":"invitee@example.com","status":"approved"}`, string(row.Metadata))
	assert.NotEmpty(t, row.IpAddress)
}

func TestAlphaAccessHandler_DeleteAdminWhitelist_RequiresAuth(t *testing.T) {
	handler := AlphaAccessHandler{Service: mockAlphaAccessRouteService{removeWhitelistFn: func(context.Context, services.RemoveWhitelistEntryInput) error {
		t.Fatal("service should not be called without auth")
		return nil
	}}}
	req := withRouteParams(httptest.NewRequest(http.MethodDelete, "/api/admin/alpha/whitelist/email/a", nil), map[string]string{"identity_type": "email", "identity_value": "a@example.com"})
	rec := httptest.NewRecorder()
	handler.DeleteAdminWhitelist(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAlphaAccessHandler_DoesNotAuditFailedAdminWrites(t *testing.T) {
	audit := &capturingAlphaAuditQuerier{}
	handler := alphaAuditHandler(mockAlphaAccessRouteService{
		addWhitelistFn: func(context.Context, *db.User, services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error) {
			return services.AlphaWhitelistEntry{}, pkgerrors.BadRequest("invalid identity")
		},
	}, audit)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/whitelist", strings.NewReader(`{"identity_type":"email","identity_value":"bad"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 1, Username: "admin", IsAdmin: true}}))
	rec := httptest.NewRecorder()
	handler.PostAdminWhitelist(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, audit.rows)

	removeAudit := &capturingAlphaAuditQuerier{}
	removeHandler := alphaAuditHandler(mockAlphaAccessRouteService{
		removeWhitelistFn: func(context.Context, services.RemoveWhitelistEntryInput) error {
			return pkgerrors.NotFound("missing identity")
		},
	}, removeAudit)
	removeReq := withRouteParams(httptest.NewRequest(http.MethodDelete, "/api/admin/alpha/whitelist/email/a@example.com", nil), map[string]string{
		"identity_type": "email", "identity_value": "a@example.com",
	})
	removeReq = removeReq.WithContext(middleware.ContextWithAuthInfo(removeReq.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
	}))
	removeRec := httptest.NewRecorder()
	removeHandler.DeleteAdminWhitelist(removeRec, removeReq)
	assert.Equal(t, http.StatusNotFound, removeRec.Code)
	assert.Empty(t, removeAudit.rows)

	approveAudit := &capturingAlphaAuditQuerier{}
	approveHandler := alphaAuditHandler(mockAlphaAccessRouteService{
		approveWaitlistFn: func(context.Context, *db.User, string) (services.AlphaWaitlistEntry, error) {
			return services.AlphaWaitlistEntry{}, pkgerrors.NotFound("missing waitlist entry")
		},
	}, approveAudit)
	approveReq := httptest.NewRequest(http.MethodPost, "/api/admin/alpha/waitlist/approve", strings.NewReader(`{"email":"missing@example.com"}`))
	approveReq.Header.Set("Content-Type", "application/json")
	approveReq = approveReq.WithContext(middleware.ContextWithAuthInfo(approveReq.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "admin", IsAdmin: true},
	}))
	approveRec := httptest.NewRecorder()
	approveHandler.PostAdminWaitlistApprove(approveRec, approveReq)
	assert.Equal(t, http.StatusNotFound, approveRec.Code)
	assert.Empty(t, approveAudit.rows)
}
