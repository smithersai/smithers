package smitherscli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

type localAuthRoundTrip func(*http.Request) (*http.Response, error)

func (roundTrip localAuthRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func setLocalAuthTestTransport(t *testing.T, roundTrip localAuthRoundTrip) {
	t.Helper()
	previous := localAuthHTTPClient
	localAuthHTTPClient = &http.Client{
		Transport: roundTrip,
		Timeout:   30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	t.Cleanup(func() { localAuthHTTPClient = previous })
}

func localAuthResponse(request *http.Request, status int, body string, headers http.Header) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     headers,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}

func localAuthTestContext(origin string) *incur.CommandContext {
	return &incur.CommandContext{
		FormatExplicit: true,
		Options: map[string]any{
			"hostname": origin,
			"username": "owner",
		},
	}
}

func setLocalAuthTestCredentials(t *testing.T) {
	t.Helper()
	t.Setenv("SMITHERS_AUTH_USERNAME", "owner")
	t.Setenv("SMITHERS_AUTH_PASSWORD", "strong password")
	t.Setenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "bootstrap secret")
}

func TestLocalOwnerAuthBootstrapPersistsSharedCredential(t *testing.T) {
	setLocalAuthTestCredentials(t)
	const origin = "https://owner.example.test"
	var requests []string
	setLocalAuthTestTransport(t, func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.Path)
		if r.URL.Scheme+"://"+r.URL.Host != origin {
			t.Fatalf("request origin = %s", r.URL)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" {
			t.Fatalf("credential request leaked an auth or origin header: %#v", r.Header)
		}
		var body struct {
			Username string   `json:"username"`
			Password string   `json:"password"`
			Name     string   `json:"name"`
			Scopes   []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case localAuthBootstrapPath:
			if r.Method != http.MethodPost || r.Header.Get("X-Smithers-Bootstrap-Token") != "bootstrap secret" ||
				body.Username != "owner" || body.Password != "strong password" {
				t.Fatalf("bootstrap request = method %s, header %q, body %#v", r.Method, r.Header.Get("X-Smithers-Bootstrap-Token"), body)
			}
			return localAuthResponse(r, http.StatusOK, `{"user":{"id":1,"username":"owner"}}`, nil), nil
		case localAuthTokenPath:
			if r.Method != http.MethodPost || body.Name != "smithers-cli" || body.Username != "owner" || body.Password != "strong password" {
				t.Fatalf("token request = method %s, body %#v", r.Method, body)
			}
			if strings.Join(body.Scopes, ",") != strings.Join(localOwnerTokenScopes, ",") {
				t.Fatalf("token scopes = %#v", body.Scopes)
			}
			return localAuthResponse(r, http.StatusOK, `{"token":"smithers_local_test","token_id":7,"expires_at":"2026-10-01T00:00:00Z","user":{"id":1,"username":"owner"}}`, nil), nil
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		return nil, nil
	})
	commandsAuthCovSetConfig(t, origin)

	result, err := runLocalOwnerLogin(localAuthTestContext(origin), true)
	if err != nil {
		t.Fatalf("bootstrap login = %v", err)
	}
	if strings.Join(requests, ",") != localAuthBootstrapPath+","+localAuthTokenPath {
		t.Fatalf("requests = %#v", requests)
	}
	payload, ok := result.(map[string]any)
	if !ok || payload["status"] != "logged_in" || payload["user"] != "owner" {
		t.Fatalf("result = %#v", result)
	}
	resolved, err := ResolveAuthToken(map[string]string{"hostname": origin})
	if err != nil || resolved == nil || resolved.Token != "smithers_local_test" || resolved.APIURL != origin {
		t.Fatalf("persisted credential = %#v, %v", resolved, err)
	}
	if got := mustLoadConfig(t).APIURL; got != origin {
		t.Fatalf("configured origin = %q", got)
	}
}

func TestLocalOwnerAuthLoginAndStatusUseExactOrigin(t *testing.T) {
	setLocalAuthTestCredentials(t)
	const origin = "https://owner.example.test"
	var paths []string
	setLocalAuthTestTransport(t, func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case localAuthTokenPath:
			return localAuthResponse(r, http.StatusOK, `{"token":"smithers_local_test","token_id":7,"expires_at":"2026-10-01T00:00:00Z","user":{"id":1,"username":"owner"}}`, nil), nil
		case localAuthStatusPath:
			return localAuthResponse(r, http.StatusOK, `{"enabled":true,"initialized":true}`, nil), nil
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		return nil, nil
	})
	commandsAuthCovSetConfig(t, origin)

	if _, err := runLocalOwnerLogin(localAuthTestContext(origin), false); err != nil {
		t.Fatalf("login = %v", err)
	}
	out, err := authZServe(t, authCommand(), "local", "status", "--hostname", origin, "--json")
	if err != nil || !strings.Contains(out, `"initialized": true`) {
		t.Fatalf("status output = %q, %v", out, err)
	}
	if strings.Join(paths, ",") != localAuthTokenPath+","+localAuthStatusPath {
		t.Fatalf("requests = %#v", paths)
	}

	for _, invalid := range []string{
		"smithers.example",
		"https://user:pass@smithers.example",
		"https://smithers.example/api",
		"https://smithers.example?token=secret",
	} {
		if _, err := localAuthTarget(&incur.CommandContext{Options: map[string]any{"hostname": invalid}}); err == nil {
			t.Fatalf("localAuthTarget(%q) succeeded", invalid)
		}
	}
}

func TestLocalOwnerAuthRefusesRedirectedCredentialHandoff(t *testing.T) {
	setLocalAuthTestCredentials(t)
	const origin = "https://owner.example.test"
	redirected := 0
	setLocalAuthTestTransport(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "sink.example.test" {
			redirected++
			return localAuthResponse(r, http.StatusOK, `{}`, nil), nil
		}
		headers := make(http.Header)
		headers.Set("Location", "https://sink.example.test"+r.URL.Path)
		return localAuthResponse(r, http.StatusTemporaryRedirect, `{}`, headers), nil
	})
	commandsAuthCovSetConfig(t, origin)

	_, err := runLocalOwnerLogin(localAuthTestContext(origin), false)
	if err == nil || !strings.Contains(err.Error(), "307") {
		t.Fatalf("redirect error = %v", err)
	}
	if redirected != 0 {
		t.Fatalf("credential redirect reached the second origin %d times", redirected)
	}
}
