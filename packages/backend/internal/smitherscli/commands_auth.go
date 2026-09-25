package smitherscli

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	incur "github.com/smithersai/incur"
)

var (
	// browserLoginTimeout is a var (not const) so tests can shorten the wait.
	browserLoginTimeout = 5 * time.Minute
	authRuntimeGOOS     = runtime.GOOS
	authListen          = net.Listen
	authOpenBrowser     = openBrowser
	// authBrowserSynchronous is true when authOpenBrowser completes the whole
	// login round trip before returning. Only tests set it.
	authBrowserSynchronous = false
	authShutdownServer     = func(server *http.Server) {
		go func() { _ = server.Shutdown(context.Background()) }()
	}
)

const claudeSetupTokenStorageKey = "claude.subscription-token"

var claudeSetupTokenPattern = regexp.MustCompile(`\bsk-ant-oat[0-9a-z-]*-[A-Za-z0-9._-]+\b`)

type browserLoginResult struct {
	Host      string
	Token     string
	Username  string
	Email     string
	ExpiresAt string
}

func authCommand() *incur.Cli {
	cmd := incur.New("auth", incur.WithDescription("Manage authentication (login, logout, token)"))
	cmd.Command("login", &incur.CommandDef{
		Description: "Log in to Smithers",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"with-token": booleanSchema("Read token from stdin instead of browser flow", false),
			"admin":      booleanSchema("Request an expiring administrator token with browser consent", false),
			"observe":    booleanSchema("Sign in as an administrator and open Observe already authenticated", false),
			"ttl":        stringSchema("Admin token lifetime (5m to 12h; default 1h)"),
			"host":       stringSchema("Hostname or API URL (alias for --hostname)"),
			"hostname":   stringSchema("Hostname or API URL to authenticate with"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			hostname := firstNonEmpty(stringValue(ctx.Options["hostname"]), stringValue(ctx.Options["host"]))
			observe := ctx.Options["observe"] == true
			admin := ctx.Options["admin"] == true || observe
			cfg, err := LoadConfig()
			if err != nil {
				return nil, err
			}
			observeURL := cfg.ObserveURL
			if observe {
				if err := validateObserveURL(observeURL); err != nil {
					return nil, err
				}
			}
			ttl := stringValue(ctx.Options["ttl"])
			if !admin && ttl != "" {
				return nil, fmt.Errorf("--ttl requires --admin")
			}
			if admin && ctx.Options["with-token"] == true {
				return nil, fmt.Errorf("--admin requires browser consent and cannot be used with --with-token")
			}
			if admin {
				if err := validateAdminLoginTTL(ttl); err != nil {
					return nil, err
				}
			}
			if ctx.Options["with-token"] == true {
				tokenBytes, err := io.ReadAll(os.Stdin)
				if err != nil {
					return nil, err
				}
				token, err := validateToken(string(tokenBytes))
				if err != nil {
					return nil, err
				}
				target, err := PersistAuthToken(token, map[string]string{"hostname": hostname})
				if err != nil {
					return nil, err
				}
				resolved, _ := ResolveAuthToken(map[string]string{"hostname": hostname})
				source := AuthTokenSourceKeyring
				if resolved != nil {
					source = resolved.Source
				}
				result := map[string]any{
					"status":       "logged_in",
					"host":         target.Host,
					"token_source": source,
					"message":      fmt.Sprintf("Logged in to %s via %s", target.Host, FormatTokenSource(source)),
				}
				if ctx.FormatExplicit {
					return result, nil
				}
				return result["message"], nil
			}

			login, err := runBrowserLogin(map[string]string{"hostname": hostname, "admin": fmt.Sprint(admin), "ttl": ttl})
			if err != nil {
				return nil, err
			}
			target, err := PersistAuthToken(login.Token, map[string]string{
				"hostname":  hostname,
				"username":  login.Username,
				"email":     login.Email,
				"expiresAt": login.ExpiresAt,
				"admin":     fmt.Sprint(admin),
			})
			if err != nil {
				return nil, err
			}
			resolved, _ := ResolveAuthToken(map[string]string{"hostname": hostname})
			source := AuthTokenSourceKeyring
			if resolved != nil {
				source = resolved.Source
			}
			message := fmt.Sprintf("Logged in to %s via browser (%s)", target.Host, FormatTokenSource(source))
			if login.Username != "" {
				message = fmt.Sprintf("Logged in to %s as %s via browser (%s)", target.Host, login.Username, FormatTokenSource(source))
			}
			if admin {
				message += " (admin; expires at " + login.ExpiresAt + ")"
			}
			if observe {
				if err := openObserveSession(observeURL, login.Token); err != nil {
					return nil, fmt.Errorf("CLI sign-in succeeded, but Observe could not open: %w", err)
				}
				message += "; opened Observe"
			}
			result := map[string]any{
				"status":       "logged_in",
				"host":         target.Host,
				"user":         login.Username,
				"admin":        admin,
				"expires_at":   login.ExpiresAt,
				"token_source": source,
				"message":      message,
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return message, nil
		},
	})
	cmd.Command("logout", &incur.CommandDef{
		Description: "Log out of Smithers",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"hostname": stringSchema("Hostname or API URL to log out from"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			result, err := ClearAuthToken(map[string]string{"hostname": stringValue(ctx.Options["hostname"])})
			if err != nil {
				return nil, err
			}
			message := fmt.Sprintf("Logged out from %s", result.Host)
			if strings.TrimSpace(os.Getenv("SMITHERS_TOKEN")) != "" {
				message = fmt.Sprintf("Logged out from %s. SMITHERS_TOKEN env is still active for this shell.", result.Host)
			}
			payload := map[string]any{
				"status":  "logged_out",
				"host":    result.Host,
				"cleared": result.Cleared || result.LegacyCleared,
				"message": message,
			}
			if ctx.FormatExplicit {
				return payload, nil
			}
			return message, nil
		},
	})
	cmd.Command("status", &incur.CommandDef{
		Description: "Show authentication status",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"hostname": stringSchema("Hostname or API URL to inspect"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			status := GetAuthStatus(nil, map[string]string{"hostname": stringValue(ctx.Options["hostname"])})
			if !status.LoggedIn {
				pendingProcessExitCode = 1
			}
			if ctx.FormatExplicit {
				return status, nil
			}
			return formatAuthStatus(status), nil
		},
	})
	cmd.Command("token", &incur.CommandDef{
		Description: "Print the authentication token",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"hostname": stringSchema("Hostname or API URL to inspect"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			authToken, err := RequireAuthToken(map[string]string{"hostname": stringValue(ctx.Options["hostname"])})
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return map[string]any{
					"host":   authToken.Host,
					"source": FormatTokenSource(authToken.Source),
					"token":  authToken.Token,
				}, nil
			}
			fmt.Fprintf(os.Stderr, "Token source: %s (%s)\n", FormatTokenSource(authToken.Source), authToken.Host)
			_, _ = fmt.Fprintln(os.Stdout, authToken.Token)
			return nil, nil
		},
	})
	cmd.Group("claude", claudeAuthCommand())
	cmd.Group("local", localOwnerAuthCommand())
	registerProviderConnectionCommands(cmd)
	return cmd
}

