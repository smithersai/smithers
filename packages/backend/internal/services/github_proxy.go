package services

import (
	"bytes"
	"context"
	"encoding/json"
	stdErrors "errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const GitHubProxyForbiddenActionCode = pkgerrors.CodeGitHubForbiddenAction

type GitHubProxyStore interface {
	GetWorkflowRunByRunID(ctx context.Context, id int64) (db.WorkflowRun, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	InsertGithubProxyAuditLog(ctx context.Context, arg db.InsertGithubProxyAuditLogParams) error
}

type GitHubProxyInstallationTokenIssuer interface {
	CreateGitHubInstallationToken(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error)
}

type gitHubProxyInternalRepoTokenIssuer interface {
	CreateGitHubInstallationTokenForRepositoryOwner(ctx context.Context, ownerUserID int64, ownerOrgID int64, owner string, repo string) (GitHubInstallationToken, error)
}

type gitHubProxyImportedSourceTokenIssuer interface {
	CreateGitHubInstallationTokenForImportedSource(ctx context.Context, userID int64, repositoryID int64, owner string, repo string) (GitHubInstallationToken, error)
}

type GitHubProxyService struct {
	store               GitHubProxyStore
	tokenIssuer         GitHubProxyInstallationTokenIssuer
	httpClient          *http.Client
	gitHubBudgetTracker *BudgetTracker
}

type GitHubProxyServiceOption func(*GitHubProxyService)

func WithGitHubProxyHTTPClient(client *http.Client) GitHubProxyServiceOption {
	return func(s *GitHubProxyService) {
		if client != nil {
			s.httpClient = client
		}
	}
}

func WithGitHubProxyBudgetTracker(tracker *BudgetTracker) GitHubProxyServiceOption {
	return func(s *GitHubProxyService) {
		s.gitHubBudgetTracker = tracker
	}
}

func NewGitHubProxyService(store GitHubProxyStore, tokenIssuer GitHubProxyInstallationTokenIssuer, opts ...GitHubProxyServiceOption) *GitHubProxyService {
	svc := &GitHubProxyService{
		store:       store,
		tokenIssuer: tokenIssuer,
		httpClient:  observability.NewHTTPClient(30 * time.Second),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

type GitHubProxyRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type GitHubProxyResponse struct {
	StatusCode int
	Headers    http.Header
	Body       io.ReadCloser
}

func (s *GitHubProxyService) ProxyRequest(ctx context.Context, sandboxToken string, input GitHubProxyRequest) (*GitHubProxyResponse, error) {
	if s == nil || s.store == nil || s.tokenIssuer == nil {
		return nil, pkgerrors.Internal("github proxy service unavailable")
	}

	workflowRunID, err := ValidateSandboxToken(sandboxToken)
	if err != nil {
		return nil, pkgerrors.Unauthorized("invalid or expired sandbox token")
	}

	run, err := s.store.GetWorkflowRunByRunID(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.Unauthorized("invalid or expired sandbox token")
		}
		return nil, pkgerrors.Internal("failed to resolve workflow run")
	}

	repository, err := s.store.GetRepoByID(ctx, run.RepositoryID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("repository not found")
		}
		return nil, pkgerrors.Internal("failed to resolve repository")
	}

	owner, err := s.resolveRepositoryOwner(ctx, repository)
	if err != nil {
		return nil, err
	}

	resolved := gitHubProxyResolvedContext{
		Owner:                         owner,
		Repo:                          repository.Name,
		UseInternalRepoInstallationID: true,
		AuditWorkflowRunID:            run.ID,
		AuditWorkflowRunIDValid:       true,
	}
	if repository.UserID.Valid {
		resolved.RepoOwnerUserID = repository.UserID.Int64
	}
	if repository.OrgID.Valid {
		resolved.RepoOwnerOrgID = repository.OrgID.Int64
	}

	return s.proxyRequest(ctx, resolved, input, GitHubProxyPolicyInput{})
}

func (s *GitHubProxyService) ProxyRepoRequest(ctx context.Context, actor *db.User, owner string, repo string, input GitHubProxyRequest) (*GitHubProxyResponse, error) {
	if s == nil || s.tokenIssuer == nil {
		return nil, pkgerrors.Internal("github proxy service unavailable")
	}
	if actor == nil || actor.ID <= 0 {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return nil, pkgerrors.BadRequest("owner and repo are required")
	}

	resolved := gitHubProxyResolvedContext{
		ActorUserID: actor.ID,
		Owner:       trimmedOwner,
		Repo:        trimmedRepo,
	}
	if repoCtx := middleware.RepoContextFromContext(ctx); repoCtx != nil && repoCtx.Repository != nil {
		if repoCtx.Repository.ID > 0 {
			resolved.RepositoryID = repoCtx.Repository.ID
			resolved.TryImportedSourceInstallationID = true
		}
		if gitHubProxyRepoContextUsesImportedSource(repoCtx, trimmedOwner, trimmedRepo) {
			resolved.UseImportedSourceInstallationID = true
		}
	}

	return s.proxyRequest(ctx, resolved, input, GitHubProxyPolicyInput{
		AllowPullWrites: true,
	})
}

type gitHubProxyResolvedContext struct {
	ActorUserID                     int64
	Owner                           string
	Repo                            string
	UseInternalRepoInstallationID   bool
	UseImportedSourceInstallationID bool
	TryImportedSourceInstallationID bool
	RepositoryID                    int64
	RepoOwnerUserID                 int64
	RepoOwnerOrgID                  int64
	AuditWorkflowRunID              int64
	AuditWorkflowRunIDValid         bool
}

func gitHubProxyRepoContextUsesImportedSource(repoCtx *middleware.RepoContext, owner string, repo string) bool {
	if repoCtx == nil || repoCtx.Repository == nil || repoCtx.Repository.ID <= 0 {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(repoCtx.Owner), strings.TrimSpace(owner)) {
		return true
	}
	repositoryName := strings.TrimSpace(repoCtx.Repository.Name)
	if repositoryName == "" {
		repositoryName = strings.TrimSpace(repoCtx.Repository.LowerName)
	}
	return !strings.EqualFold(repositoryName, strings.TrimSpace(repo))
}

func (s *GitHubProxyService) proxyRequest(ctx context.Context, resolved gitHubProxyResolvedContext, input GitHubProxyRequest, policyOverrides GitHubProxyPolicyInput) (*GitHubProxyResponse, error) {
	method, requestPath, err := normalizeGitHubProxyMethodAndPath(input.Method, input.Path)
	if err != nil {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, strings.ToUpper(strings.TrimSpace(input.Method)), strings.TrimSpace(input.Path), statusCodeFromError(err), "deny", err.Error())
		return nil, err
	}

	bodyBytes, hasBody, err := normalizeGitHubProxyBody(input.Body)
	if err != nil {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, statusCodeFromError(err), "deny", err.Error())
		return nil, err
	}

	policyDecision := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{
		Method:             method,
		Path:               requestPath,
		Body:               json.RawMessage(bodyBytes),
		RepoOwner:          resolved.Owner,
		RepoName:           resolved.Repo,
		AllowPullWrites:    policyOverrides.AllowPullWrites,
		AllowMerges:        policyOverrides.AllowMerges,
		AllowBranchDeletes: policyOverrides.AllowBranchDeletes,
	})
	if !policyDecision.Allowed {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, http.StatusForbidden, "deny", policyDecision.Reason)
		return nil, &pkgerrors.APIError{
			Status:  http.StatusForbidden,
			Code:    GitHubProxyForbiddenActionCode,
			Message: policyDecision.Reason,
		}
	}

	installationToken, err := s.createInstallationToken(ctx, resolved)
	if err != nil {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, statusCodeFromError(err), "deny", "failed to create github installation token")
		return nil, err
	}
	if s.gitHubBudgetTracker != nil {
		allowed, retryAfter, rateLimit := s.gitHubBudgetTracker.AllowWithStatus(installationToken.InstallationID)
		if !allowed {
			retryAfterSeconds := gitHubProxyRetryAfterSeconds(retryAfter)
			s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, http.StatusTooManyRequests, "deny", "github installation rate limit exceeded")
			return nil, &pkgerrors.APIError{
				Status:     http.StatusTooManyRequests,
				Code:       pkgerrors.CodeGitHubRateLimited,
				Message:    "github installation rate limit exceeded",
				Limit:      &rateLimit.Limit,
				Remaining:  &rateLimit.Remaining,
				ResetAt:    &rateLimit.ResetAt,
				RetryAfter: retryAfterSeconds,
			}
		}
	}

	upstreamReq, err := s.buildUpstreamRequest(ctx, method, requestPath, input.Headers, bodyBytes, hasBody, installationToken.Token)
	if err != nil {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, statusCodeFromError(err), "deny", "failed to build github proxy request")
		return nil, err
	}

	// The route owns the streamed body and closes it in writeGitHubProxyResponse.
	upstreamResp, err := s.httpClient.Do(upstreamReq) //nolint:bodyclose // Body ownership transfers to GitHubProxyResponse and its caller.
	if err != nil {
		s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, http.StatusBadGateway, "deny", "github proxy request failed")
		return nil, pkgerrors.Internal("failed to proxy github request")
	}

	// A 401 means the cached installation token was revoked upstream — evict it
	// so the next proxied call re-mints. Deliberately NOT 403: proxied 403s are
	// routinely per-endpoint permission or secondary-rate-limit denials, and
	// evicting on those would thrash the cache; a suspended installation's 403 is
	// covered by the webhook invalidation instead.
	if upstreamResp.StatusCode == http.StatusUnauthorized {
		invalidateCachedInstallationToken(installationToken.InstallationID)
	}

	s.insertAuditLog(ctx, resolved.AuditWorkflowRunID, resolved.AuditWorkflowRunIDValid, method, requestPath, upstreamResp.StatusCode, "allow", policyDecision.Reason)

	return &GitHubProxyResponse{
		StatusCode: upstreamResp.StatusCode,
		Headers:    upstreamResp.Header.Clone(),
		Body:       upstreamResp.Body,
	}, nil
}

