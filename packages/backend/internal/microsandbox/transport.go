package microsandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

const maxErrorBodyDiscardBytes = 4096

type errorResponse struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type nestedErrorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// CreateSandbox creates a new sandbox.
//
// The controller can create the VM even when the call fails from the client's
// perspective: a 2xx response whose body decodes far enough to carry the sandbox
// id but then errors (schema drift / truncation). Returning that partial id
// together with the error made every caller responsible for cleanup — most
// dropped it and leaked running sandboxes. The client reaps the partial sandbox
// itself, so a non-nil error always means "no sandbox exists for the caller to clean up".
func (c *Client) createSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	var resp sandbox.CreateResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes", "/v1/sandboxes", req, &resp)
	if err != nil && strings.TrimSpace(resp.ID) != "" {
		// Best-effort, detached from the caller's (possibly canceled) context.
		delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if delErr := c.DeleteSandbox(delCtx, resp.ID); delErr != nil {
			slog.Warn("failed to delete partially created sandbox", "sandbox_id", resp.ID, "error", delErr)
		}
		return sandbox.CreateResult{}, err
	}
	return resp, err
}

// ForkSandbox creates a sandbox from a stopped sandbox disk.
func (c *Client) ForkSandbox(ctx context.Context, sourceSandboxID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	var resp sandbox.CreateResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sourceSandboxID+"/fork", "/v1/sandboxes/{id}/fork", req, &resp)
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	if strings.TrimSpace(resp.ID) == "" {
		return sandbox.CreateResult{}, errors.New("sandbox fork response did not include the created sandbox id")
	}
	return resp, nil
}

// InspectSandbox returns the current sandbox state.
func (c *Client) InspectSandbox(ctx context.Context, sandboxID string) (sandbox.Sandbox, error) {
	var resp sandbox.Sandbox
	err := c.doJSON(ctx, http.MethodGet, "/v1/sandboxes/"+sandboxID, "/v1/sandboxes/{id}", nil, &resp)
	return resp, err
}

// DeleteSandbox deletes a VM.
func (c *Client) DeleteSandbox(ctx context.Context, sandboxID string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/sandboxes/"+sandboxID, "/v1/sandboxes/{id}", nil, nil)
}

// PublishIngress routes an HTTPS hostname to a sandbox port.
func (c *Client) PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
	var resp sandbox.IngressRoute
	err := c.doJSON(ctx, http.MethodPost, "/v1/ingress/"+url.PathEscape(domain), "/v1/ingress/{domain}", req, &resp)
	return resp, err
}

// RevokeIngress removes a hostname-to-sandbox route.
func (c *Client) RevokeIngress(ctx context.Context, domain string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/ingress/"+url.PathEscape(domain), "/v1/ingress/{domain}", nil, nil)
}

// StartSandbox resumes or starts a VM.
func (c *Client) StartSandbox(ctx context.Context, sandboxID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
	var resp sandbox.StartResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/start", "/v1/sandboxes/{id}/start", req, &resp)
	return resp, err
}

// StopSandbox stops a VM.
func (c *Client) StopSandbox(ctx context.Context, sandboxID string) (sandbox.StopResult, error) {
	var resp sandbox.StopResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/stop", "/v1/sandboxes/{id}/stop", nil, &resp)
	return resp, err
}

// SuspendSandbox suspends a VM.
func (c *Client) SuspendSandbox(ctx context.Context, sandboxID string) (sandbox.SuspendResult, error) {
	var resp sandbox.SuspendResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/suspend", "/v1/sandboxes/{id}/suspend", nil, &resp)
	return resp, err
}

// Execute runs a command inside a sandbox and waits for completion.
func (c *Client) Execute(ctx context.Context, sandboxID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	var resp sandbox.ExecResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/exec", "/v1/sandboxes/{id}/exec", req, &resp)
	return resp, err
}

// SnapshotSandbox creates a snapshot from a running VM.
func (c *Client) SnapshotSandbox(ctx context.Context, sandboxID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	var resp sandbox.SnapshotResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/snapshot", "/v1/sandboxes/{id}/snapshot", req, &resp)
	return resp, err
}

// CreateSnapshot builds a reusable snapshot from a template.
func (c *Client) CreateSnapshot(ctx context.Context, req sandbox.CreateSnapshotRequest) (sandbox.CreateSnapshotResponse, error) {
	var resp sandbox.CreateSnapshotResponse
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/snapshots", "/v1/sandboxes/snapshots", req, &resp)
	return resp, err
}