func formatAuthStatus(status AuthStatusResult) string {
	lines := []string{
		fmt.Sprintf("logged_in: %t", status.LoggedIn),
		"api_url: " + toonScalar(status.APIURL, true),
		"host: " + toonScalar(status.Host, true),
		fmt.Sprintf("token_set: %t", status.TokenSet),
	}
	if status.TokenSource != "" {
		lines = append(lines, "token_source: "+toonScalar(FormatTokenSource(status.TokenSource), true))
	}
	if status.User != "" {
		lines = append(lines, "user: "+toonScalar(status.User, true))
	}
	if status.Username != "" && status.Username != status.User {
		lines = append(lines, "username: "+toonScalar(status.Username, true))
	}
	if status.Email != "" {
		lines = append(lines, "email: "+toonScalar(status.Email, true))
	}
	lines = append(lines, fmt.Sprintf("admin: %t", status.Admin))
	if status.TimeLeft != "" {
		lines = append(lines, "time_left: "+status.TimeLeft)
	}
	if status.ExpiresAt != "" {
		lines = append(lines, "expires_at: "+toonScalar(status.ExpiresAt, true))
	}
	if status.Message != "" {
		lines = append(lines, "message: "+toonScalar(status.Message, true))
	}
	return strings.Join(lines, "\n")
}