func (s *GitHubProxyService) resolveRepositoryOwner(ctx context.Context, repository db.Repository) (string, error) {
	if repository.UserID.Valid {
		user, getUserErr := s.store.GetUserByID(ctx, repository.UserID.Int64)
		if getUserErr != nil {
			if stdErrors.Is(getUserErr, pgx.ErrNoRows) {
				return "", pkgerrors.NotFound("repository owner not found")
			}
			return "", pkgerrors.Internal("failed to resolve repository owner")
		}
		return user.Username, nil
	}

	if repository.OrgID.Valid {
		org, getOrgErr := s.store.GetOrgByID(ctx, repository.OrgID.Int64)
		if getOrgErr != nil {
			if stdErrors.Is(getOrgErr, pgx.ErrNoRows) {
				return "", pkgerrors.NotFound("repository owner not found")
			}
			return "", pkgerrors.Internal("failed to resolve repository owner")
		}
		return org.Name, nil
	}

	return "", pkgerrors.Internal("repository owner is not set")
}

func (s *GitHubProxyService) createInstallationToken(ctx context.Context, resolved gitHubProxyResolvedContext) (GitHubInstallationToken, error) {
	if resolved.UseImportedSourceInstallationID || resolved.TryImportedSourceInstallationID {
		importedIssuer, ok := s.tokenIssuer.(gitHubProxyImportedSourceTokenIssuer)
		if !ok {
			if resolved.UseImportedSourceInstallationID {
				return GitHubInstallationToken{}, pkgerrors.Internal("github proxy service unavailable")
			}
		} else {
			token, err := importedIssuer.CreateGitHubInstallationTokenForImportedSource(ctx, resolved.ActorUserID, resolved.RepositoryID, resolved.Owner, resolved.Repo)
			if err == nil {
				return token, nil
			}
			if !(resolved.TryImportedSourceInstallationID && !resolved.UseImportedSourceInstallationID && stdErrors.Is(err, errGitHubImportedSourceProvenanceNotFound)) {
				if stdErrors.Is(err, errGitHubImportedSourceProvenanceNotFound) {
					return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
				}
				return GitHubInstallationToken{}, err
			}
		}
	}
	if resolved.UseInternalRepoInstallationID {
		internalIssuer, ok := s.tokenIssuer.(gitHubProxyInternalRepoTokenIssuer)
		if !ok {
			return GitHubInstallationToken{}, pkgerrors.Internal("github proxy service unavailable")
		}
		return internalIssuer.CreateGitHubInstallationTokenForRepositoryOwner(ctx, resolved.RepoOwnerUserID, resolved.RepoOwnerOrgID, resolved.Owner, resolved.Repo)
	}
	return s.tokenIssuer.CreateGitHubInstallationToken(ctx, resolved.ActorUserID, resolved.Owner, resolved.Repo)
}