// DeleteSnapshot deletes a reusable snapshot.
func (c *Client) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/sandboxes/snapshots/"+snapshotID, "/v1/sandboxes/snapshots/{id}", nil, nil)
}

// WriteFile writes content into an existing sandbox.
func (c *Client) WriteFile(ctx context.Context, sandboxID, filepath string, req sandbox.WriteFileRequest) error {
	escapedPath, err := sandbox.EscapeGuestPath(filepath)
	if err != nil {
		return err
	}
	return c.doJSON(ctx, http.MethodPut, "/v1/sandboxes/"+url.PathEscape(sandboxID)+"/files/"+escapedPath, "/v1/sandboxes/{id}/files/{path}", req, nil)
}

// CreateService creates a dynamic systemd unit in a sandbox.
func (c *Client) CreateService(ctx context.Context, sandboxID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	var resp sandbox.CreateServiceResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/services", "/v1/sandboxes/{id}/services", req, &resp)
	return resp, err
}

// CreateIdentity creates a sandbox access identity.
func (c *Client) CreateIdentity(ctx context.Context) (sandbox.Identity, error) {
	var resp sandbox.Identity
	err := c.doJSON(ctx, http.MethodPost, "/v1/access/identities", "/v1/access/identities", nil, &resp)
	return resp, err
}

// GrantAccess grants an identity access to a VM.
func (c *Client) GrantAccess(ctx context.Context, identityID, sandboxID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	var resp sandbox.AccessGrant
	err := c.doJSON(ctx, http.MethodPost, "/v1/access/identities/"+identityID+"/permissions/sandbox/"+sandboxID, "/v1/access/identities/{id}/permissions/sandbox/{sandbox_id}", req, &resp)
	return resp, err
}

// CreateIdentityToken mints an SSH-capable access token for an identity.
func (c *Client) CreateIdentityToken(ctx context.Context, identityID string) (sandbox.CreatedToken, error) {
	var resp sandbox.CreatedToken
	err := c.doJSON(ctx, http.MethodPost, "/v1/access/identities/"+identityID+"/tokens", "/v1/access/identities/{id}/tokens", nil, &resp)
	return resp, err
}

// RevokeAccessGrant invalidates all controller SSH grants resolving to a
// sandbox. Revocation events already carry sandbox ids, including grants
// minted by a different API process before a restart.
func (c *Client) RevokeAccessGrant(ctx context.Context, sandboxID string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/sandboxes/"+url.PathEscape(sandboxID)+"/access-grants", "/v1/sandboxes/{id}/access-grants", nil, nil)
}

// doJSON issues a request to path. endpointLabel is the templated form of
// path (e.g. "/v1/sandboxes/{id}/exec") used for metrics so per-VM paths do
// not explode Prometheus label cardinality.
func (c *Client) doJSON(ctx context.Context, method, path, endpointLabel string, body any, out any) error {
	startedAt := time.Now()
	defer func() {
		c.observeRequest(method, endpointLabel, time.Since(startedAt))
	}()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal %s request: %w", c.providerLabel(), err)
		}
	}

	mutation := method != http.MethodGet && method != http.MethodHead
	idempotencyKey := ""
	if mutation {
		var err error
		idempotencyKey, err = sandbox.RequestIdempotencyKey(ctx)
		if err != nil {
			return err
		}
	}
	createMutation := mutation && method == http.MethodPost &&
		(path == "/v1/sandboxes" || strings.HasSuffix(path, "/fork"))
	attempts := 1
	if mutation {
		// Controller idempotency makes a single transport-level retry safe when
		// the response is lost after the worker mutation committed. Both attempts
		// carry the same key and byte-identical request body.
		attempts = 2
	}
	if createMutation {
		// A worker can finish materializing while the controller's final DB write
		// fails. Retry the same logical create long enough for the worker's
		// immediate/periodic inventory heartbeat to confirm the bound identity.
		attempts = 7
	}
	resourceLink := sandbox.RequestResourceLink(ctx)
	for attempt := 0; attempt < attempts; attempt++ {
		var bodyReader io.Reader
		if body != nil {
			bodyReader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
		if err != nil {
			return fmt.Errorf("create %s request: %w", c.providerLabel(), err)
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if c.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.apiKey)
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		if resourceLink.Kind != "" || resourceLink.ID != "" {
			req.Header.Set(sandbox.ResourceKindHeader, resourceLink.Kind)
			req.Header.Set(sandbox.ResourceIDHeader, resourceLink.ID)
		}

		resp, requestErr := c.httpClient.Do(req)
		if requestErr != nil {
			if attempt+1 < attempts && ctx.Err() == nil {
				if createMutation {
					if waitErr := waitForCreateRetry(ctx, attempt); waitErr != nil {
						return waitErr
					}
				}
				continue
			}
			c.observeError(endpointLabel, "transport_error")
			return fmt.Errorf("%s request failed: %w", c.providerLabel(), requestErr)
		}
		var responseErr error
		func() {
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
				statusErr := parseStatusError(resp)
				statusErr.Provider = c.Name()
				c.observeError(endpointLabel, metricsErrorCode(resp.StatusCode))
				responseErr = statusErr
				return
			}
			if out == nil {
				discardErrorBody(resp.Body)
				return
			}
			if decodeErr := json.NewDecoder(resp.Body).Decode(out); decodeErr != nil {
				responseErr = fmt.Errorf("decode %s response: %w", c.providerLabel(), decodeErr)
			}
		}()
		if responseErr != nil && createMutation && attempt+1 < attempts && retryableCreateResponse(responseErr) {
			if waitErr := waitForCreateRetry(ctx, attempt); waitErr != nil {
				return waitErr
			}
			continue
		}
		return responseErr
	}
	return errors.New("sandbox request retry loop exhausted")
}

