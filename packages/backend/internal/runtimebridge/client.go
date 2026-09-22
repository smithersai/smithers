// Package runtimebridge implements the authenticated, versioned JSON adapter
// to the canonical TypeScript Flow/Control host.
package runtimebridge

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
)

const maxResponseBytes = 4 << 20

type Config struct {
	Endpoint   string
	Credential string
	HTTPClient *http.Client
}

// Error is a sanitized bridge refusal. It never includes request headers,
// payload bytes, or the bearer credential.
type Error struct {
	Code       string
	Message    string
	Retryable  bool
	HTTPStatus int
}

func (e *Error) Error() string {
	if e.Message == "" {
		return "flow runtime bridge: " + e.Code
	}
	return "flow runtime bridge: " + e.Code + ": " + e.Message
}

type Client struct {
	endpoint   string
	credential string
	http       *http.Client
}

func New(config Config) (*Client, error) {
	parsed, err := url.Parse(config.Endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("flow runtime bridge endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname())) {
		return nil, errors.New("flow runtime bridge requires HTTPS except on loopback")
	}
	if strings.TrimSpace(config.Credential) == "" {
		return nil, errors.New("flow runtime bridge credential is required")
	}
	base := config.HTTPClient
	if base == nil {
		base = &http.Client{Timeout: 30 * time.Second}
	}
	client := *base
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		endpoint:   strings.TrimRight(config.Endpoint, "/"),
		credential: config.Credential,
		http:       &client,
	}, nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type commandEnvelope struct {
	Protocol string `json:"protocol"`
	OK       bool   `json:"ok"`
	Value    struct {
		Operation             string                   `json:"operation"`
		ApplicationRequestID  string                   `json:"applicationRequestId"`
		OwnerGeneration       int64                    `json:"ownerGeneration,omitempty"`
		RuntimeArtifactDigest string                   `json:"runtimeArtifactDigest,omitempty"`
		SourceRevision        string                   `json:"sourceRevision,omitempty"`
		PlanID                string                   `json:"planId,omitempty"`
		Approval              json.RawMessage          `json:"approval,omitempty"`
		Receipt               ports.FlowRuntimeReceipt `json:"receipt"`
	} `json:"value"`
	Error wireError `json:"error"`
}

type observeEnvelope struct {
	Protocol string `json:"protocol"`
	OK       bool   `json:"ok"`
	Value    struct {
		Run        ports.FlowRuntimeRun     `json:"run"`
		Events     []ports.FlowRuntimeEvent `json:"events"`
		NextCursor string                   `json:"nextCursor"`
		HasMore    bool                     `json:"hasMore"`
		Terminal   bool                     `json:"terminal"`
	} `json:"value"`
	Error wireError `json:"error"`
}

type wireError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (c *Client) post(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return &Error{Code: "invalid_request", Message: "request could not be encoded"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return &Error{Code: "invalid_endpoint", Message: "runtime endpoint could not be addressed"}
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return &Error{Code: "transport", Message: "runtime host could not be reached", Retryable: true}
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return &Error{Code: "transport", Message: "runtime response could not be read", Retryable: true, HTTPStatus: response.StatusCode}
	}
	if len(responseBody) > maxResponseBytes {
		return &Error{Code: "invalid_response", Message: "runtime response exceeded the size limit", HTTPStatus: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var envelope struct {
			Protocol string    `json:"protocol"`
			Error    wireError `json:"error"`
		}
		if json.Unmarshal(responseBody, &envelope) == nil && envelope.Protocol == ports.FlowRuntimeProtocol && envelope.Error.Code != "" {
			return &Error{Code: envelope.Error.Code, Message: envelope.Error.Message, Retryable: envelope.Error.Retryable, HTTPStatus: response.StatusCode}
		}
		code := "http_refused"
		if response.StatusCode == http.StatusUnauthorized {
			code = "unauthorized"
		}
		return &Error{Code: code, Message: http.StatusText(response.StatusCode), Retryable: response.StatusCode >= 500, HTTPStatus: response.StatusCode}
	}
	if err := json.Unmarshal(responseBody, output); err != nil {
		return &Error{Code: "invalid_response", Message: "runtime response was not valid JSON", HTTPStatus: response.StatusCode}
	}
	return nil
}

func (c *Client) Identity(ctx context.Context) (ports.FlowRuntimeIdentity, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"/health", nil)
	if err != nil {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "invalid_endpoint", Message: "runtime endpoint could not be addressed"}
	}
	response, err := c.http.Do(request)
	if err != nil {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "transport", Message: "runtime host could not be reached", Retryable: true}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "health_refused", Message: http.StatusText(response.StatusCode),
			Retryable: response.StatusCode >= 500, HTTPStatus: response.StatusCode}
	}
	var health struct {
		RuntimeBridge ports.FlowRuntimeIdentity `json:"runtimeBridge"`
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "transport", Message: "runtime health could not be read", Retryable: true, HTTPStatus: response.StatusCode}
	}
	if len(body) > maxResponseBytes {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health exceeded the size limit", HTTPStatus: response.StatusCode}
	}
	if err := json.Unmarshal(body, &health); err != nil {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health was not valid JSON", HTTPStatus: response.StatusCode}
	}
	if health.RuntimeBridge.Protocol != ports.FlowRuntimeProtocol {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "incompatible_protocol", Message: "runtime protocol version is incompatible", HTTPStatus: response.StatusCode}
	}
	if !hexString(health.RuntimeBridge.RuntimeArtifactDigest, 64) || !hexString(health.RuntimeBridge.SourceRevision, 40) || health.RuntimeBridge.OwnerGeneration <= 0 {
		return ports.FlowRuntimeIdentity{}, &Error{Code: "invalid_response", Message: "runtime health identity is invalid", HTTPStatus: response.StatusCode}
	}
	return health.RuntimeBridge, nil
}