func validateToken(input string) (string, error) {
	token := strings.TrimSpace(input)
	if token == "" {
		return "", fmt.Errorf("no token provided on stdin")
	}
	if strings.HasPrefix(token, "smithers_") || isLikelyJWT(token) {
		return token, nil
	}
	return "", fmt.Errorf(`Invalid token. Tokens must start with "smithers_" or be a JWT.`)
}

func claudeAuthCommand() *incur.Cli {
	cmd := incur.New("claude", incur.WithDescription("Manage Claude Code authentication"))
	cmd.Command("login", &incur.CommandDef{
		Description: "Store a Claude setup token from stdin",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Also push the token to this repository's secrets (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			fmt.Fprintln(os.Stderr, "Paste the Claude setup token from `claude setup-token`, then press Ctrl-D.")
			raw, err := readStdinText("Claude setup token", false)
			if err != nil {
				return nil, err
			}
			token, err := validateClaudeSetupToken(raw)
			if err != nil {
				return nil, err
			}
			if err := StoreToken(claudeSetupTokenStorageKey, token); err != nil {
				return nil, err
			}
			resolved := resolveClaudeAuth()
			activeSource := "unknown source"
			if resolved != nil {
				activeSource = resolved.Source
			}
			result := map[string]any{
				"status":        "logged_in",
				"stored_token":  true,
				"active_source": activeSource,
			}
			// The setup token is a personal subscription credential. Push it into
			// repository secrets only when the caller names the repository;
			// never infer one from the working directory's remotes.
			if repo := strings.TrimSpace(stringValue(ctx.Options["repo"])); repo != "" {
				pushed, err := pushClaudeAuthSecret(repo, &resolvedClaudeToken{EnvKey: "ANTHROPIC_AUTH_TOKEN", Source: "stored Claude subscription token", Token: token})
				if err != nil {
					return nil, err
				}
				result["pushed_secret"] = pushed["secret_name"]
				result["pushed_repo"] = pushed["repo"]
				result["message"] = fmt.Sprintf("Stored Claude setup token in keyring and pushed %s to %s.", pushed["secret_name"], pushed["repo"])
			} else if activeSource == "stored Claude subscription token" {
				result["message"] = "Stored Claude setup token in keyring"
			} else {
				result["message"] = "Stored Claude setup token in keyring. Active auth remains " + activeSource + "."
			}
			return result, nil
		},
	})
	cmd.Command("logout", &incur.CommandDef{
		Description: "Clear the stored Claude setup token",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			cleared := DeleteStoredToken(claudeSetupTokenStorageKey)
			resolved := resolveClaudeAuth()
			var activeSource any
			if resolved != nil {
				activeSource = resolved.Source
			}
			message := "No stored Claude setup token found"
			if activeSource != nil {
				if cleared {
					message = "Cleared stored Claude setup token. Active auth remains " + stringValue(activeSource) + "."
				} else {
					message = "No stored Claude setup token found. Active auth remains " + stringValue(activeSource) + "."
				}
			} else if cleared {
				message = "Cleared stored Claude setup token"
			}
			return map[string]any{"status": "logged_out", "cleared": cleared, "active_source": activeSource, "message": message}, nil
		},
	})
	cmd.Command("status", &incur.CommandDef{
		Description: "Show Claude Code authentication status",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			resolved := resolveClaudeAuth()
			storedToken, _ := LoadStoredToken(claudeSetupTokenStorageKey)
			stored := strings.TrimSpace(storedToken) != ""
			result := map[string]any{
				"configured":       resolved != nil,
				"stored_token_set": stored,
				"message":          "Claude Code auth is not configured",
			}
			if resolved != nil {
				result["source"] = resolved.Source
				result["auth_kind"] = resolved.EnvKey
				result["message"] = "Claude Code auth is configured via " + resolved.Source
			}
			return result, nil
		},
	})
	cmd.Command("token", &incur.CommandDef{
		Description: "Print the Claude Code token or API key in use",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			resolved, err := getResolvedClaudeAuthToken()
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return map[string]any{"env_key": resolved.EnvKey, "source": resolved.Source, "token": resolved.Token}, nil
			}
			fmt.Fprintf(os.Stderr, "Token source: %s (%s)\n", resolved.Source, resolved.EnvKey)
			_, _ = fmt.Fprintln(os.Stdout, resolved.Token)
			return nil, nil
		},
	})
	cmd.Command("push", &incur.CommandDef{
		Description: "Push the active Claude Code credential into repository secrets",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			resolved, err := getResolvedClaudeAuthToken()
			if err != nil {
				return nil, err
			}
			pushed, err := pushClaudeAuthSecret(stringValue(ctx.Options["repo"]), resolved)
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"status":      "pushed",
				"repo":        pushed["repo"],
				"secret_name": pushed["secret_name"],
				"source":      pushed["source"],
				"message":     fmt.Sprintf("Pushed %s from %s to %s.", pushed["secret_name"], pushed["source"], pushed["repo"]),
			}, nil
		},
	})
	return cmd
}

