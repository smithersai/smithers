package middleware

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherserrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const agentTokenContextKey contextKey = "agent_token"
const workflowRunContextKey contextKey = "workflow_run"
const sharedAgentTokenContextKey contextKey = "shared_agent_token"

type AgentTokenQuerier interface {
	GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error)
}

type runnerTaskTokenRunQuerier interface {
	GetWorkflowRunByRunID(ctx context.Context, runID int64) (db.WorkflowRun, error)
}

type runnerTaskTokenTaskQuerier interface {
	GetWorkflowTaskForRunner(ctx context.Context, taskID int64) (db.GetWorkflowTaskForRunnerRow, error)
}

func RequireAgentToken(queries AgentTokenQuerier) func(http.Handler) http.Handler {
	sharedToken := strings.TrimSpace(os.Getenv("SMITHERS_AGENT_TOKEN"))
	var sharedTokenHash []byte
	if sharedToken != "" {
		h := sha256.Sum256([]byte(sharedToken))
		sharedTokenHash = h[:]
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract the bearer credential without agent-token format
			// validation: the shared runner-pod credential is operator-minted
			// and carries no required format (the runner lifecycle routes
			// accept it via RequireSharedBearerToken, which never format-gates),
			// so it must reach the shared-token comparison below. The
			// smithers_agent_ format gate applies only to DB-backed per-run
			// tokens, immediately before the lookup.
			token, ok := extractBearerCredential(r)
			if !ok {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or missing agent token"))
				return
			}

			// Add raw token to context
			ctx := context.WithValue(r.Context(), agentTokenContextKey, token)

			if isRunnerTaskTokenSyntax(token) {
				claims, err := verifyRunnerTaskToken(token, sharedToken, time.Now())
				if err != nil {
					smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired runner task token"))
					return
				}
				runQuerier, ok := queries.(runnerTaskTokenRunQuerier)
				if !ok {
					smitherserrors.WriteError(w, smitherserrors.Internal("internal server error"))
					return
				}
				run, err := runQuerier.GetWorkflowRunByRunID(ctx, claims.WorkflowRunID)
				if errors.Is(err, pgx.ErrNoRows) {
					smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired runner task token"))
					return
				} else if err != nil {
					smitherserrors.WriteError(w, smitherserrors.Internal("internal server error").WithCause(err))
					return
				}
				if run.ID != claims.WorkflowRunID || run.RepositoryID != claims.RepositoryID || isTerminalAgentTokenRunStatus(run.Status) {
					smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired runner task token"))
					return
				}
				taskQuerier, ok := queries.(runnerTaskTokenTaskQuerier)
				if !ok {
					smitherserrors.WriteError(w, smitherserrors.Internal("internal server error"))
					return
				}
				task, err := taskQuerier.GetWorkflowTaskForRunner(ctx, claims.TaskID)
				if errors.Is(err, pgx.ErrNoRows) {
					smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired runner task token"))
					return
				} else if err != nil {
					smitherserrors.WriteError(w, smitherserrors.Internal("internal server error").WithCause(err))
					return
				}
				if task.ID != claims.TaskID || task.WorkflowRunID != claims.WorkflowRunID || task.RepositoryID != claims.RepositoryID ||
					task.Attempt != claims.Attempt || !task.RunnerID.Valid || task.RunnerID.Int64 != claims.RunnerID || task.Status != "running" {
					smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired runner task token"))
					return
				}
				ctx = context.WithValue(ctx, workflowRunContextKey, &run)
				ctx = contextWithRunnerTaskToken(ctx, claims)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Hash token; comparing fixed-length hashes keeps the shared-token
			// check constant-time (no content- or length-timing signal).
			hash := sha256.Sum256([]byte(token))
			tokenHash := hex.EncodeToString(hash[:])

			// Constant-time compare so the shared runner-pod credential can't be
			// recovered via a timing side channel (mirrors RequireSharedBearerToken).
			if sharedTokenHash != nil && subtle.ConstantTimeCompare(hash[:], sharedTokenHash) == 1 {
				ctx = context.WithValue(ctx, sharedAgentTokenContextKey, true)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Per-run agent tokens are DB-backed and must match the issued
			// smithers_agent_ format; gate here so arbitrary strings never
			// reach the database.
			if !isValidAgentToken(token) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or missing agent token"))
				return
			}

			if queries == nil {
				smitherserrors.WriteError(w, smitherserrors.Internal("internal server error"))
				return
			}

			// Lookup in DB
			run, err := queries.GetWorkflowRunByAgentToken(ctx, pgtype.Text{String: tokenHash, Valid: true})
			if errors.Is(err, pgx.ErrNoRows) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired agent token"))
				return
			} else if err != nil {
				smitherserrors.WriteError(w, smitherserrors.Internal("internal server error").WithCause(err))
				return
			}

			// Check expiry
			if run.AgentTokenExpiresAt.Valid && run.AgentTokenExpiresAt.Time.Before(time.Now()) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("agent token expired"))
				return
			}

			// Defense in depth: reject stale tokens for runs that already reached a
			// terminal status, even if the credential-revocation path (see
			// services.revokeWorkflowRunCredentials) failed to clear the hash.
			if isTerminalAgentTokenRunStatus(run.Status) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("agent token no longer valid: workflow run is terminal"))
				return
			}

			// Add WorkflowRun to context
			ctx = context.WithValue(ctx, workflowRunContextKey, &run)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func AgentTokenFromContext(ctx context.Context) string {
	value, _ := ctx.Value(agentTokenContextKey).(string)
	return value
}

