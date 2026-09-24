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
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockUserEmailService struct {
	listEmailsFn          func(ctx context.Context, userID int64) ([]services.EmailResponse, error)
	addEmailFn            func(ctx context.Context, userID int64, req services.AddEmailRequest) (services.EmailResponse, error)
	deleteEmailFn         func(ctx context.Context, userID, emailID int64) error
	requestVerificationFn func(ctx context.Context, userID, emailID int64) error
	verifyEmailFn         func(ctx context.Context, rawToken string) (services.VerifyEmailResult, error)
}

func (m mockUserEmailService) ListEmails(ctx context.Context, userID int64) ([]services.EmailResponse, error) {
	if m.listEmailsFn != nil {
		return m.listEmailsFn(ctx, userID)
	}
	return nil, nil
}

func (m mockUserEmailService) AddEmail(ctx context.Context, userID int64, req services.AddEmailRequest) (services.EmailResponse, error) {
	if m.addEmailFn != nil {
		return m.addEmailFn(ctx, userID, req)
	}
	return services.EmailResponse{}, nil
}

func (m mockUserEmailService) DeleteEmail(ctx context.Context, userID, emailID int64) error {
	if m.deleteEmailFn != nil {
		return m.deleteEmailFn(ctx, userID, emailID)
	}
	return nil
}

func (m mockUserEmailService) RequestVerification(ctx context.Context, userID, emailID int64) error {
	if m.requestVerificationFn != nil {
		return m.requestVerificationFn(ctx, userID, emailID)
	}
	return nil
}

func (m mockUserEmailService) VerifyEmail(ctx context.Context, rawToken string) (services.VerifyEmailResult, error) {
	if m.verifyEmailFn != nil {
		return m.verifyEmailFn(ctx, rawToken)
	}
	return services.VerifyEmailResult{}, nil
}

func emailAuthCtx(ctx context.Context, userID int64) context.Context {
	return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: "testuser", LowerUsername: "testuser"},
	})
}

func newEmailTestHandler(emailSvc mockUserEmailService) *UserHandler {
	return &UserHandler{
		EmailService: emailSvc,
	}
}

