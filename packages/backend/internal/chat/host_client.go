package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/smithersai/smithers/packages/backend/ports"
)

const ModelHostTurnPath = "/v1/chat/turn"

// maxRefusalDetailBytes bounds the host's error body carried into logs.
const maxRefusalDetailBytes = 512

// HTTPChatHost is the deployment neutral adapter to the packaged TypeScript
// model host. The grant contains an opaque callback capability, never a
// provider credential. Local composition points it at loopback; Plue points it
// at the same bundle on its isolated service network.
type HTTPChatHost struct {
	endpoint      *url.URL
	client        *http.Client
	authorization string
}

func NewHTTPChatHost(baseURL string, client *http.Client, authorization string) (*HTTPChatHost, error) {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("chat model host URL is invalid")
	}
	endpoint.Path = ModelHostTurnPath
	endpoint.RawPath = ""
	if client == nil {
		// A turn has no fixed length. The dispatcher context ends it.
		client = &http.Client{}
	}
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return nil, errors.New("chat model host authorization is required")
	}
	return &HTTPChatHost{endpoint: endpoint, client: client, authorization: authorization}, nil
}

func (h *HTTPChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	body, err := json.Marshal(grant)
	if err != nil {
		return fmt.Errorf("encode chat model grant: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create chat model request: %w", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+h.authorization)
	response, err := h.client.Do(request)
	if err != nil {
		return fmt.Errorf("run chat model host: %w", err)
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, maxRefusalDetailBytes))
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("chat model host refused grant with status %d: %s", response.StatusCode, strings.ToValidUTF8(strings.TrimSpace(string(detail)), "?"))
	}
	return nil
}
