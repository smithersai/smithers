package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type MythicalRouteService interface {
	Snapshot(ctx context.Context, repositoryID int64, slug, mainCommit string) (services.MythicalStackView, error)
	RequestBootstrap(ctx context.Context, repositoryID, actorUserID int64, depth int32, reset bool) (db.MythicalStack, error)
}

// MythicalHandler serves /api/repos/{owner}/{repo}/mythical: the stack
// snapshot (@smthrs/rpc/Mythical MythicalStackSchema), its event hints, and
// the bootstrap request. Writes answer 202 at once; the stack worker works.
type MythicalHandler struct {
	Service  MythicalRouteService
	Broker   *sse.Broker
	MainHead func(ctx context.Context, owner, repo, bookmark string) (string, error)
}

func (h *MythicalHandler) repository(w http.ResponseWriter, r *http.Request) (*middleware.RepoContext, bool) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("the mythical stack is not configured"))
		return nil, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return nil, false
	}
	return repoCtx, true
}

func (h *MythicalHandler) snapshot(r *http.Request, repoCtx *middleware.RepoContext) (services.MythicalStackView, error) {
	repository := repoCtx.Repository
	slug := repoCtx.Owner + "/" + repository.Name
	main := ""
	if h.MainHead != nil {
		bookmark := repository.DefaultBookmark
		if bookmark == "" {
			bookmark = "main"
		}
		// The behind flag is best effort: a slow bookmark read never fails the snapshot.
		if head, err := h.MainHead(r.Context(), repoCtx.Owner, repository.Name, bookmark); err == nil {
			main = head
		}
	}
	return h.Service.Snapshot(r.Context(), repository.ID, slug, main)
}

// GetStack answers the snapshot.
func (h *MythicalHandler) GetStack(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, view)
}

type mythicalBootstrapRequest struct {
	Depth int32 `json:"depth"`
	Reset bool  `json:"reset"`
}

// Bootstrap requests the stack's creation from main's history (or, with
// reset, its rebuild) and answers the snapshot showing the request.
func (h *MythicalHandler) Bootstrap(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	var body mythicalBootstrapRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil && err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid bootstrap request"))
		return
	}
	if body.Depth < 0 || body.Depth > 500 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("depth must be between 1 and 500"))
		return
	}
	if _, err := h.Service.RequestBootstrap(r.Context(), repoCtx.Repository.ID, user.ID, body.Depth, body.Reset); err != nil {
		writeRouteError(w, r, err)
		return
	}
	view, err := h.snapshot(r, repoCtx)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, view)
}

// Events streams `mythical` hints; each carries the new generation.
func (h *MythicalHandler) Events(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	if h.Broker == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("event streaming is not configured"))
		return
	}
	var userID int64
	if user := middleware.UserFromContext(r.Context()); user != nil {
		userID = user.ID
	}
	cfg := sse.BrokerStreamConfig{
		Broker:        h.Broker,
		Channel:       fmt.Sprintf("mythical_%d", repoCtx.Repository.ID),
		UserID:        userID,
		EventType:     "mythical",
		FormatEventID: extractChangeEventID,
	}
	attachRevocation(&cfg, r, revocation.Principal{RepositoryID: repoCtx.Repository.ID})
	serveChangeBrokerSSE(w, r, cfg)
}
