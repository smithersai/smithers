package middleware

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const runnerTaskTokenPrefix = "smithers_task_v1."

const runnerTaskTokenContextKey contextKey = "runner_task_token"

// RunnerTaskTokenTTL matches the existing workflow-run credential lifetime.
// A task callback still has to reference a currently running task, so this is
// an outer bound rather than permission to act after task completion.
const RunnerTaskTokenTTL = 24 * time.Hour

// RunnerTaskTokenClaims bind an untrusted workflow child to exactly the task
// and runner that the trusted pod process claimed. The token is signed with the
// pod credential; the credential itself is never revealed to the child.
type RunnerTaskTokenClaims struct {
	TaskID        int64 `json:"task_id"`
	WorkflowRunID int64 `json:"workflow_run_id"`
	RepositoryID  int64 `json:"repository_id"`
	RunnerID      int64 `json:"runner_id"`
	Attempt       int32 `json:"attempt"`
	ExpiresAtUnix int64 `json:"exp"`
}

// MintRunnerTaskToken creates a signed credential for one claimed runner task.
func MintRunnerTaskToken(signingSecret string, claims RunnerTaskTokenClaims) (string, error) {
	signingSecret = strings.TrimSpace(signingSecret)
	if signingSecret == "" {
		return "", errors.New("runner task token signing secret is empty")
	}
	if claims.TaskID <= 0 || claims.WorkflowRunID <= 0 || claims.RepositoryID <= 0 || claims.RunnerID <= 0 || claims.Attempt <= 0 || claims.ExpiresAtUnix <= 0 {
		return "", errors.New("runner task token claims are invalid")
	}

	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signed := runnerTaskTokenPrefix + encodedPayload
	mac := hmac.New(sha256.New, []byte(signingSecret))
	_, _ = mac.Write([]byte(signed))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signed + "." + signature, nil
}

func verifyRunnerTaskToken(token, signingSecret string, now time.Time) (RunnerTaskTokenClaims, error) {
	var claims RunnerTaskTokenClaims
	if !strings.HasPrefix(token, runnerTaskTokenPrefix) || strings.TrimSpace(signingSecret) == "" {
		return claims, errors.New("invalid runner task token")
	}
	remainder := strings.TrimPrefix(token, runnerTaskTokenPrefix)
	parts := strings.Split(remainder, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return claims, errors.New("invalid runner task token")
	}

	signed := runnerTaskTokenPrefix + parts[0]
	providedSignature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, errors.New("invalid runner task token")
	}
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(signingSecret)))
	_, _ = mac.Write([]byte(signed))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return claims, errors.New("invalid runner task token")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return RunnerTaskTokenClaims{}, errors.New("invalid runner task token")
	}
	if claims.TaskID <= 0 || claims.WorkflowRunID <= 0 || claims.RepositoryID <= 0 || claims.RunnerID <= 0 || claims.Attempt <= 0 {
		return RunnerTaskTokenClaims{}, errors.New("invalid runner task token")
	}
	if !time.Unix(claims.ExpiresAtUnix, 0).After(now) {
		return RunnerTaskTokenClaims{}, errors.New("runner task token expired")
	}
	return claims, nil
}

// VerifyRunnerTaskToken verifies a task credential's signature, claims, and
// expiry. Callers must additionally confirm the claimed task is still running
// and authorize the concrete resource against RepositoryID.
func VerifyRunnerTaskToken(token, signingSecret string) (RunnerTaskTokenClaims, error) {
	return verifyRunnerTaskToken(token, signingSecret, time.Now())
}

func isRunnerTaskTokenSyntax(token string) bool {
	if !strings.HasPrefix(token, runnerTaskTokenPrefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(token, runnerTaskTokenPrefix), ".")
	return len(parts) == 2 && parts[0] != "" && parts[1] != ""
}

// IsRunnerTaskTokenSyntax reports whether token uses the task-token envelope.
// It does not authenticate the token; use VerifyRunnerTaskToken for that.
func IsRunnerTaskTokenSyntax(token string) bool {
	return isRunnerTaskTokenSyntax(strings.TrimSpace(token))
}

func contextWithRunnerTaskToken(ctx context.Context, claims RunnerTaskTokenClaims) context.Context {
	return context.WithValue(ctx, runnerTaskTokenContextKey, claims)
}

// RunnerTaskTokenFromContext returns claims verified by RequireAgentToken.
func RunnerTaskTokenFromContext(ctx context.Context) (RunnerTaskTokenClaims, bool) {
	claims, ok := ctx.Value(runnerTaskTokenContextKey).(RunnerTaskTokenClaims)
	return claims, ok
}

// ContextWithRunnerTaskToken adds verified task claims to a test context.
// Production requests receive claims only after RequireAgentToken verifies the
// token signature, expiry, and workflow-run binding.
func ContextWithRunnerTaskToken(ctx context.Context, claims RunnerTaskTokenClaims) context.Context {
	return contextWithRunnerTaskToken(ctx, claims)
}
