package smitherscli

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const expiredAdminLoginHint = "admin login expired; run `smithers auth login --admin`"

func adminLoginError(err error, token *ResolvedAuthToken) error {
	var apiErr *APIError
	if token == nil || !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		return err
	}
	record := readSmithersAuthRecordForTarget(token.AuthTarget)
	if record == nil || record.Token != token.Token {
		return err
	}
	expires, parseErr := time.Parse(time.RFC3339, record.ExpiresAt)
	if parseErr == nil && !time.Now().Before(expires) {
		return fmt.Errorf("%s: %w", expiredAdminLoginHint, err)
	}
	return err
}

func validateObserveURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("observe_url must be an absolute HTTPS URL (HTTP is allowed on loopback)")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return fmt.Errorf("observe_url requires HTTPS except on loopback")
	}
	return nil
}

func ObserveRequest(method, path string, body any, target string) (any, error) {
	token, err := RequireAuthToken(nil)
	if err != nil {
		return nil, err
	}
	base := LoadConfig().ObserveURL
	if err := validateObserveURL(base); err != nil {
		return nil, err
	}
	observeToken := *token
	observeToken.APIURL = strings.TrimRight(base, "/")
	headers := map[string]string{}
	if method != http.MethodGet {
		if strings.TrimSpace(target) == "" {
			return nil, fmt.Errorf("Observe mutation requires a confirmation target")
		}
		headers["X-Confirm"] = target
	}
	// Never forward the product PAT across a redirect, including same-host
	// redirects. A configured console must serve the documented JSON routes.
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	result, err := apiRequestWithHeaders(method, path, body, &observeToken, headers, client)
	return result, adminLoginError(err, token)
}
