package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// NotificationCreateService is the minimal interface needed by CreateTestNotification.
type NotificationCreateService interface {
	Create(ctx context.Context, arg db.CreateNotificationParams) (services.NotificationResponse, error)
}

type createTestNotificationRequest struct {
	SourceType string `json:"source_type"`
	SourceID   *int64 `json:"source_id"`
	Subject    string `json:"subject"`
	Body       string `json:"body"`
}

// CreateTestNotification is a test-only route for E2E: it triggers NotificationService.Create.
// This endpoint should only be registered when SMITHERS_ENABLE_E2E_TEST_ROUTES=true.
func CreateTestNotification(svc NotificationCreateService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := requireRouteUser(r)
		if err != nil {
			pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
			return
		}

		var req createTestNotificationRequest
		if !decodeJSONBody(w, r, &req) {
			return
		}

		sourceType := strings.TrimSpace(req.SourceType)
		if sourceType == "" {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("source_type is required"))
			return
		}

		createArg := db.CreateNotificationParams{
			UserID:     user.ID,
			SourceType: sourceType,
			Subject:    req.Subject,
			Body:       req.Body,
		}
		if req.SourceID != nil {
			createArg.SourceID = pgtype.Int8{Int64: *req.SourceID, Valid: true}
		}

		created, createErr := svc.Create(r.Context(), createArg)
		if createErr != nil {
			writeRouteError(w, r, createErr)
			return
		}

		pkgerrors.WriteJSON(w, http.StatusCreated, created)
	}
}
