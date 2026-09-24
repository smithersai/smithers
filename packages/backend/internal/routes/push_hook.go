package routes

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// pushWorkflowSyncSlots bounds concurrent post-push workflow sync/dispatch
// workers so a push flood cannot pile up unbounded goroutines doing
// repo-host fetches; waiting goroutines are cheap and drain because each
// worker is deadline-bounded (see pushWorkflowSyncTimeout).
var pushWorkflowSyncSlots = make(chan struct{}, 8)

// pushSearchIndexSlots bounds concurrent code-search indexing jobs separately
// from workflow work so a large first index cannot starve workflow dispatch.
var pushSearchIndexSlots = make(chan struct{}, 8)

// History imports can take much longer than repo-host's callback deadline.
// Keep their database work separate from workflow discovery and indexing.
var pushChangeSyncSlots = make(chan struct{}, 2)

const pushChangeSyncTimeout = time.Hour

// pushWorkflowSyncTimeout bounds how long a single post-push workflow
// sync/dispatch worker may run before its context is cancelled.
const pushWorkflowSyncTimeout = 5 * time.Minute

const pushSearchIndexTimeout = 5 * time.Minute

type PushHookRepoResolver interface {
	GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	// RepoPermQuerier lets the handler resolve the pusher's effective
	// permission so config-sync only applies admin-only settings for admins.
	services.RepoPermQuerier
}

// PushHookWorkflowSyncer discovers and syncs workflow definitions after a push.
type PushHookWorkflowSyncer interface {
	LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error)
	PersistDefinitions(ctx context.Context, repoID int64, result services.WorkflowLoadResult) error
}

// PushHookWorkflowRunner dispatches workflow runs for push events.
type PushHookWorkflowRunner interface {
	DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
}

type PushHookConfigSyncer interface {
	SyncFromCommit(ctx context.Context, input configsync.SyncInput) (configsync.SyncResult, error)
}

type PushHookSearchIndexer interface {
	IndexPush(ctx context.Context, input services.SearchIndexPushInput) error
}

type PushHookChangeRecorder interface {
	RecordPush(ctx context.Context, repositoryID int64, owner, repo string) error
}

type InternalPushHookHandler struct {
	RepoResolver   PushHookRepoResolver
	Dispatcher     webhooks.Dispatcher
	WorkflowSync   PushHookWorkflowSyncer
	WorkflowRun    PushHookWorkflowRunner
	ConfigSync     PushHookConfigSyncer
	SearchIndex    PushHookSearchIndexer
	ChangeRecorder PushHookChangeRecorder
}

type PushHookEventRequest struct {
	Owner       string `json:"owner"`
	Repo        string `json:"repo"`
	Ref         string `json:"ref_name"`
	CommitSHA   string `json:"commit_sha"`
	PusherID    int64  `json:"pusher_id"`
	PusherLogin string `json:"pusher_login"`
}

func (h *InternalPushHookHandler) PostPushEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req PushHookEventRequest
	if !decodeJSONBodyWithMessage(w, r, &req, "Invalid JSON payload") {
		return
	}

	if h.RepoResolver == nil || h.Dispatcher == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("push hook handler not configured"))
		return
	}

	repo, err := h.RepoResolver.GetRepoByOwnerAndName(ctx, db.GetRepoByOwnerAndNameParams{
		Owner: req.Owner,
		Name:  req.Repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			pkgerrors.WriteError(w, pkgerrors.NotFound("Repository not found"))
			return
		}
		writeRouteError(w, r, fmt.Errorf("resolve push hook repository %s/%s: %w", req.Owner, req.Repo, err))
		return
	}
	payload := webhooks.PushEventPayload{
		Ref: req.Ref,
		Repository: webhooks.RepositoryPayload{
			ID:       repo.ID,
			Name:     repo.Name,
			FullName: req.Owner + "/" + repo.Name,
		},
		Sender: webhooks.UserPayload{
			ID:    req.PusherID,
			Login: req.PusherLogin,
		},
	}

	// User webhooks are one independent side effect of a push. repo-host never
	// retries this callback, so an enqueue failure must not skip change sync,
	// workflow dispatch or search indexing.
	if err := h.Dispatcher.DispatchEvent(ctx, repo.ID, webhooks.EventTypePush, payload); err != nil {
		middleware.LoggerFromContext(ctx).Error("push webhook enqueue failed",
			"repo_id", repo.ID, "ref", req.Ref, "error", err)
	}
	if h.ChangeRecorder != nil {
		repoID, repoName := repo.ID, repo.Name
		services.SafeGo("push-change-sync", func() { h.handleChangesForPush(repoID, req.Owner, repoName) })
	}

	// Async: sync workflow definitions then dispatch workflow runs for the push event.
	if h.WorkflowSync != nil || h.WorkflowRun != nil || h.ConfigSync != nil {
		repoID := repo.ID
		services.SafeGo("push-workflow-sync", func() { h.handleWorkflowsForPush(repoID, req) })
	}
	if h.SearchIndex != nil {
		repoID := repo.ID
		services.SafeGo("push-search-index", func() { h.handleSearchIndexForPush(repoID, req) })
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *InternalPushHookHandler) handleChangesForPush(repoID int64, owner, repo string) {
	ctx, cancel := context.WithTimeout(context.Background(), pushChangeSyncTimeout)
	defer cancel()
	select {
	case pushChangeSyncSlots <- struct{}{}:
		defer func() { <-pushChangeSyncSlots }()
	case <-ctx.Done():
		slog.Error("change revision sync timed out waiting for a slot", "repo_id", repoID)
		return
	}
	if err := h.ChangeRecorder.RecordPush(ctx, repoID, owner, repo); err != nil {
		slog.Error("change revision sync failed after push", "repo_id", repoID, "error", err)
	}
}

