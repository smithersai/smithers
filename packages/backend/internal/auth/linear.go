package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type LinearClient struct {
	clientID     string
	clientSecret string
	redirectURL  string
	httpClient   *http.Client
}

func NewLinearClient(clientID, clientSecret, redirectURL string) *LinearClient {
	return &LinearClient{
		clientID:     strings.TrimSpace(clientID),
		clientSecret: strings.TrimSpace(clientSecret),
		redirectURL:  strings.TrimSpace(redirectURL),
		httpClient:   observability.NewHTTPClient(10 * time.Second),
	}
}

func (c *LinearClient) AuthorizationURL(state string) string {
	params := url.Values{}
	params.Set("client_id", c.clientID)
	params.Set("redirect_uri", c.redirectURL)
	params.Set("response_type", "code")
	params.Set("state", state)
	params.Set("scope", "read,write,issues:create,comments:create")
	params.Set("actor", "app")
	return "https://linear.app/oauth/authorize?" + params.Encode()
}

func (c *LinearClient) ExchangeCode(ctx context.Context, code string) (services.LinearTokenResult, error) {
	form := url.Values{}
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", c.redirectURL)
	form.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.linear.app/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("create linear oauth exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("linear oauth exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("decode linear oauth exchange response: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if payload.ErrorDesc != "" {
			return services.LinearTokenResult{}, fmt.Errorf("linear oauth exchange failed: %s", payload.ErrorDesc)
		}
		if payload.Error != "" {
			return services.LinearTokenResult{}, fmt.Errorf("linear oauth exchange failed: %s", payload.Error)
		}
		return services.LinearTokenResult{}, fmt.Errorf("linear oauth exchange failed with status %d", resp.StatusCode)
	}

	if strings.TrimSpace(payload.AccessToken) == "" {
		return services.LinearTokenResult{}, fmt.Errorf("linear oauth exchange returned empty access token")
	}

	var expiresAt time.Time
	if payload.ExpiresIn > 0 {
		expiresAt = time.Now().UTC().Add(time.Duration(payload.ExpiresIn) * time.Second)
	}

	return services.LinearTokenResult{
		AccessToken:  payload.AccessToken,
		RefreshToken: payload.RefreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

// ErrLinearRefreshTokenInvalid reports that Linear rejected the stored refresh
// token (OAuth invalid_grant), whatever the HTTP status. Retrying cannot
// succeed; the user must reconnect.
var ErrLinearRefreshTokenInvalid = errors.New("linear refresh token is invalid")

func linearOAuthErrorText(code, desc string) string {
	if desc != "" {
		return desc
	}
	return code
}

func (c *LinearClient) RefreshToken(ctx context.Context, refreshToken string) (services.LinearTokenResult, error) {
	form := url.Values{}
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	form.Set("refresh_token", strings.TrimSpace(refreshToken))
	form.Set("grant_type", "refresh_token")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.linear.app/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("create linear token refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("linear token refresh request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return services.LinearTokenResult{}, fmt.Errorf("decode linear token refresh response: %w", err)
	}

	if payload.Error == "invalid_grant" {
		return services.LinearTokenResult{}, fmt.Errorf("%w: %s", ErrLinearRefreshTokenInvalid, linearOAuthErrorText(payload.Error, payload.ErrorDesc))
	}
	if payload.Error != "" {
		return services.LinearTokenResult{}, fmt.Errorf("linear token refresh failed: %s", linearOAuthErrorText(payload.Error, payload.ErrorDesc))
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if payload.ErrorDesc != "" {
			return services.LinearTokenResult{}, fmt.Errorf("linear token refresh failed: %s", payload.ErrorDesc)
		}
		return services.LinearTokenResult{}, fmt.Errorf("linear token refresh failed with status %d", resp.StatusCode)
	}

	if strings.TrimSpace(payload.AccessToken) == "" {
		return services.LinearTokenResult{}, fmt.Errorf("linear token refresh returned empty access token")
	}

	var expiresAt time.Time
	if payload.ExpiresIn > 0 {
		expiresAt = time.Now().UTC().Add(time.Duration(payload.ExpiresIn) * time.Second)
	}

	return services.LinearTokenResult{
		AccessToken:  payload.AccessToken,
		RefreshToken: payload.RefreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

func (c *LinearClient) FetchViewer(ctx context.Context, accessToken string) (services.LinearViewer, error) {
	body := `{"query":"{ viewer { id email name } }"}`
	return linearGraphQL[services.LinearViewer](ctx, c.httpClient, accessToken, body, "viewer")
}

func (c *LinearClient) FetchTeams(ctx context.Context, accessToken string) ([]services.LinearTeam, error) {
	body := `{"query":"{ teams { nodes { id name key } } }"}`

	type teamsResult struct {
		Nodes []services.LinearTeam `json:"nodes"`
	}
	result, err := linearGraphQL[teamsResult](ctx, c.httpClient, accessToken, body, "teams")
	if err != nil {
		return nil, err
	}
	return result.Nodes, nil
}

// FetchIssue resolves a Linear identifier (for example, ENG-482) to the
// canonical issue ID and owning team used by the issue-link service.
func (c *LinearClient) FetchIssue(ctx context.Context, accessToken, identifier string) (services.LinearIssue, error) {
	query, err := json.Marshal(map[string]any{
		"query": `query Issue($identifier: String!) { issue(id: $identifier) { id identifier team { id name key } } }`,
		"variables": map[string]string{
			"identifier": strings.TrimSpace(identifier),
		},
	})
	if err != nil {
		return services.LinearIssue{}, fmt.Errorf("encode linear issue query: %w", err)
	}
	return linearGraphQL[services.LinearIssue](ctx, c.httpClient, accessToken, string(query), "issue")
}

func linearGraphQL[T any](ctx context.Context, client *http.Client, accessToken, body, dataKey string) (T, error) {
	var zero T

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.linear.app/graphql", strings.NewReader(body))
	if err != nil {
		return zero, fmt.Errorf("create linear graphql request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))

	resp, err := client.Do(req)
	if err != nil {
		return zero, fmt.Errorf("linear graphql request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return zero, fmt.Errorf("linear graphql request failed with status %d", resp.StatusCode)
	}

	var gqlResp struct {
		Data   map[string]json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gqlResp); err != nil {
		return zero, fmt.Errorf("decode linear graphql response: %w", err)
	}
	if len(gqlResp.Errors) > 0 {
		return zero, fmt.Errorf("linear graphql error: %s", gqlResp.Errors[0].Message)
	}

	raw, ok := gqlResp.Data[dataKey]
	if !ok {
		return zero, fmt.Errorf("linear graphql response missing %q field", dataKey)
	}

	var result T
	if err := json.Unmarshal(raw, &result); err != nil {
		return zero, fmt.Errorf("decode linear graphql %q: %w", dataKey, err)
	}
	return result, nil
}