func validateClaudeSetupToken(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", fmt.Errorf("no Claude setup token provided on stdin")
	}
	token := claudeSetupTokenPattern.FindString(input)
	if token == "" {
		return "", fmt.Errorf("Invalid Claude setup token. Run `claude setup-token` and provide the resulting sk-ant-oat token.")
	}
	return strings.TrimSpace(token), nil
}

type resolvedClaudeToken struct {
	EnvKey string
	Source string
	Token  string
}

func resolveClaudeAuth() *resolvedClaudeToken {
	if token := strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")); token != "" {
		return &resolvedClaudeToken{EnvKey: "ANTHROPIC_AUTH_TOKEN", Source: "ANTHROPIC_AUTH_TOKEN env", Token: token}
	}
	if token, _ := LoadStoredToken(claudeSetupTokenStorageKey); strings.TrimSpace(token) != "" {
		token = strings.TrimSpace(token)
		return &resolvedClaudeToken{EnvKey: "ANTHROPIC_AUTH_TOKEN", Source: "stored Claude subscription token", Token: token}
	}
	if key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")); key != "" {
		return &resolvedClaudeToken{EnvKey: "ANTHROPIC_API_KEY", Source: "ANTHROPIC_API_KEY env", Token: key}
	}
	return nil
}

func describeClaudeAuthAvailability() string {
	return strings.Join([]string{
		"no Claude Code auth found.",
		"Run `claude setup-token | smithers auth claude login`.",
		"Or set `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`.",
		"Or sign in with Claude Code locally (`claude login`).",
	}, "\n")
}

func getResolvedClaudeAuthToken() (*resolvedClaudeToken, error) {
	resolved := resolveClaudeAuth()
	if resolved == nil || resolved.Token == "" {
		return nil, fmt.Errorf("%s", describeClaudeAuthAvailability())
	}
	return resolved, nil
}

func pushClaudeAuthSecret(repoOverride string, resolved *resolvedClaudeToken) (map[string]any, error) {
	owner, repo, err := ResolveRepoRef(repoOverride)
	if err != nil {
		return nil, err
	}
	if _, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/secrets", owner, repo), map[string]any{
		"name":  resolved.EnvKey,
		"value": resolved.Token,
	}, nil); err != nil {
		return nil, err
	}
	return map[string]any{"repo": owner + "/" + repo, "secret_name": resolved.EnvKey, "source": resolved.Source}, nil
}