func retryableCreateResponse(err error) bool {
	var status *sandbox.StatusError
	if !errors.As(err, &status) {
		return false
	}
	return status.StatusCode >= http.StatusInternalServerError ||
		(status.StatusCode == http.StatusConflict && status.ErrorCode == "operation_in_progress")
}

func waitForCreateRetry(ctx context.Context, attempt int) error {
	delay := 250 * time.Millisecond
	for range min(attempt, 5) {
		delay *= 2
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) providerLabel() string {
	return string(c.Name())
}

func (c *Client) observeRequest(method, endpoint string, duration time.Duration) {
	if c == nil || c.observer == nil {
		return
	}
	c.observer.ObserveSandboxAPIRequest(method, endpoint, duration.Seconds())
}

func (c *Client) observeError(endpoint, errorCode string) {
	if c == nil || c.observer == nil {
		return
	}
	if strings.TrimSpace(errorCode) == "" {
		errorCode = "unknown"
	}
	c.observer.IncSandboxAPIErrors(endpoint, errorCode)
}

// metricsErrorCode maps an HTTP status to a closed set of error-code labels.
// The server's free-form error string must never be used as a metric label —
// unbounded values explode Prometheus cardinality.
func metricsErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusTooManyRequests:
		return "rate_limited"
	}
	switch {
	case status >= 500:
		return "server_error"
	case status >= 400:
		return "client_error"
	default:
		return "unexpected_status"
	}
}

func parseStatusError(resp *http.Response) *sandbox.StatusError {
	statusErr := &sandbox.StatusError{StatusCode: resp.StatusCode}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyDiscardBytes))
	if err != nil || len(body) == 0 {
		return statusErr
	}

	var payload errorResponse
	if json.Unmarshal(body, &payload) == nil {
		statusErr.ErrorCode = strings.TrimSpace(payload.Error)
		statusErr.Code = strings.TrimSpace(payload.Code)
		statusErr.Message = strings.TrimSpace(payload.Message)
		if statusErr.ErrorCode != "" || statusErr.Code != "" || statusErr.Message != "" {
			return statusErr
		}
	}

	// The controller uses a structured provider-neutral envelope:
	// {"error":{"code":"...","message":"..."}}.
	var nested nestedErrorResponse
	if json.Unmarshal(body, &nested) == nil {
		statusErr.ErrorCode = strings.TrimSpace(nested.Error.Code)
		statusErr.Code = statusErr.ErrorCode
		statusErr.Message = strings.TrimSpace(nested.Error.Message)
		if statusErr.ErrorCode != "" || statusErr.Message != "" {
			return statusErr
		}
	}

	statusErr.Message = strings.TrimSpace(string(body))
	return statusErr
}

func discardErrorBody(r io.Reader) {
	if r == nil {
		return
	}
	_, _ = io.CopyN(io.Discard, r, maxErrorBodyDiscardBytes)
}
