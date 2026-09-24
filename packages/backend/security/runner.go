// Package security exposes canonical credential and request-context contracts.
package security

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/controlstore"
	impl "github.com/smithersai/smithers/packages/backend/internal/middleware"
	"log/slog"
	"net/http"
)

type RunnerTaskTokenClaims = impl.RunnerTaskTokenClaims
type AgentTokenQuerier = impl.AgentTokenQuerier

const RunnerTaskTokenTTL = impl.RunnerTaskTokenTTL

func RequireSharedBearerToken(token string) func(http.Handler) http.Handler {
	return impl.RequireSharedBearerToken(token)
}

func AgentTokenFromContext(ctx context.Context) string { return impl.AgentTokenFromContext(ctx) }
func WorkflowRunFromContext(ctx context.Context) *controlstore.WorkflowRun {
	return impl.WorkflowRunFromContext(ctx)
}
func RunnerTaskTokenFromContext(ctx context.Context) (RunnerTaskTokenClaims, bool) {
	return impl.RunnerTaskTokenFromContext(ctx)
}
func IsSharedAgentToken(ctx context.Context) bool { return impl.IsSharedAgentToken(ctx) }
func ContextWithAgentToken(ctx context.Context, token string) context.Context {
	return impl.ContextWithAgentToken(ctx, token)
}
func ContextWithRunnerTaskToken(ctx context.Context, claims RunnerTaskTokenClaims) context.Context {
	return impl.ContextWithRunnerTaskToken(ctx, claims)
}
func ContextWithSharedAgentToken(ctx context.Context) context.Context {
	return impl.ContextWithSharedAgentToken(ctx)
}
func ContextWithWorkflowRun(ctx context.Context, run *controlstore.WorkflowRun) context.Context {
	return impl.ContextWithWorkflowRun(ctx, run)
}
func MintRunnerTaskToken(secret string, claims RunnerTaskTokenClaims) (string, error) {
	return impl.MintRunnerTaskToken(secret, claims)
}
func RequireAgentToken(q AgentTokenQuerier) func(http.Handler) http.Handler {
	return impl.RequireAgentToken(q)
}
func LoggerWithWorkflowRun(ctx context.Context, id int64) *slog.Logger {
	return impl.LoggerWithWorkflowRun(ctx, id)
}
func LoggerWithAgentSessionAndWorkflowRun(ctx context.Context, session string, id int64) *slog.Logger {
	return impl.LoggerWithAgentSessionAndWorkflowRun(ctx, session, id)
}