func (h *InternalPushHookHandler) handleSearchIndexForPush(repoID int64, req PushHookEventRequest) {
	pushSearchIndexSlots <- struct{}{}
	defer func() { <-pushSearchIndexSlots }()

	ctx, cancel := context.WithTimeout(context.Background(), pushSearchIndexTimeout)
	defer cancel()

	err := h.SearchIndex.IndexPush(ctx, services.SearchIndexPushInput{
		RepositoryID:   repoID,
		Owner:          req.Owner,
		RepositoryName: req.Repo,
		Ref:            req.Ref,
		CommitSHA:      req.CommitSHA,
	})
	if err != nil {
		slog.Error("code search indexing failed after push",
			"repo_id", repoID,
			"ref", req.Ref,
			"commit_sha", req.CommitSHA,
			"error", err,
		)
	}
}

func (h *InternalPushHookHandler) handleWorkflowsForPush(repoID int64, req PushHookEventRequest) {
	pushWorkflowSyncSlots <- struct{}{}
	defer func() { <-pushWorkflowSyncSlots }()

	ctx, cancel := context.WithTimeout(context.Background(), pushWorkflowSyncTimeout)
	defer cancel()

	var loadResult services.WorkflowLoadResult
	loadAttempted := false
	loadedDefinitions := false

	if h.WorkflowSync != nil && req.CommitSHA != "" {
		loadAttempted = true
		result, err := h.WorkflowSync.LoadDefinitionsFromCommit(ctx, repoID, req.CommitSHA)
		if err != nil {
			slog.Error("workflow load failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
		} else {
			loadResult = result
			loadedDefinitions = true
			if h.shouldPersistDefinitions(ctx, repoID, req.Ref) {
				if err := h.WorkflowSync.PersistDefinitions(ctx, repoID, result); err != nil {
					slog.Error("workflow persistence failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
				}
			}
		}
	}

	if h.ConfigSync != nil && req.CommitSHA != "" && h.shouldPersistDefinitions(ctx, repoID, req.Ref) {
		// Config-sync persists admin-only repository settings (visibility,
		// protected bookmarks, webhooks, mirror, landing queue) authored in
		// repo files. These files are controlled by anyone who can push, so we
		// must only apply them when the pusher actually has admin permission on
		// the repo. Otherwise a low-privilege collaborator could push a
		// .smithers/config.yml (or protected-bookmarks.yml) to escalate — e.g.
		// flip the repo public or disable branch protection.
		if !h.pusherCanAdmin(ctx, repoID, req.PusherID) {
			slog.Warn("skipping config sync after push: pusher lacks repo admin permission",
				"repo_id", repoID, "pusher_id", req.PusherID, "commit_sha", req.CommitSHA)
		} else {
			actorID := req.PusherID
			_, err := h.ConfigSync.SyncFromCommit(ctx, configsync.SyncInput{
				RepositoryID: repoID,
				CommitSHA:    req.CommitSHA,
				Trigger:      "push",
				ActorID:      &actorID,
				ActorName:    req.PusherLogin,
			})
			if err != nil {
				slog.Error("config sync failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
			}
		}
	}

	if h.WorkflowRun != nil {
		input := services.DispatchForEventInput{
			RepositoryID: repoID,
			UserID:       req.PusherID,
			Event: services.TriggerEvent{
				Type:      "push",
				Ref:       req.Ref,
				CommitSHA: req.CommitSHA,
			},
		}
		if loadedDefinitions {
			input.UseLoadedDefinitions = true
			input.LoadedDefinitions = loadResult.Definitions
		} else if loadAttempted {
			slog.Info("workflow dispatch falling back to persisted definitions", "repo_id", repoID, "commit_sha", req.CommitSHA)
		}
		_, err := h.WorkflowRun.DispatchForEvent(ctx, input)
		if err != nil {
			slog.Error("workflow dispatch failed after push", "repo_id", repoID, "error", err)
		}
	}
}

// pusherCanAdmin reports whether the pushing user has admin (or owner) access to
// the repository. It fails closed: any lookup error is treated as "not admin" so
// config-sync never applies privileged settings on an unverified pusher.
func (h *InternalPushHookHandler) pusherCanAdmin(ctx context.Context, repoID int64, pusherID int64) bool {
	if h.RepoResolver == nil || pusherID <= 0 {
		return false
	}

	repo, err := h.RepoResolver.GetRepoByID(ctx, repoID)
	if err != nil {
		slog.Error("failed to load repository for config-sync admin check", "repo_id", repoID, "error", err)
		return false
	}

	isAdmin, err := services.CanAdminRepo(ctx, h.RepoResolver, repo, pusherID)
	if err != nil {
		slog.Error("failed to resolve pusher permission for config-sync", "repo_id", repoID, "pusher_id", pusherID, "error", err)
		return false
	}
	return isAdmin
}

func (h *InternalPushHookHandler) shouldPersistDefinitions(ctx context.Context, repoID int64, ref string) bool {
	if h.RepoResolver == nil {
		return false
	}

	repo, err := h.RepoResolver.GetRepoByID(ctx, repoID)
	if err != nil {
		slog.Error("failed to load repository for workflow persistence decision", "repo_id", repoID, "error", err)
		return false
	}

	return normalizeBookmarkRef(ref) == strings.TrimSpace(repo.DefaultBookmark)
}

func normalizeBookmarkRef(ref string) string {
	if strings.HasPrefix(ref, "refs/heads/") {
		return strings.TrimPrefix(ref, "refs/heads/")
	}
	return strings.TrimSpace(ref)
}
