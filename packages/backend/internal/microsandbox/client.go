// Package microsandbox implements the Plue sandbox-provider contract against
// the self-hosted Microsandbox controller. Product services depend only on
// internal/sandbox types; upstream SDK types remain confined to workers.
package microsandbox

import (
	"context"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Client is the first-class Microsandbox provider adapter.
type Client struct {
	baseURL      string
	apiKey       string
	httpClient   *http.Client
	observer     sandbox.APIRequestObserver
	defaultImage string
}

type ClientOption func(*clientOptions)

type clientOptions struct {
	httpClient   *http.Client
	observer     sandbox.APIRequestObserver
	defaultImage string
}

func WithHTTPClient(client *http.Client) ClientOption {
	return func(options *clientOptions) { options.httpClient = client }
}

func WithAPIRequestObserver(observer sandbox.APIRequestObserver) ClientOption {
	return func(options *clientOptions) { options.observer = observer }
}

func WithDefaultImage(image string) ClientOption {
	return func(options *clientOptions) { options.defaultImage = strings.TrimSpace(image) }
}

func NewClient(controlURL, apiKey string, options ...ClientOption) *Client {
	configured := clientOptions{}
	for _, option := range options {
		option(&configured)
	}

	httpClient := configured.httpClient
	if httpClient == nil {
		httpClient = &http.Client{
			Transport: otelhttp.NewTransport(http.DefaultTransport),
			Timeout:   35 * time.Minute,
		}
	}

	return &Client{
		baseURL:      strings.TrimRight(strings.TrimSpace(controlURL), "/"),
		apiKey:       strings.TrimSpace(apiKey),
		httpClient:   httpClient,
		observer:     configured.observer,
		defaultImage: configured.defaultImage,
	}
}

func (c *Client) Name() sandbox.ProviderName {
	return sandbox.ProviderMicrosandbox
}

func (c *Client) Capabilities() sandbox.Capabilities {
	return sandbox.Capabilities{
		sandbox.CapabilityExecution:         true,
		sandbox.CapabilityColdLifecycle:     true,
		sandbox.CapabilityColdSnapshots:     true,
		sandbox.CapabilityFileTransfer:      true,
		sandbox.CapabilityInteractiveAccess: true,
		sandbox.CapabilityIngress:           true,
	}
}

// CreateSandbox fills the deployment-pinned guest image when a product
// request does not carry one. The default is resolved by the API deployment,
// never by a worker downloading mutable configuration.
func (c *Client) CreateSandbox(ctx context.Context, request sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if strings.TrimSpace(request.Image) == "" {
		request.Image = c.defaultImage
	}
	return c.createSandbox(ctx, request)
}

func (c *Client) CreateIdentityForSandbox(ctx context.Context, _ string) (sandbox.Identity, error) {
	return c.CreateIdentity(ctx)
}

var _ sandbox.Provider = (*Client)(nil)
var _ sandbox.IdentityForSandboxProvider = (*Client)(nil)
var _ sandbox.AccessGrantRevoker = (*Client)(nil)

// RevokeEgress tears down the sandbox's egress proxy through the controller.
func (c *Client) RevokeEgress(ctx context.Context, sandboxID string, req sandbox.EgressRevokeRequest) (sandbox.EgressRevokeResult, error) {
	var resp sandbox.EgressRevokeResult
	err := c.doJSON(ctx, http.MethodPost, "/v1/sandboxes/"+sandboxID+"/egress/revoke", "/v1/sandboxes/{id}/egress/revoke", req, &resp)
	return resp, err
}

var _ sandbox.EgressRevoker = (*Client)(nil)
