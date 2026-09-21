package wsrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

const (
	defaultAPIRequestTimeout       = 10 * time.Second
	defaultAPIMaxAttempts          = 3
	defaultAPIRetryDelay           = 100 * time.Millisecond
	maxResponseBodyBytes     int64 = 1 << 20
	maxErrorBodyBytes        int64 = 4 << 10
)

var errResponseBodyTooLarge = errors.New("workspace runner API response body exceeded limit")

// APIClient handles HTTP communication with the Smithers API.
type APIClient struct {
	baseURL          string
	agentToken       string
	client           *http.Client
	requestTimeout   time.Duration
	maxAttempts      int
	retryDelay       time.Duration
	maxResponseBytes int64
	maxErrorBytes    int64
}

// SessionInfo represents a workspace session metadata.
type SessionInfo struct {
	ID                  string `json:"id"`
	Cols                int32  `json:"cols"`
	Rows                int32  `json:"rows"`
	Status              string `json:"status"`
	ClientSDP           string `json:"client_sdp"`
	ClientICECandidates string `json:"client_ice_candidates"`
}

// WorkspaceInfo represents a workspace metadata.
type WorkspaceInfo struct {
	ID              string        `json:"id"`
	Status          string        `json:"status"`
	PendingSessions []SessionInfo `json:"pending_sessions"`
}

// NewAPIClient creates a new API client.
func NewAPIClient(baseURL, agentToken string) *APIClient {
	transport, _ := http.DefaultTransport.(*http.Transport)
	if transport == nil {
		transport = &http.Transport{}
	}
	clonedTransport := transport.Clone()
	clonedTransport.ResponseHeaderTimeout = 5 * time.Second
	clonedTransport.ExpectContinueTimeout = time.Second

	return &APIClient{
		baseURL:    baseURL,
		agentToken: agentToken,
		client: &http.Client{
			Timeout:   defaultAPIRequestTimeout,
			Transport: observability.NewHTTPTransport(clonedTransport),
		},
		requestTimeout:   defaultAPIRequestTimeout,
		maxAttempts:      defaultAPIMaxAttempts,
		retryDelay:       defaultAPIRetryDelay,
		maxResponseBytes: maxResponseBodyBytes,
		maxErrorBytes:    maxErrorBodyBytes,
	}
}

func (c *APIClient) do(ctx context.Context, method, path string, body interface{}) ([]byte, error) {
	var reqBody []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = b
	}

	attempts := c.maxAttempts
	if attempts < 1 {
		attempts = 1
	}

	for attempt := 1; ; attempt++ {
		respBody, statusCode, err := c.doOnce(ctx, method, path, reqBody)
		if err == nil {
			return respBody, nil
		}

		if attempt == attempts || !shouldRetryAPIRequest(ctx, statusCode, err) {
			return nil, err
		}

		if waitErr := sleepWithContext(ctx, c.retryDelay*time.Duration(attempt)); waitErr != nil {
			return nil, waitErr
		}
	}
}

func (c *APIClient) doOnce(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	reqCtx := ctx
	cancel := func() {}
	if c.requestTimeout > 0 {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > c.requestTimeout {
			reqCtx, cancel = context.WithTimeout(ctx, c.requestTimeout)
		}
	}
	defer cancel()

	var reqBody io.Reader
	if len(body) > 0 {
		reqBody = bytes.NewReader(body)
	}

	req, err := http.NewRequestWithContext(reqCtx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, 0, err
	}

	req.Header.Set("Authorization", "Bearer "+c.agentToken)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("workspace runner API request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		respMessage, readErr := readErrorBody(resp.Body, c.maxErrorBytes)
		if readErr != nil {
			return nil, resp.StatusCode, fmt.Errorf("read API error response: %w", readErr)
		}
		if respMessage == "" {
			return nil, resp.StatusCode, fmt.Errorf("API error %d", resp.StatusCode)
		}
		return nil, resp.StatusCode, fmt.Errorf("API error %d: %s", resp.StatusCode, respMessage)
	}

	respBody, readErr := readResponseBody(resp.Body, c.maxResponseBytes)
	if readErr != nil {
		if errors.Is(readErr, errResponseBodyTooLarge) {
			return nil, resp.StatusCode, fmt.Errorf("API response exceeded %d bytes", c.maxResponseBytes)
		}
		return nil, resp.StatusCode, fmt.Errorf("read API response: %w", readErr)
	}

	return respBody, resp.StatusCode, nil
}

func readResponseBody(r io.Reader, limit int64) ([]byte, error) {
	if r == nil {
		return nil, nil
	}

	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errResponseBodyTooLarge
	}
	return body, nil
}

func readErrorBody(r io.Reader, limit int64) (string, error) {
	if r == nil {
		return "", nil
	}

	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return "", err
	}

	truncated := int64(len(body)) > limit
	if truncated {
		body = body[:limit]
	}

	msg := strings.TrimSpace(string(body))
	if truncated {
		if msg == "" {
			return "response body truncated", nil
		}
		return msg + " (truncated)", nil
	}

	return msg, nil
}

func shouldRetryAPIRequest(ctx context.Context, statusCode int, err error) bool {
	if ctx.Err() != nil {
		return false
	}

	switch statusCode {
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}

	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}

	var netErr net.Error
	return errors.As(err, &netErr)
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
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

// ReportWorkspaceStatus updates the overall workspace pod status (running/stopped/failed).
func (c *APIClient) ReportWorkspaceStatus(ctx context.Context, workspaceID string, status string) error {
	payload := map[string]string{"status": status}
	_, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/internal/workspace/%s/status", workspaceID), payload)
	return err
}

// GetWorkspace fetches the workspace metadata and any pending sessions.
func (c *APIClient) GetWorkspace(ctx context.Context, workspaceID string) (*WorkspaceInfo, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/internal/workspace/%s", workspaceID), nil)
	if err != nil {
		return nil, err
	}

	var info WorkspaceInfo
	if err := json.Unmarshal(resp, &info); err != nil {
		return nil, err
	}

	return &info, nil
}

// ReportStatus updates a specific session's status (running/stopped/failed).
func (c *APIClient) ReportStatus(ctx context.Context, sessionID string, status string) error {
	payload := map[string]string{"status": status}
	_, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/internal/workspace/sessions/%s/status", sessionID), payload)
	return err
}

// ExchangeWebRTC sends WebRTC SDP/ICE info to the API for the browser to pick up.
func (c *APIClient) ExchangeWebRTC(ctx context.Context, sessionID, sdp, iceCandidates string) (*SessionInfo, error) {
	payload := map[string]string{
		"sdp":            sdp,
		"ice_candidates": iceCandidates,
	}
	resp, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/internal/workspace/sessions/%s/webrtc", sessionID), payload)
	if err != nil {
		return nil, err
	}

	var sess SessionInfo
	if err := json.Unmarshal(resp, &sess); err != nil {
		return nil, err
	}

	return &sess, nil
}

// GetSession fetches a specific session's metadata, used to poll for the Client's Answer/ICE candidates.
func (c *APIClient) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	// The internal endpoints don't have GetSession yet, but the runner can use the same workspace polling
	// or we can add a quick get session to the internal routes if needed.
	// For now, assume it exists at /internal/workspace/sessions/{id}
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/internal/workspace/sessions/%s", sessionID), nil)
	if err != nil {
		return nil, err
	}

	var info SessionInfo
	if err := json.Unmarshal(resp, &info); err != nil {
		return nil, err
	}

	return &info, nil
}
