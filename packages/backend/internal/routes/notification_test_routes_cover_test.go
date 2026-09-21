package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type notificationTestRoutesCovService struct {
	err error
	arg db.CreateNotificationParams
}

func (s *notificationTestRoutesCovService) Create(ctx context.Context, arg db.CreateNotificationParams) (services.NotificationResponse, error) {
	s.arg = arg
	if s.err != nil {
		return services.NotificationResponse{}, s.err
	}
	return services.NotificationResponse{
		ID:         10,
		SourceType: arg.SourceType,
		SourceID:   arg.SourceID.Int64,
		Subject:    arg.Subject,
		Body:       arg.Body,
		Status:     "unread",
		CreatedAt:  time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC),
		UpdatedAt:  time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC),
	}, nil
}

func TestNotificationTestRoutes_Cov_CreateTestNotificationBranches(t *testing.T) {
	t.Parallel()

	t.Run("requires source type", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := withAuth(httptest.NewRequest(http.MethodPost, "/test/notifications", strings.NewReader(`{"source_type":" "}`)), 7, "alice")

		CreateTestNotification(&notificationTestRoutesCovService{})(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "source_type is required")
	})

	t.Run("success includes optional source id", func(t *testing.T) {
		svc := &notificationTestRoutesCovService{}
		rec := httptest.NewRecorder()
		req := withAuth(httptest.NewRequest(http.MethodPost, "/test/notifications", strings.NewReader(`{"source_type":"issue","source_id":33,"subject":"hello","body":"world"}`)), 7, "alice")

		CreateTestNotification(svc)(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Equal(t, int64(7), svc.arg.UserID)
		assert.Equal(t, "issue", svc.arg.SourceType)
		assert.Equal(t, pgtype.Int8{Int64: 33, Valid: true}, svc.arg.SourceID)
		assert.Equal(t, "hello", svc.arg.Subject)
		assert.Contains(t, rec.Body.String(), `"subject":"hello"`)
	})

	t.Run("service api error propagates", func(t *testing.T) {
		svc := &notificationTestRoutesCovService{err: pkgerrors.Forbidden("notification denied")}
		rec := httptest.NewRecorder()
		req := withAuth(httptest.NewRequest(http.MethodPost, "/test/notifications", strings.NewReader(`{"source_type":"issue"}`)), 7, "alice")

		CreateTestNotification(svc)(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Contains(t, rec.Body.String(), "notification denied")
	})
}
