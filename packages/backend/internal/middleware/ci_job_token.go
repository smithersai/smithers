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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherserrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CIJobTokenPrefix marks the per-job credential a NixOS CI guest receives. The
// sandbox scheduler mints one for each running job, and it is accepted only by
// the workflow cache and artifact routes of that job's run.
const CIJobTokenPrefix = "smithers_cijob_"

const ciJobTaskContextKey contextKey = "ci_job_task_id"

// CIJobTokenQuerier resolves a job credential hash to its run.
type CIJobTokenQuerier interface {
	GetWorkflowRunByTaskGuestToken(ctx context.Context, tokenHash string) (db.GetWorkflowRunByTaskGuestTokenRow, error)
}

// RequireWorkflowRunCredential authenticates either credential that may act
// for one workflow run: the per-run agent token (RequireAgentToken) or a CI
// job token. A job token is valid only while its task is running, its run is
// not terminal, and it has not expired; it puts its run in the request
// context exactly like an agent token does, so the handlers' existing
// per-run and per-repository scoping applies unchanged.
//
// Mount it only on routes a CI job may use. It is deliberately not part of
// RequireAgentToken, which also guards agent-session and model-proxy routes.
func RequireWorkflowRunCredential(agentTokens AgentTokenQuerier, jobTokens CIJobTokenQuerier) func(http.Handler) http.Handler {
	requireAgent := RequireAgentToken(agentTokens)
	return func(next http.Handler) http.Handler {
		agent := requireAgent(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractBearerCredential(r)
			if !ok || !strings.HasPrefix(token, CIJobTokenPrefix) {
				agent.ServeHTTP(w, r)
				return
			}
			if !IsCIJobTokenSyntax(token) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired job token"))
				return
			}
			if jobTokens == nil {
				smitherserrors.WriteError(w, smitherserrors.Internal("internal server error"))
				return
			}
			row, err := jobTokens.GetWorkflowRunByTaskGuestToken(r.Context(), HashCIJobToken(token))
			if errors.Is(err, pgx.ErrNoRows) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired job token"))
				return
			} else if err != nil {
				smitherserrors.WriteError(w, smitherserrors.Internal("internal server error").WithCause(err))
				return
			}
			if !row.TokenExpiresAt.After(time.Now()) || row.TaskStatus != "running" ||
				isTerminalAgentTokenRunStatus(row.WorkflowRun.Status) {
				smitherserrors.WriteError(w, smitherserrors.Unauthorized("invalid or expired job token"))
				return
			}
			run := row.WorkflowRun
			ctx := context.WithValue(r.Context(), agentTokenContextKey, token)
			ctx = context.WithValue(ctx, workflowRunContextKey, &run)
			ctx = context.WithValue(ctx, ciJobTaskContextKey, row.WorkflowTaskID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CIJobTaskIDFromContext returns the task a CI job token was issued to, or 0
// when the request used another credential.
func CIJobTaskIDFromContext(ctx context.Context) int64 {
	id, _ := ctx.Value(ciJobTaskContextKey).(int64)
	return id
}

// IsCIJobTokenSyntax reports whether token is shaped like an issued job token:
// the prefix followed by 40 lowercase hex characters.
func IsCIJobTokenSyntax(token string) bool {
	tail, ok := strings.CutPrefix(token, CIJobTokenPrefix)
	if !ok || len(tail) != 40 {
		return false
	}
	for _, ch := range tail {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

// HashCIJobToken is the stored form of a job token.
func HashCIJobToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
