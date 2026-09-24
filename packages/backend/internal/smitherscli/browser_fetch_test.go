package smitherscli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// setTestCredentialStoreFile points the credential backend at a JSON file for
// the rest of the test. An empty path restores the system keyring lookup.
func setTestCredentialStoreFile(t *testing.T, path string) {
	t.Helper()
	previous := testCredentialStoreFile
	testCredentialStoreFile = path
	t.Cleanup(func() { testCredentialStoreFile = previous })
}

func setTestClaudeKeychainPayload(t *testing.T, payload string) {
	t.Helper()
	previous := testClaudeKeychainPayload
	testClaudeKeychainPayload = payload
	t.Cleanup(func() { testClaudeKeychainPayload = previous })
}

func setTestCodexAuthJSON(t *testing.T, raw string) {
	t.Helper()
	previous := testCodexAuthJSON
	testCodexAuthJSON = raw
	t.Cleanup(func() { testCodexAuthJSON = previous })
}

// setTestBrowserFetch makes browser login drive the login URL with an HTTP
// client instead of launching a browser, for the rest of the test.
func setTestBrowserFetch(t *testing.T, enabled bool) {
	t.Helper()
	previousOpen, previousSync := authOpenBrowser, authBrowserSynchronous
	if enabled {
		authOpenBrowser, authBrowserSynchronous = fetchBrowserLoginURL, true
	} else {
		authOpenBrowser, authBrowserSynchronous = openBrowser, false
	}
	t.Cleanup(func() { authOpenBrowser, authBrowserSynchronous = previousOpen, previousSync })
}

func fetchBrowserLoginURL(loginURL string) error {
	// One deadline covers the start request, redirect, and fragment POST. In
	// fetch mode these run synchronously before runBrowserLogin can select.
	ctx, cancel := context.WithTimeout(context.Background(), browserLoginTimeout)
	defer cancel()
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	loginReq, err := http.NewRequestWithContext(ctx, http.MethodGet, loginURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(loginReq)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	location := resp.Header.Get("Location")
	if location != "" {
		redirected, err := url.Parse(location)
		if err != nil {
			return err
		}
		base, _ := url.Parse(loginURL)
		redirected = base.ResolveReference(redirected)
		if redirected.Fragment != "" {
			params, _ := url.ParseQuery(redirected.Fragment)
			callbackURL := redirected.Scheme + "://" + redirected.Host + redirected.Path
			body, _ := json.Marshal(map[string]string{
				"token":          params.Get("token"),
				"username":       params.Get("username"),
				"email":          params.Get("email"),
				"expires_at":     params.Get("expires_at"),
				"callback_state": params.Get("callback_state"),
			})
			callbackReq, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, strings.NewReader(string(body)))
			if err != nil {
				return err
			}
			callbackReq.Header.Set("Content-Type", "application/json")
			callbackResp, err := http.DefaultClient.Do(callbackReq)
			if err != nil {
				return err
			}
			defer func() { _ = callbackResp.Body.Close() }()
			if callbackResp.StatusCode < 200 || callbackResp.StatusCode >= 300 {
				detail, _ := io.ReadAll(io.LimitReader(callbackResp.Body, 4096))
				return fmt.Errorf("browser test callback failed: %s: %s", callbackResp.Status, strings.TrimSpace(string(detail)))
			}
			return nil
		}
		followReq, err := http.NewRequestWithContext(ctx, http.MethodGet, redirected.String(), nil)
		if err != nil {
			return err
		}
		followed, err := http.DefaultClient.Do(followReq)
		if err != nil {
			return err
		}
		defer func() { _ = followed.Body.Close() }()
		if followed.StatusCode < 200 || followed.StatusCode >= 300 {
			return fmt.Errorf("browser test fetch failed: %s", followed.Status)
		}
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("browser test fetch failed: %s", resp.Status)
	}
	return nil
}

func mustLoadConfig(t *testing.T) Config {
	t.Helper()
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	return cfg
}

func mustLoadRawConfig(t *testing.T) RawConfig {
	t.Helper()
	raw, err := LoadRawConfig()
	if err != nil {
		t.Fatalf("LoadRawConfig: %v", err)
	}
	return raw
}