func TestUserHandler_GetUserEmails_Unauthorized(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	req := httptest.NewRequest(http.MethodGet, "/api/user/emails", nil)
	rec := httptest.NewRecorder()
	handler.GetUserEmails(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_GetUserEmails_Success(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	handler := newEmailTestHandler(mockUserEmailService{
		listEmailsFn: func(_ context.Context, userID int64) ([]services.EmailResponse, error) {
			assert.Equal(t, int64(42), userID)
			return []services.EmailResponse{
				{ID: 1, Email: "a@example.com", IsActivated: true, IsPrimary: true, CreatedAt: now},
				{ID: 2, Email: "b@example.com", IsActivated: false, IsPrimary: false, CreatedAt: now},
			}, nil
		},
	})
	req := httptest.NewRequest(http.MethodGet, "/api/user/emails", nil)
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rec := httptest.NewRecorder()
	handler.GetUserEmails(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	var emails []services.EmailResponse
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&emails))
	require.Len(t, emails, 2)
	assert.Equal(t, "a@example.com", emails[0].Email)
}

func TestUserHandler_PostUserEmail_Unauthorized(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	body := `{"email":"test@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handler.PostUserEmail(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_PostUserEmail_InvalidJSON(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails", strings.NewReader("{invalid"))
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rec := httptest.NewRecorder()
	handler.PostUserEmail(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestUserHandler_PostUserEmail_InvalidEmail(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{
		addEmailFn: func(_ context.Context, _ int64, _ services.AddEmailRequest) (services.EmailResponse, error) {
			return services.EmailResponse{}, errors.ValidationFailed(errors.FieldError{
				Resource: "Email", Field: "email", Code: "invalid",
			})
		},
	})
	body := `{"email":"notanemail"}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails", strings.NewReader(body))
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rec := httptest.NewRecorder()
	handler.PostUserEmail(rec, req)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestUserHandler_PostUserEmail_Success(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	handler := newEmailTestHandler(mockUserEmailService{
		addEmailFn: func(_ context.Context, userID int64, req services.AddEmailRequest) (services.EmailResponse, error) {
			assert.Equal(t, int64(42), userID)
			return services.EmailResponse{ID: 10, Email: req.Email, IsActivated: false, IsPrimary: false, CreatedAt: now}, nil
		},
	})
	body := `{"email":"new@example.com","is_primary":false}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails", strings.NewReader(body))
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rec := httptest.NewRecorder()
	handler.PostUserEmail(rec, req)
	assert.Equal(t, http.StatusCreated, rec.Code)
	var email services.EmailResponse
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&email))
	assert.Equal(t, "new@example.com", email.Email)
	assert.Equal(t, int64(10), email.ID)
}

func TestUserHandler_PostUserEmail_Duplicate(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{
		addEmailFn: func(_ context.Context, _ int64, _ services.AddEmailRequest) (services.EmailResponse, error) {
			return services.EmailResponse{}, errors.Conflict("email already exists")
		},
	})
	body := `{"email":"dup@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails", strings.NewReader(body))
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rec := httptest.NewRecorder()
	handler.PostUserEmail(rec, req)
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestUserHandler_DeleteUserEmail_InvalidID(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	tests := []struct {
		name string
		id   string
	}{
		{"letters", "abc"},
		{"zero", "0"},
		{"negative", "-1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodDelete, "/api/user/emails/"+tc.id, nil)
			req = req.WithContext(emailAuthCtx(req.Context(), 42))
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", tc.id)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			rec := httptest.NewRecorder()
			handler.DeleteUserEmail(rec, req)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestUserHandler_DeleteUserEmail_Unauthorized(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	req := httptest.NewRequest(http.MethodDelete, "/api/user/emails/1", nil)
	rec := httptest.NewRecorder()
	handler.DeleteUserEmail(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_DeleteUserEmail_NotFound(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{
		deleteEmailFn: func(_ context.Context, _, _ int64) error {
			return errors.NotFound("email not found")
		},
	})
	req := httptest.NewRequest(http.MethodDelete, "/api/user/emails/999", nil)
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "999")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	handler.DeleteUserEmail(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestUserHandler_DeleteUserEmail_Success(t *testing.T) {
	t.Parallel()
	deleteCalled := false
	handler := newEmailTestHandler(mockUserEmailService{
		deleteEmailFn: func(_ context.Context, userID, emailID int64) error {
			deleteCalled = true
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, int64(10), emailID)
			return nil
		},
	})
	req := httptest.NewRequest(http.MethodDelete, "/api/user/emails/10", nil)
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "10")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	handler.DeleteUserEmail(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, deleteCalled)
}

func TestUserHandler_PostUserEmailVerify_InvalidID(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	tests := []struct {
		name string
		id   string
	}{
		{"letters", "abc"},
		{"zero", "0"},
		{"negative", "-1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/user/emails/"+tc.id+"/verify", nil)
			req = req.WithContext(emailAuthCtx(req.Context(), 42))
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", tc.id)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			rec := httptest.NewRecorder()
			handler.PostUserEmailVerify(rec, req)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestUserHandler_PostUserEmailVerify_Unauthorized(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{})
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
	rec := httptest.NewRecorder()
	handler.PostUserEmailVerify(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestUserHandler_PostUserEmailVerify_NotFound(t *testing.T) {
	t.Parallel()
	handler := newEmailTestHandler(mockUserEmailService{
		requestVerificationFn: func(_ context.Context, _, _ int64) error {
			return errors.NotFound("email not found")
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails/999/verify", nil)
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "999")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	handler.PostUserEmailVerify(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestUserHandler_PostUserEmailVerify_Success(t *testing.T) {
	t.Parallel()
	verifyCalled := false
	handler := newEmailTestHandler(mockUserEmailService{
		requestVerificationFn: func(_ context.Context, userID, emailID int64) error {
			verifyCalled = true
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, int64(10), emailID)
			return nil
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails/10/verify", nil)
	req = req.WithContext(emailAuthCtx(req.Context(), 42))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "10")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	handler.PostUserEmailVerify(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, verifyCalled)
	assert.Empty(t, rec.Body.String(), "204 response should have no body")
}