func (s *GitHubProxyService) buildUpstreamRequest(
	ctx context.Context,
	method string,
	requestPath string,
	requestHeaders map[string]string,
	body []byte,
	hasBody bool,
	installationToken string,
) (*http.Request, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") + requestPath

	var bodyReader io.Reader
	if hasBody {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, upstreamURL, bodyReader)
	if err != nil {
		return nil, pkgerrors.Internal("failed to build github proxy request")
	}

	for key, value := range requestHeaders {
		headerName := strings.TrimSpace(key)
		if headerName == "" || isRestrictedGitHubProxyRequestHeader(headerName) {
			continue
		}
		req.Header.Set(headerName, strings.TrimSpace(value))
	}

	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(installationToken))
	if strings.TrimSpace(req.Header.Get("Accept")) == "" {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
		req.Header.Set("User-Agent", "smithers-server")
	}
	if strings.TrimSpace(req.Header.Get("X-GitHub-Api-Version")) == "" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	if hasBody && strings.TrimSpace(req.Header.Get("Content-Type")) == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	return req, nil
}

func (s *GitHubProxyService) insertAuditLog(
	ctx context.Context,
	workflowRunID int64,
	workflowRunIDValid bool,
	method string,
	requestPath string,
	statusCode int,
	decision string,
	reason string,
) {
	if !workflowRunIDValid {
		slog.Info("github proxy repo request",
			"auth_source", "server_github_app_installation",
			"method", method,
			"path", requestPath,
			"status_code", statusCode,
			"decision", decision,
			"failure_category", gitHubProxyFailureCategory(statusCode, decision),
			"reason", reason,
		)
		return
	}
	if err := s.store.InsertGithubProxyAuditLog(ctx, db.InsertGithubProxyAuditLogParams{
		WorkflowRunID: workflowRunID,
		Method:        method,
		Path:          requestPath,
		StatusCode:    int32(statusCode),
		Decision:      decision,
		Reason:        reason,
	}); err != nil {
		slog.Warn("failed to insert github proxy audit log",
			"workflow_run_id", workflowRunID,
			"method", method,
			"path", requestPath,
			"status_code", statusCode,
			"decision", decision,
			"error", err,
		)
	}
}

