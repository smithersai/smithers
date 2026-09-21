package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

var serveChangeBrokerSSE = sse.ServeBrokerSSE

// GetChangeWalkthrough handles
// GET /api/repos/{owner}/{repo}/changes/{change_id}/walkthrough?rev=N.
func (h *JJVCSHandler) GetChangeWalkthrough(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	revisionSeq, apiErr := changeWalkthroughRevision(r)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	if h.WalkthroughService == nil {
		writeRouteError(w, r, pkgerrors.Internal("change walkthrough service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}

	walkthrough, svcErr := h.WalkthroughService.GetWalkthrough(r.Context(), repository.ID, changeID, revisionSeq)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, walkthrough)
}

// PutChangeWalkthrough handles the idempotent producer path used by smithers
// review to attach a structured story to a change revision.
func (h *JJVCSHandler) PutChangeWalkthrough(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	revisionSeq, apiErr := changeWalkthroughRevision(r)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	if h.WalkthroughService == nil {
		writeRouteError(w, r, pkgerrors.Internal("change walkthrough service not configured"))
		return
	}

	var input services.ChangeWalkthroughResponse
	if !decodeJSONBody(w, r, &input) {
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	walkthrough, svcErr := h.WalkthroughService.StoreWalkthrough(r.Context(), repository.ID, changeID, revisionSeq, input)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, walkthrough)
}

// ChangeStream handles GET /api/repos/{owner}/{repo}/changes/events. Events
// are repository-scoped and identify the stable change and immutable revision
// whose facets changed.
func (h *JJVCSHandler) ChangeStream(w http.ResponseWriter, r *http.Request) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	var userID int64
	if user := middleware.UserFromContext(r.Context()); user != nil {
		userID = user.ID
	}
	cfg := sse.BrokerStreamConfig{
		Broker:        h.Broker,
		Channel:       fmt.Sprintf("change_%d", repoCtx.Repository.ID),
		UserID:        userID,
		EventType:     "change",
		FormatEventID: extractChangeEventID,
	}
	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repoCtx.Repository.ID})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}
	serveChangeBrokerSSE(w, r, cfg)
}

func changeWalkthroughRevision(r *http.Request) (int64, *pkgerrors.APIError) {
	raw := strings.TrimSpace(r.URL.Query().Get("rev"))
	if raw == "" {
		return 0, nil
	}
	revisionSeq, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || revisionSeq <= 0 {
		return 0, pkgerrors.BadRequest("invalid revision")
	}
	return revisionSeq, nil
}

func extractChangeEventID(data string) string {
	var partial struct {
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal([]byte(data), &partial); err != nil {
		return ""
	}
	return partial.EventID
}
