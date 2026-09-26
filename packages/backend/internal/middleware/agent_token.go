package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherserrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const agentTokenContextKey contextKey = "agent_token"
const workflowRunContextKey contextKey = "workflow_run"

type AgentTokenQuerier interface {
	GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error)
}

// RequireAgentToken authenticates a per-run workflow agent token and puts its
// workflow run in the request context.
func RequireAgentToken(queries AgentTokenQuerier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractBearerCredential(r)
			if !ok {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or missing agent token"))
				return
			}

			// Add raw token to context
			ctx := context.WithValue(r.Context(), agentTokenContextKey, token)

			// Per-run agent tokens are DB-backed and must match the issued
			// smithers_agent_ format; gate here so arbitrary strings never
			// reach the database.
			if !isValidAgentToken(token) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or missing agent token"))
				return
			}
			hash := sha256.Sum256([]byte(token))
			tokenHash := hex.EncodeToString(hash[:])

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

// extractBearerCredential returns the bearer credential; RequireAgentToken
// applies the per-run token format gate before any lookup.
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
