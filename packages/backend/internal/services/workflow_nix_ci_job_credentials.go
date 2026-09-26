package services

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Workflow cache and artifact access for NixOS CI guests (smithers#1768).
//
// The retired runner handed each job a per-run agent token and a 0.x
// TypeScript step runtime that restored and saved `cache:` descriptors and
// uploaded artifacts. A NixOS guest gets neither. Instead the scheduler mints
// one job token per running task (middleware.CIJobTokenPrefix), passes it only
// to that task's guest in the job's exec environment, and deletes it when the
// job ends. The /internal cache and artifact routes accept it through
// middleware.RequireWorkflowRunCredential, which resolves it to the task's run,
// so the existing per-run and per-repository scoping of WorkflowCacheService
// and WorkflowArtifactService applies unchanged. The guest side is a small
// Python client (workflow_nix_ci_guest.py) that the start exec installs; the
// NixOS base image already ships python3.

//go:embed workflow_nix_ci_guest.py
var nixCIGuestHelper string

const (
	// nixCIToolDir holds the guest helper and its per-job cache files.
	nixCIToolDir          = "/var/lib/smithers-ci"
	nixCIToolBinDir       = nixCIToolDir + "/bin"
	nixCIToolHelperPath   = nixCIToolBinDir + "/smithers-ci"
	nixCICacheDescriptors = nixCIToolDir + "/cache.json"
	nixCICacheState       = nixCIToolDir + "/cache-state.json"

	// nixCIJobTokenGrace outlives the job's own ceiling slightly so a cache
	// save at the very end of a long job still authenticates. The token is
	// deleted when the job ends, and rejected once its task is not running,
	// whichever comes first.
	nixCIJobTokenGrace = 5 * time.Minute
)

// WorkflowCIJobCredentialStore persists job tokens. *db.Queries implements it.
type WorkflowCIJobCredentialStore interface {
	IssueWorkflowTaskGuestToken(ctx context.Context, arg db.IssueWorkflowTaskGuestTokenParams) (int64, error)
	RevokeWorkflowTaskGuestToken(ctx context.Context, workflowTaskID int64) error
}

// WithWorkflowSandboxSchedulerCIJobCredentials lets NixOS CI guests restore and
// save workflow caches and upload and download run artifacts. internalBaseURL
// is the control plane's /internal URL as a guest reaches it. Unset, jobs run
// without a job token and `cache:` descriptors are reported as unavailable.
func WithWorkflowSandboxSchedulerCIJobCredentials(store WorkflowCIJobCredentialStore, internalBaseURL string) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.ciJobCredentials = store
		w.ciInternalBaseURL = strings.TrimRight(strings.TrimSpace(internalBaseURL), "/")
	}
}

// issueNixCIJobToken mints the running task's job token. It returns the
// guest environment that carries it and a revoke func that is always safe to
// call; with no store configured both are empty.
func (w *WorkflowSandboxSchedulerWorker) issueNixCIJobToken(ctx context.Context, task nixCITask, repositoryID int64) (map[string]string, func(), error) {
	noop := func() {}
	if w.ciJobCredentials == nil || w.ciInternalBaseURL == "" {
		return nil, noop, nil
	}
	var raw [20]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, noop, fmt.Errorf("generate job token: %w", err)
	}
	token := middleware.CIJobTokenPrefix + hex.EncodeToString(raw[:])
	issued, err := w.ciJobCredentials.IssueWorkflowTaskGuestToken(ctx, db.IssueWorkflowTaskGuestTokenParams{
		TokenHash:      middleware.HashCIJobToken(token),
		ExpiresAt:      time.Now().UTC().Add(w.nixCITaskTimeout() + nixCIJobTokenGrace),
		WorkflowTaskID: task.ID,
		WorkflowRunID:  task.WorkflowRunID,
		RepositoryID:   repositoryID,
	})
	if err != nil {
		return nil, noop, fmt.Errorf("store job token: %w", err)
	}
	if issued != 1 {
		return nil, noop, fmt.Errorf("task %d is not running", task.ID)
	}
	revoke := func() {
		revokeCtx, cancel := w.finalizeContext(ctx)
		defer cancel()
		if err := w.ciJobCredentials.RevokeWorkflowTaskGuestToken(revokeCtx, task.ID); err != nil {
			w.logger.Warn("failed to revoke NixOS CI job token", "task_id", task.ID, "error", err)
		}
	}
	return map[string]string{
		"SMITHERS_CI_JOB_TOKEN":    token,
		"SMITHERS_CI_API_URL":      w.ciInternalBaseURL,
		"SMITHERS_WORKFLOW_RUN_ID": strconv.FormatInt(task.WorkflowRunID, 10),
	}, revoke, nil
}

// nixCICacheDescriptorsJSON is the job's `cache:` list as the guest helper
// reads it. JSON has no raw newline, so it is safe inside a heredoc.
func nixCICacheDescriptorsJSON(task nixCITask) string {
	descriptors := task.Cache
	if descriptors == nil {
		descriptors = []WorkflowCacheDescriptor{}
	}
	raw, _ := json.Marshal(descriptors)
	return string(raw)
}

func nixCIHasCacheAction(task nixCITask, action string) bool {
	for _, descriptor := range task.Cache {
		if descriptor.Action == action && strings.TrimSpace(descriptor.Key) != "" {
			return true
		}
	}
	return false
}