func isLikelyJWT(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			if !(r >= 'A' && r <= 'Z') && !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && r != '_' && r != '-' {
				return false
			}
		}
	}
	return true
}

func browserCandidates(loginURL string) [][]string {
	switch authRuntimeGOOS {
	case "darwin":
		return [][]string{{"open", loginURL}}
	case "windows":
		return [][]string{{"cmd.exe", "/c", "start", "", loginURL}}
	default:
		return [][]string{{"xdg-open", loginURL}, {"gio", "open", loginURL}}
	}
}

func openBrowser(loginURL string) error {
	for _, candidate := range browserCandidates(loginURL) {
		if candidate[0] != "cmd.exe" {
			if _, err := exec.LookPath(candidate[0]); err != nil {
				continue
			}
		}
		cmd := exec.Command(candidate[0], candidate[1:]...)
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	return fmt.Errorf("no browser launcher is available")
}

func successHTML(host, username string) string {
	title := "Logged in"
	if username != "" {
		title = "Logged in as " + username
	}
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Smithers login complete</title></head><body><h1>" +
		escapeHTML(title) + "</h1><p>Your Smithers CLI token for <code>" + escapeHTML(host) +
		"</code> was received.</p><p>You can close this tab and return to the terminal.</p></body></html>"
}

func callbackBridgeHTML(host string) string {
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Completing Smithers login...</title></head><body><main><h1>Completing login for " +
		escapeHTML(host) + "...</h1><p>You can close this tab after the CLI confirms the login.</p></main><script>const params = new URLSearchParams(window.location.hash.slice(1));fetch('/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:params.get('token')??'',username:params.get('username')??'',email:params.get('email')??'',expires_at:params.get('expires_at')??'',callback_state:params.get('callback_state')??''})}).then(async response=>{const text=await response.text();document.open();document.write(text);document.close();}).catch(error=>{document.body.innerHTML='<main><h1>Login failed</h1><p>'+String(error)+'</p></main>';});</script></body></html>"
}

func escapeHTML(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return replacer.Replace(value)
}

func validateAdminLoginTTL(raw string) error {
	if raw == "" {
		return nil
	}
	ttl, err := time.ParseDuration(raw)
	if err != nil || ttl < 5*time.Minute || ttl > 12*time.Hour {
		return fmt.Errorf("--ttl must be a Go duration between 5m and 12h")
	}
	return nil
}

func runBrowserLogin(options map[string]string) (browserLoginResult, error) {
	if options["admin"] == "true" {
		if err := validateAdminLoginTTL(options["ttl"]); err != nil {
			return browserLoginResult{}, err
		}
	}
	target, err := authTargetResolver(options)
	if err != nil {
		return browserLoginResult{}, err
	}

	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return browserLoginResult{}, fmt.Errorf("generate callback state: %w", err)
	}
	callbackState := base64.RawURLEncoding.EncodeToString(nonce[:])

	listener, err := authListen("tcp", "127.0.0.1:0")
	if err != nil {
		return browserLoginResult{}, err
	}
	defer func() { _ = listener.Close() }()
	port := listener.Addr().(*net.TCPAddr).Port
	resultCh := make(chan browserLoginResult, 1)
	errCh := make(chan error, 1)
	server := &http.Server{}
	finished := make(chan struct{})
	var callbackMu sync.Mutex

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-finished:
			return
		default:
		}
		resolve := func(token, username, email, expiresAt string) {
			validated, err := validateToken(token)
			if err != nil {
				errCh <- err
				close(finished)
				http.Error(w, "Invalid token", http.StatusBadRequest)
				authShutdownServer(server)
				return
			}
			resultCh <- browserLoginResult{
				Host:      target.Host,
				Token:     validated,
				Username:  username,
				Email:     email,
				ExpiresAt: expiresAt,
			}
			close(finished)
			w.Header().Set("content-type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, successHTML(target.Host, username))
			authShutdownServer(server)
		}

		if r.Method == http.MethodGet {
			// The legitimate flow delivers the token in the URL fragment (#token=...),
			// which the browser never sends to the server; the bridge JS reads it and
			// POSTs it back as application/json. NEVER resolve a token from the query
			// string — a cross-site <img src=".../callback?token=attacker"> would
			// otherwise fixate the attacker's token into the CLI (login CSRF).
			w.Header().Set("content-type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, callbackBridgeHTML(target.Host))
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Require application/json. A cross-origin no-cors fetch (a hostile page's only
		// way to POST to this loopback endpoint) cannot set that content type, so this
		// blocks token fixation via a forged cross-site POST while still allowing the
		// same-origin bridge, which sends application/json. A forged fragment navigation
		// can also invoke that bridge, so the per-login state must match below.
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "application/json") {
			http.Error(w, "Unsupported content type", http.StatusUnsupportedMediaType)
			return
		}
		var payload struct {
			Token         string `json:"token"`
			Username      string `json:"username"`
			Email         string `json:"email"`
			ExpiresAt     string `json:"expires_at"`
			CallbackState string `json:"callback_state"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload)
		// Reject unsolicited callbacks without consuming the pending login.
		if subtle.ConstantTimeCompare([]byte(payload.CallbackState), []byte(callbackState)) != 1 {
			http.Error(w, "Invalid callback state", http.StatusForbidden)
			return
		}
		// Only callbacks with the login state may compete to finish the flow.
		callbackMu.Lock()
		defer callbackMu.Unlock()
		select {
		case <-finished:
			return
		default:
		}
		if strings.TrimSpace(payload.Token) == "" {
			errCh <- fmt.Errorf("OAuth callback did not include a token.")
			close(finished)
			http.Error(w, "Missing token", http.StatusBadRequest)
			authShutdownServer(server)
			return
		}
		resolve(strings.TrimSpace(payload.Token), strings.TrimSpace(payload.Username), strings.TrimSpace(payload.Email), strings.TrimSpace(payload.ExpiresAt))
	})
	server.Handler = mux
	go func() {
		_ = server.Serve(listener)
	}()

	loginURL := fmt.Sprintf("%s/api/auth/github/cli?callback_port=%d&callback_state=%s", target.APIURL, port, callbackState)
	if options["admin"] == "true" {
		ttl := options["ttl"]
		if ttl == "" {
			ttl = "1h"
		}
		loginURL += "&admin=1&ttl=" + url.QueryEscape(ttl)
	}
	fmt.Fprintf(os.Stderr, "Opening browser for Smithers login at %s\n", target.Host)
	fmt.Fprintf(os.Stderr, "If it does not open, visit:\n%s\n", loginURL)
	timer := time.NewTimer(browserLoginTimeout)
	defer timer.Stop()
	if err := authOpenBrowser(loginURL); err != nil {
		// A synchronous opener has already attempted the callback; there is no
		// interactive browser left to complete a failed handshake.
		if authBrowserSynchronous {
			_ = server.Close()
			return browserLoginResult{}, fmt.Errorf("browser login failed: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Browser could not be opened automatically: %s\n", err)
	}
	if authBrowserSynchronous {
		select {
		case <-finished:
		default:
			_ = server.Close()
			return browserLoginResult{}, fmt.Errorf("browser login did not deliver a valid callback")
		}
	}

	select {
	case result := <-resultCh:
		if options["admin"] == "true" {
			expiry, err := time.Parse(time.RFC3339, result.ExpiresAt)
			if err != nil || !expiry.After(time.Now()) {
				return browserLoginResult{}, fmt.Errorf("admin login callback did not include a valid future expires_at")
			}
		}
		return result, nil
	case err := <-errCh:
		return browserLoginResult{}, err
	case <-timer.C:
		// Shutdown with a background context can wait forever on an incomplete
		// callback body. Once login expires, close pending connections too.
		_ = server.Close()
		return browserLoginResult{}, fmt.Errorf("Timed out waiting for a valid browser login callback on %s.", target.Host)
	}
}