func hexString(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func checkEnvelope(protocol string, ok bool, failure wireError) error {
	if protocol != ports.FlowRuntimeProtocol {
		return &Error{Code: "incompatible_protocol", Message: "runtime protocol version is incompatible"}
	}
	if !ok {
		return &Error{Code: failure.Code, Message: failure.Message, Retryable: failure.Retryable}
	}
	return nil
}

func (c *Client) command(ctx context.Context, input any) (commandEnvelope, error) {
	var envelope commandEnvelope
	if err := c.post(ctx, "/runtime/v1/command", input, &envelope); err != nil {
		return envelope, err
	}
	if err := checkEnvelope(envelope.Protocol, envelope.OK, envelope.Error); err != nil {
		return envelope, err
	}
	return envelope, nil
}

func (c *Client) Launch(ctx context.Context, request ports.FlowRuntimeLaunch) (ports.FlowRuntimeLaunchResult, error) {
	input := struct {
		Protocol              string          `json:"protocol"`
		Operation             string          `json:"operation"`
		ApplicationRequestID  string          `json:"applicationRequestId"`
		Attempt               int64           `json:"attempt"`
		OwnerGeneration       int64           `json:"ownerGeneration"`
		RuntimeArtifactDigest string          `json:"runtimeArtifactDigest"`
		SourceRevision        string          `json:"sourceRevision"`
		FlowID                string          `json:"flowId"`
		Payload               json.RawMessage `json:"payload"`
	}{ports.FlowRuntimeProtocol, "launch", request.ApplicationRequestID, request.Attempt, request.OwnerGeneration,
		request.RuntimeArtifactDigest, request.SourceRevision, request.FlowID, request.Payload}
	envelope, err := c.command(ctx, input)
	if err != nil {
		return ports.FlowRuntimeLaunchResult{}, err
	}
	return ports.FlowRuntimeLaunchResult{
		ApplicationRequestID:  envelope.Value.ApplicationRequestID,
		OwnerGeneration:       envelope.Value.OwnerGeneration,
		RuntimeArtifactDigest: envelope.Value.RuntimeArtifactDigest,
		SourceRevision:        envelope.Value.SourceRevision,
		PlanID:                envelope.Value.PlanID,
		Approval:              envelope.Value.Approval,
		Receipt:               envelope.Value.Receipt,
	}, nil
}

func (c *Client) decision(ctx context.Context, operation string, request ports.FlowRuntimeDecision) (ports.FlowRuntimeMutationResult, error) {
	input := struct {
		Protocol             string          `json:"protocol"`
		Operation            string          `json:"operation"`
		ApplicationRequestID string          `json:"applicationRequestId"`
		OwnerGeneration      int64           `json:"ownerGeneration"`
		Approval             json.RawMessage `json:"approval"`
	}{ports.FlowRuntimeProtocol, operation, request.ApplicationRequestID, request.OwnerGeneration, request.Approval}
	return c.mutate(ctx, input)
}

func (c *Client) Approve(ctx context.Context, request ports.FlowRuntimeDecision) (ports.FlowRuntimeMutationResult, error) {
	return c.decision(ctx, "approve", request)
}

func (c *Client) Deny(ctx context.Context, request ports.FlowRuntimeDecision) (ports.FlowRuntimeMutationResult, error) {
	return c.decision(ctx, "deny", request)
}

func (c *Client) Signal(ctx context.Context, request ports.FlowRuntimeSignal) (ports.FlowRuntimeMutationResult, error) {
	input := struct {
		Protocol             string `json:"protocol"`
		Operation            string `json:"operation"`
		ApplicationRequestID string `json:"applicationRequestId"`
		OwnerGeneration      int64  `json:"ownerGeneration"`
		RunID                string `json:"runId"`
		Signal               struct {
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		} `json:"signal"`
	}{Protocol: ports.FlowRuntimeProtocol, Operation: "signal", ApplicationRequestID: request.ApplicationRequestID,
		OwnerGeneration: request.OwnerGeneration, RunID: request.RunID}
	input.Signal.Name = request.Name
	input.Signal.Payload = request.Payload
	return c.mutate(ctx, input)
}

func (c *Client) Steer(ctx context.Context, request ports.FlowRuntimeSteer) (ports.FlowRuntimeMutationResult, error) {
	steer := map[string]any{"kind": request.Kind}
	switch request.Kind {
	case "Message":
		steer["body"] = request.Body
	case "Seat":
		steer["seat"] = request.Seat
	case "Thinking":
		steer["thinking"] = request.Thinking
	case "Tools":
		steer["toolNames"] = request.ToolNames
	default:
		return ports.FlowRuntimeMutationResult{}, &Error{Code: "invalid_request", Message: "unsupported steer kind"}
	}
	input := map[string]any{
		"protocol": ports.FlowRuntimeProtocol, "operation": "steer",
		"applicationRequestId": request.ApplicationRequestID, "ownerGeneration": request.OwnerGeneration,
		"runId": request.RunID, "messageId": request.MessageID, "createdAt": request.CreatedAt, "steer": steer,
	}
	return c.mutate(ctx, input)
}

func (c *Client) lifecycle(ctx context.Context, operation string, request ports.FlowRuntimeLifecycle) (ports.FlowRuntimeMutationResult, error) {
	input := map[string]any{
		"protocol": ports.FlowRuntimeProtocol, "operation": operation,
		"applicationRequestId": request.ApplicationRequestID, "ownerGeneration": request.OwnerGeneration,
		"runId": request.RunID,
	}
	if request.Reason != "" {
		input["reason"] = request.Reason
	}
	return c.mutate(ctx, input)
}

func (c *Client) Cancel(ctx context.Context, request ports.FlowRuntimeLifecycle) (ports.FlowRuntimeMutationResult, error) {
	return c.lifecycle(ctx, "cancel", request)
}

func (c *Client) Resume(ctx context.Context, request ports.FlowRuntimeLifecycle) (ports.FlowRuntimeMutationResult, error) {
	return c.lifecycle(ctx, "resume", request)
}

func (c *Client) mutate(ctx context.Context, input any) (ports.FlowRuntimeMutationResult, error) {
	envelope, err := c.command(ctx, input)
	if err != nil {
		return ports.FlowRuntimeMutationResult{}, err
	}
	return ports.FlowRuntimeMutationResult{
		Operation: envelope.Value.Operation, ApplicationRequestID: envelope.Value.ApplicationRequestID, Receipt: envelope.Value.Receipt,
	}, nil
}

func (c *Client) Observe(ctx context.Context, runID, afterCursor string, limit int) (ports.FlowRuntimeObservation, error) {
	input := map[string]any{"protocol": ports.FlowRuntimeProtocol, "runId": runID}
	if afterCursor != "" {
		input["afterCursor"] = afterCursor
	}
	if limit > 0 {
		input["limit"] = limit
	}
	var envelope observeEnvelope
	if err := c.post(ctx, "/runtime/v1/observe", input, &envelope); err != nil {
		return ports.FlowRuntimeObservation{}, err
	}
	if err := checkEnvelope(envelope.Protocol, envelope.OK, envelope.Error); err != nil {
		return ports.FlowRuntimeObservation{}, err
	}
	return ports.FlowRuntimeObservation{
		Run: envelope.Value.Run, Events: envelope.Value.Events, NextCursor: envelope.Value.NextCursor,
		HasMore: envelope.Value.HasMore, Terminal: envelope.Value.Terminal,
	}, nil
}

var _ ports.FlowRuntime = (*Client)(nil)

// IsRetryable reports whether reconciliation may safely repeat an operation.
func IsRetryable(err error) bool {
	var bridgeError *Error
	return errors.As(err, &bridgeError) && bridgeError.Retryable
}

// ErrorCode returns the stable bridge code without exposing transport details.
func ErrorCode(err error) string {
	var bridgeError *Error
	if errors.As(err, &bridgeError) {
		return bridgeError.Code
	}
	return fmt.Sprintf("%T", err)
}