func WorkflowRunFromContext(ctx context.Context) *db.WorkflowRun {
	run, _ := ctx.Value(workflowRunContextKey).(*db.WorkflowRun)
	return run
}

// IsSharedAgentToken reports whether RequireAgentToken authenticated the
// runner-pod credential rather than a workflow-run credential. Services use
// this marker to apply the narrower claimed-task lookup appropriate to the
// trusted runner control plane without relaxing per-run ownership checks.
func IsSharedAgentToken(ctx context.Context) bool {
	shared, _ := ctx.Value(sharedAgentTokenContextKey).(bool)
	return shared
}

// ContextWithWorkflowRun adds a workflow run to the context.
// Useful for testing handlers that depend on RequireAgentToken middleware.
func ContextWithWorkflowRun(ctx context.Context, run *db.WorkflowRun) context.Context {
	return context.WithValue(ctx, workflowRunContextKey, run)
}

// ContextWithAgentToken adds a raw agent token to the context.
// Useful for testing handlers and services that depend on RequireAgentToken middleware.
func ContextWithAgentToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, agentTokenContextKey, token)
}

// ContextWithSharedAgentToken marks a test context as authenticated with the
// runner-pod credential. Production contexts receive this marker only from
// RequireAgentToken after a constant-time comparison with the configured
// shared token.
func ContextWithSharedAgentToken(ctx context.Context) context.Context {
	return context.WithValue(ctx, sharedAgentTokenContextKey, true)
}

// extractBearerCredential returns the bearer credential without agent-token
// format validation, so credential classes with no mandated format (the shared
// runner-pod token) can be compared before the per-run format gate.
func extractBearerCredential(r *http.Request) (string, bool) {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if auth == "" {
		return "", false
	}

	parts := strings.Fields(auth)
	if len(parts) != 2 {
		return "", false
	}
	if !strings.EqualFold(parts[0], "bearer") {
		return "", false
	}

	return parts[1], true
}

func isValidAgentToken(token string) bool {
	if isRunnerTaskTokenSyntax(token) {
		return true
	}
	if !strings.HasPrefix(token, "smithers_agent_") {
		return false
	}

	tail := strings.TrimPrefix(token, "smithers_agent_")
	if len(tail) != 40 {
		return false
	}

	for _, ch := range tail {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func isTerminalAgentTokenRunStatus(status string) bool {
	switch status {
	case "success", "failure", "cancelled", "error":
		return true
	default:
		return false
	}
}

// IsAgentCredentialSyntax reports whether token is shaped like a per-run
// agent token or a runner task token, so a route that accepts several
// credential kinds can send it to RequireAgentToken.
func IsAgentCredentialSyntax(token string) bool {
	return isValidAgentToken(token)
}
