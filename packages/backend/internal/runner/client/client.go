package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

const (
	defaultTimeout    = 10 * time.Second
	maxErrorBodyBytes = 4 << 10
)

type Config struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
	Timeout    time.Duration
}

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

type RegisterResponse struct {
	RunnerID int64 `json:"runner_id"`
	Task     *Task `json:"task,omitempty"`
}

type Task struct {
	ID             int64           `json:"id"`
	WorkflowRunID  int64           `json:"workflow_run_id"`
	RepositoryID   int64           `json:"repository_id"`
	WorkflowStepID int64           `json:"workflow_step_id"`
	Attempt        int32           `json:"attempt"`
	Payload        json.RawMessage `json:"payload"`
}

func New(cfg Config) (*Client, error) {
	baseURL := normalizeBaseURL(cfg.BaseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("runner API base URL is required")
	}
	if _, err := url.Parse(baseURL); err != nil {
		return nil, fmt.Errorf("invalid runner API base URL: %w", err)
	}

	token := strings.TrimSpace(cfg.Token)
	if token == "" {
		return nil, fmt.Errorf("runner API token is required")
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = observability.NewHTTPClient(defaultTimeout)
	}
	if cfg.Timeout > 0 {
		cloned := *httpClient
		cloned.Timeout = cfg.Timeout
		httpClient = &cloned
	} else if httpClient.Timeout == 0 {
		cloned := *httpClient
		cloned.Timeout = defaultTimeout
		httpClient = &cloned
	}

	return &Client{
		baseURL:    baseURL,
		token:      token,
		httpClient: httpClient,
	}, nil
}

func (c *Client) Register(ctx context.Context, name string, metadata json.RawMessage) (*RegisterResponse, error) {
	var resp RegisterResponse
	if err := c.doJSON(ctx, http.MethodPost, "/internal/runners/register", struct {
		Name     string          `json:"name"`
		Metadata json.RawMessage `json:"metadata,omitempty"`
	}{
		Name:     name,
		Metadata: metadata,
	}, http.StatusOK, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *Client) ClaimTask(ctx context.Context, runnerID int64) (*Task, error) {
	resp, statusCode, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/internal/runners/%d/claim", runnerID), nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	switch statusCode {
	case http.StatusOK:
		var task Task
		if err := json.NewDecoder(resp.Body).Decode(&task); err != nil {
			return nil, fmt.Errorf("decode claim task response: %w", err)
		}
		return &task, nil
	case http.StatusNoContent:
		return nil, nil
	default:
		return nil, unexpectedStatusError(statusCode, resp.Body)
	}
}

func (c *Client) Heartbeat(ctx context.Context, runnerID int64) error {
	return c.expectNoContent(ctx, http.MethodPost, fmt.Sprintf("/internal/runners/%d/heartbeat", runnerID), nil)
}

func (c *Client) TerminateRunner(ctx context.Context, runnerID int64) error {
	return c.expectNoContent(ctx, http.MethodPost, fmt.Sprintf("/internal/runners/%d/terminate", runnerID), nil)
}

func (c *Client) CompleteTask(ctx context.Context, taskID, runnerID int64, status, errorMessage string) error {
	body := map[string]any{
		"runner_id": runnerID,
		"status":    status,
	}
	if strings.TrimSpace(errorMessage) != "" {
		body["error"] = errorMessage
	}
	return c.expectNoContent(ctx, http.MethodPost, fmt.Sprintf("/internal/tasks/%d/complete", taskID), body)
}

func (c *Client) expectNoContent(ctx context.Context, method, path string, body any) error {
	resp, statusCode, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if statusCode != http.StatusNoContent {
		return unexpectedStatusError(statusCode, resp.Body)
	}
	return nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any, expectedStatus int, out any) error {
	resp, statusCode, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if statusCode != expectedStatus {
		return unexpectedStatusError(statusCode, resp.Body)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode API response: %w", err)
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, int, error) {
	var reqBody io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal API request: %w", err)
		}
		reqBody = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("build API request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("runner API request failed: %w", err)
	}

	return resp, resp.StatusCode, nil
}

func unexpectedStatusError(statusCode int, body io.Reader) error {
	message, err := readErrorBody(body)
	if err != nil {
		return fmt.Errorf("runner API returned %d", statusCode)
	}
	if message == "" {
		return fmt.Errorf("runner API returned %d", statusCode)
	}
	return fmt.Errorf("runner API returned %d: %s", statusCode, message)
}

func readErrorBody(body io.Reader) (string, error) {
	if body == nil {
		return "", nil
	}
	data, err := io.ReadAll(io.LimitReader(body, maxErrorBodyBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxErrorBodyBytes {
		data = data[:maxErrorBodyBytes]
	}
	return strings.TrimSpace(string(data)), nil
}

func normalizeBaseURL(raw string) string {
	baseURL := strings.TrimSpace(raw)
	baseURL = strings.TrimRight(baseURL, "/")
	baseURL = strings.TrimSuffix(baseURL, "/internal")
	return baseURL
}
