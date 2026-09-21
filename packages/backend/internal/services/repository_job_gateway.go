package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/previewgateway"
)

type RepositoryJobRPCError struct {
	Tag string
}

func (e *RepositoryJobRPCError) Error() string {
	return "workspace control refused repository job: " + e.Tag
}

// workspaceGatewayMount maps one allowed control procedure to the gateway
// mount that serves it, and reports whether the procedure is allowed at all.
//
// The allowlist stays an allowlist. Naming the capability is the caller's
// business — a workspace host serves more than repository jobs — but which
// procedures plue may drive over a server-held credential is not, so a new
// procedure is one more entry here and a review of what it can do.
func workspaceGatewayMount(procedure string) (string, bool) {
	switch procedure {
	case "Plan", "Run", "Signal", "List":
		return "/rpc", true
	// The read path and the one composite mutation the gateway serves.
	// Projection.Snapshot is how a caller streams a run it started: the
	// transcript, events and tree of one runId, on the surface the host
	// already mounts rather than a second transport.
	case "Approval.Submit", "Projection.Snapshot":
		return "/projections", true
	default:
		return "", false
	}
}

// CallRepositoryJob uses the same repository/workspace/owner binding as the UI
// gateway, including resume and access checks. Credentials remain server-held.
//
// `capability` is the workspace capability the caller needs the host to
// advertise, checked by requireWorkspaceGatewayCapability exactly as before.
// It is a parameter rather than a constant because one workspace host serves
// several doors: repository jobs and a dispatched agent turn reach the same
// already-running `smithers-coding-host serve`, and a caller that asked for
// the wrong capability must be refused rather than silently promoted.
func (s *RepoGatewayService) CallRepositoryJob(ctx context.Context, input RepoGatewayConnectionInput, capability string, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	if input.WorkspaceID == "" {
		return nil, pkgerrors.BadRequest("workspace gateway procedures require a bound workspace")
	}
	if strings.TrimSpace(capability) == "" {
		return nil, pkgerrors.BadRequest("a workspace gateway procedure must name the capability it needs")
	}
	input.RequiredCapability = capability
	mount, allowed := workspaceGatewayMount(procedure)
	if !allowed {
		return nil, pkgerrors.BadRequest("workspace gateway procedure is not allowed")
	}
	if s.healthProbeBaseURL == "" {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository job gateway transport is unavailable")
	}
	info, err := s.GetRepoGatewayConnectionInfo(ctx, input)
	if err != nil {
		return nil, err
	}
	if info.WorkspaceID != input.WorkspaceID || info.GatewayID == "" {
		return nil, pkgerrors.Forbidden("repository job gateway changed workspace")
	}
	endpoint := s.healthProbeBaseURL + "/__preview/" + repoGatewayDomain(info.GatewayID) + mount
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     previewRelayRoundTripper{token: s.previewRelayToken, next: http.DefaultTransport},
	}
	return callRepositoryJobRPC(ctx, client, endpoint, info.Token, procedure, payload)
}

// previewRelayRoundTripper stamps the preview gateway relay credential on
// every request it carries.
type previewRelayRoundTripper struct {
	token string
	next  http.RoundTripper
}

func (t previewRelayRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.token != "" {
		req = req.Clone(req.Context())
		req.Header.Set(previewgateway.RelayTokenHeader, t.token)
	}
	return t.next.RoundTrip(req)
}

func callRepositoryJobRPC(ctx context.Context, client *http.Client, endpoint, token, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]interface{}{"_tag": "Request", "id": 1, "tag": procedure, "payload": payload, "headers": []interface{}{}})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(append(body, '\n')))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("repository job gateway request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("repository job gateway answered HTTP %d", response.StatusCode)
	}
	reader := io.LimitReader(response.Body, (4<<20)+1)
	data, err := io.ReadAll(reader)
	if err != nil || len(data) > 4<<20 {
		return nil, fmt.Errorf("repository job gateway response exceeded its read limit")
	}
	var frame struct {
		Tag  string `json:"_tag"`
		Exit struct {
			Tag   string          `json:"_tag"`
			Value json.RawMessage `json:"value"`
			Cause json.RawMessage `json:"cause"`
		} `json:"exit"`
	}
	line := bytes.Split(bytes.TrimSpace(data), []byte{'\n'})[0]
	if json.Unmarshal(line, &frame) != nil || frame.Tag != "Exit" {
		return nil, fmt.Errorf("workspace returned an invalid control frame")
	}
	if frame.Exit.Tag == "Success" && len(frame.Exit.Value) > 0 {
		return frame.Exit.Value, nil
	}
	// Return a stable error type, never an arbitrary upstream body or a token.
	var causes []struct {
		Tag   string `json:"_tag"`
		Error struct {
			Tag string `json:"_tag"`
		} `json:"error"`
	}
	tag := "Failure"
	if json.Unmarshal(frame.Exit.Cause, &causes) == nil {
		for _, cause := range causes {
			if cause.Tag == "Fail" && strings.HasPrefix(cause.Error.Tag, "/control/") {
				tag = cause.Error.Tag
				break
			}
		}
	}
	return nil, &RepositoryJobRPCError{Tag: tag}
}