func gitHubProxyFailureCategory(statusCode int, decision string) string {
	if strings.EqualFold(strings.TrimSpace(decision), "allow") && statusCode >= http.StatusOK && statusCode < http.StatusMultipleChoices {
		return ""
	}
	switch {
	case statusCode == http.StatusUnauthorized:
		return "auth"
	case statusCode == http.StatusForbidden:
		return "permission"
	case statusCode == http.StatusNotFound:
		return "not_found"
	case statusCode == http.StatusTooManyRequests:
		return "rate_limit"
	case statusCode >= http.StatusBadGateway:
		return "upstream"
	case statusCode >= http.StatusBadRequest:
		return "request"
	default:
		return "unknown"
	}
}

func normalizeGitHubProxyMethodAndPath(method string, requestPath string) (string, string, error) {
	normalizedMethod := strings.ToUpper(strings.TrimSpace(method))
	switch normalizedMethod {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return "", "", pkgerrors.BadRequest("unsupported method")
	}

	trimmedPath := strings.TrimSpace(requestPath)
	if trimmedPath == "" {
		return "", "", pkgerrors.BadRequest("path is required")
	}

	parsed, err := url.ParseRequestURI(trimmedPath)
	if err != nil || parsed == nil {
		return "", "", pkgerrors.BadRequest("invalid path")
	}
	if strings.TrimSpace(parsed.Scheme) != "" || strings.TrimSpace(parsed.Host) != "" {
		return "", "", pkgerrors.BadRequest("path must be relative to the github api")
	}

	cleanPath := normalizeGitHubProxyPath(parsed.Path)

	if strings.TrimSpace(parsed.RawQuery) != "" {
		cleanPath = cleanPath + "?" + parsed.RawQuery
	}

	return normalizedMethod, cleanPath, nil
}

func gitHubProxyRetryAfterSeconds(retryAfter time.Duration) int {
	retryAfterSeconds := int(math.Ceil(retryAfter.Seconds()))
	if retryAfterSeconds < 1 {
		return 1
	}
	return retryAfterSeconds
}

func normalizeGitHubProxyBody(raw json.RawMessage) ([]byte, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, false, nil
	}
	if !json.Valid(trimmed) {
		return nil, false, pkgerrors.BadRequest("body must be valid json")
	}
	return trimmed, true, nil
}

func isRestrictedGitHubProxyRequestHeader(headerName string) bool {
	switch strings.ToLower(strings.TrimSpace(headerName)) {
	case "authorization",
		"host",
		"content-length",
		"connection",
		"proxy-connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"cookie":
		return true
	default:
		return false
	}
}

func statusCodeFromError(err error) int {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) {
		return apiErr.Status
	}
	return http.StatusInternalServerError
}
