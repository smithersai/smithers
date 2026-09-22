package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
	"golang.org/x/term"
)

const (
	localAuthStatusPath    = "/api/auth/local/status"
	localAuthBootstrapPath = "/api/auth/local/bootstrap"
	localAuthTokenPath     = "/api/auth/local/token"
)

var localOwnerTokenScopes = []string{
	"write:user",
	"write:repository",
	"write:workspace",
	"write:approval",
	"write:agent",
}

var (
	localAuthIsTerminal   = term.IsTerminal
	localAuthReadPassword = term.ReadPassword
	localAuthHTTPClient   = &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
)

type localAuthStatus struct {
	Enabled     bool   `json:"enabled"`
	Initialized bool   `json:"initialized"`
	Username    string `json:"username,omitempty"`
}

type localAuthTokenResponse struct {
	Token     string `json:"token"`
	TokenID   int64  `json:"token_id"`
	ExpiresAt string `json:"expires_at"`
	User      struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
}

func localOwnerAuthCommand() *incur.Cli {
	cmd := incur.New("local", incur.WithDescription("Manage single-owner authentication"))
	options := func() map[string]*incur.JSONSchema {
		return map[string]*incur.JSONSchema{
			"host":     stringSchema("Hostname or API origin (alias for --hostname)"),
			"hostname": stringSchema("Hostname or API origin"),
		}
	}
	cmd.Command("status", &incur.CommandDef{
		Description:   "Show owner setup status",
		OptionsSchema: objectSchema(nil, options()),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			target, err := localAuthTarget(ctx)
			if err != nil {
				return nil, err
			}
			var status localAuthStatus
			if err := localAuthRequest(target, http.MethodGet, localAuthStatusPath, nil, nil, &status); err != nil {
				return nil, err
			}
			result := map[string]any{"enabled": status.Enabled, "initialized": status.Initialized, "host": target.Host}
			if status.Username != "" {
				result["username"] = status.Username
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return fmt.Sprintf("enabled: %t\ninitialized: %t", status.Enabled, status.Initialized), nil
		},
	})
	credentialOptions := options()
	credentialOptions["username"] = stringSchema("Owner username")
	cmd.Command("login", &incur.CommandDef{
		Description:   "Log in to an owner backend",
		OptionsSchema: objectSchema(nil, credentialOptions),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return runLocalOwnerLogin(ctx, false)
		},
	})
	bootstrapOptions := options()
	bootstrapOptions["username"] = stringSchema("Owner username")
	cmd.Command("bootstrap", &incur.CommandDef{
		Description:   "Create and log in as the installation owner",
		OptionsSchema: objectSchema(nil, bootstrapOptions),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return runLocalOwnerLogin(ctx, true)
		},
	})
	return cmd
}

func localAuthTarget(ctx *incur.CommandContext) (AuthTarget, error) {
	hostname := firstNonEmpty(stringValue(ctx.Options["hostname"]), stringValue(ctx.Options["host"]))
	if hostname != "" {
		parsed, err := url.Parse(strings.TrimSpace(hostname))
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
			parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return AuthTarget{}, errors.New("Smithers API origin must be an absolute HTTP(S) origin without credentials, path, query, or fragment")
		}
		origin := parsed.Scheme + "://" + parsed.Host
		return AuthTarget{APIURL: origin, Host: hostFromURL(origin)}, nil
	}
	target, err := ResolveAuthTarget(nil)
	if err != nil {
		return AuthTarget{}, err
	}
	parsed, err := url.Parse(target.APIURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return AuthTarget{}, errors.New("Smithers API origin must be an absolute HTTP(S) origin without credentials, path, query, or fragment")
	}
	target.APIURL = parsed.Scheme + "://" + parsed.Host
	return target, nil
}

func localAuthSecret(envName, prompt string) (string, error) {
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		return value, nil
	}
	if localAuthIsTerminal(int(os.Stdin.Fd())) {
		_, _ = fmt.Fprint(os.Stderr, prompt)
		secret, err := localAuthReadPassword(int(os.Stdin.Fd()))
		_, _ = fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if value := strings.TrimSpace(string(secret)); value != "" {
			return value, nil
		}
		return "", errors.New("credential is required")
	}
	if envName != "SMITHERS_AUTH_PASSWORD" {
		return "", fmt.Errorf("%s is required when stdin is not a TTY", envName)
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<10))
	if err != nil {
		return "", err
	}
	if value := strings.TrimSpace(string(raw)); value != "" {
		return value, nil
	}
	return "", errors.New("password is required on stdin")
}

func runLocalOwnerLogin(ctx *incur.CommandContext, bootstrap bool) (any, error) {
	target, err := localAuthTarget(ctx)
	if err != nil {
		return nil, err
	}
	username := firstNonEmpty(stringValue(ctx.Options["username"]), os.Getenv("SMITHERS_AUTH_USERNAME"))
	if strings.TrimSpace(username) == "" {
		return nil, errors.New("--username or SMITHERS_AUTH_USERNAME is required")
	}
	password, err := localAuthSecret("SMITHERS_AUTH_PASSWORD", "Password: ")
	if err != nil {
		return nil, err
	}
	if bootstrap {
		bootstrapToken, err := localAuthSecret("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "Bootstrap token: ")
		if err != nil {
			return nil, err
		}
		if err := localAuthRequest(target, http.MethodPost, localAuthBootstrapPath,
			map[string]string{"username": username, "password": password},
			map[string]string{"X-Smithers-Bootstrap-Token": bootstrapToken}, nil); err != nil {
			return nil, err
		}
	}
	var token localAuthTokenResponse
	if err := localAuthRequest(target, http.MethodPost, localAuthTokenPath,
		map[string]any{
			"username": username,
			"password": password,
			"name":     "smithers-cli",
			"scopes":   localOwnerTokenScopes,
		}, nil, &token); err != nil {
		return nil, err
	}
	if strings.TrimSpace(token.Token) == "" || strings.TrimSpace(token.User.Username) == "" {
		return nil, errors.New("owner token response was incomplete")
	}
	persisted, err := PersistAuthToken(token.Token, map[string]string{
		"hostname": target.APIURL, "username": token.User.Username, "expiresAt": token.ExpiresAt,
	})
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"status": "logged_in", "host": persisted.Host, "user": token.User.Username,
		"expires_at": token.ExpiresAt, "token_id": token.TokenID,
	}
	if ctx.FormatExplicit {
		return result, nil
	}
	return fmt.Sprintf("Logged in to %s as %s", persisted.Host, token.User.Username), nil
}

func localAuthRequest(target AuthTarget, method, path string, body any, headers map[string]string, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, target.APIURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	response, err := localAuthHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &failure) == nil && failure.Message != "" {
			return &APIError{Method: method, Path: path, Status: response.StatusCode, Detail: failure.Message}
		}
		return &APIError{Method: method, Path: path, Status: response.StatusCode, Detail: strings.TrimSpace(string(raw))}
	}
	if output == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}
