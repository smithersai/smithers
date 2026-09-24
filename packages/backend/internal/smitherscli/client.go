package smitherscli

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// RequireJj reports whether jj is on PATH. It resolves the binary without
// running it: a `jj --version` probe before every jj command doubled process
// spawns and reported a slow-starting jj as not installed.
func RequireJj() error {
	if _, err := exec.LookPath("jj"); err != nil {
		return errors.New(strings.Join([]string{
			"jj (Jujutsu) is not installed or not on your PATH.",
			"",
			"Smithers requires jj for local repository operations.",
			"",
			"Install it:",
			"  brew install jj            # macOS",
			"  cargo install jj-cli       # any platform",
			"  https://jj-vcs.github.io/jj/latest/install-and-setup/",
		}, "\n"))
	}
	return nil
}

func runCommandWithTimeout(cmd *exec.Cmd, timeout time.Duration) (string, error) {
	if cmd.Stdout != nil {
		return "", errors.New("exec: Stdout already set")
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	// Bound Wait even if a descendant inherits an output pipe after the
	// immediate child exits. Wait also joins the goroutine writing out.
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = time.Second
	}
	// Start must finish before the timeout branch can access cmd.Process.
	if err := cmd.Start(); err != nil {
		return "", err
	}
	ch := make(chan error, 1)
	go func() { ch <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-ch:
		return out.String(), err
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-ch // Reap the child and close its pipes before returning.
		return "", fmt.Errorf("command timed out")
	}
}

func ResolveRepoRef(repoOverride string) (owner, repo string, err error) {
	cfg, err := LoadConfig()
	if err != nil {
		return "", "", err
	}
	host := hostFromURL(cfg.APIURL)
	if strings.TrimSpace(repoOverride) != "" {
		parsedOwner, parsedRepo, ok := parseRepoOverride(repoOverride, host)
		if !ok {
			return "", "", fmt.Errorf(`Invalid repo format: "%s". Expected OWNER/REPO or a clone URL on %s.`, repoOverride, host)
		}
		return parsedOwner, parsedRepo, nil
	}
	owner, repo, ok := detectRepoFromRemotes(host)
	if ok {
		return owner, repo, nil
	}
	return "", "", fmt.Errorf("Could not determine repository. Use -R OWNER/REPO or run from within a repo.")
}

func ResolveRepoCloneTarget(repoRef string, protocol GitProtocol, apiURL string) (owner, repo, cloneURL string, err error) {
	if apiURL == "" {
		cfg, err := LoadConfig()
		if err != nil {
			return "", "", "", err
		}
		apiURL = cfg.APIURL
	}
	host := hostFromURL(apiURL)
	owner, repo, parsedCloneURL, ok := parseRepoOverrideWithClone(repoRef, host)
	if !ok {
		return "", "", "", fmt.Errorf(`Invalid repo format: "%s". Expected OWNER/REPO or a clone URL on %s.`, repoRef, host)
	}
	if parsedCloneURL == "" {
		parsedCloneURL = BuildCloneURL(owner, repo, protocol, apiURL)
	}
	return owner, repo, parsedCloneURL, nil
}

func BuildCloneURL(owner, repo string, protocol GitProtocol, apiURL string) string {
	host := hostFromURL(apiURL)
	if protocol == GitProtocolHTTPS {
		return fmt.Sprintf("https://%s/%s/%s.git", host, owner, repo)
	}
	return fmt.Sprintf("git@ssh.%s:%s/%s.git", host, owner, repo)
}

func parseRepoOverride(repoOverride, host string) (owner, repo string, ok bool) {
	owner, repo, _, ok = parseRepoOverrideWithClone(repoOverride, host)
	return owner, repo, ok
}

func parseRepoOverrideWithClone(repoOverride, host string) (owner, repo, cloneURL string, ok bool) {
	trimmed := strings.TrimSpace(repoOverride)
	if parsedOwner, parsedRepo, ok := parseRepoFromURL(trimmed, host); ok {
		return parsedOwner, parsedRepo, trimmed, true
	}
	if parsedOwner, parsedRepo, ok := parseOwnerRepoRef(trimmed); ok {
		return parsedOwner, parsedRepo, "", true
	}
	return "", "", "", false
}

func parseOwnerRepoRef(repoRef string) (owner, repo string, ok bool) {
	parts := strings.Split(repoRef, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func parseRepoFromURL(raw, host string) (owner, repo string, ok bool) {
	clean := strings.TrimRight(strings.TrimSpace(raw), "/")
	clean = strings.TrimSuffix(clean, ".git")
	normalizedHost := strings.ToLower(host)
	acceptedHosts := map[string]struct{}{
		normalizedHost:          {},
		"ssh." + normalizedHost: {},
		"api." + normalizedHost: {},
	}
	if normalizedHost == "127.0.0.1" || normalizedHost == "localhost" {
		acceptedHosts["smithers.sh"] = struct{}{}
		acceptedHosts["ssh.smithers.sh"] = struct{}{}
		acceptedHosts["api.smithers.sh"] = struct{}{}
	}

	if parsed, err := url.Parse(clean); err == nil && parsed.Hostname() != "" {
		if _, accepted := acceptedHosts[strings.ToLower(parsed.Hostname())]; accepted {
			parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
			if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
				return parts[0], parts[1], true
			}
		}
	}

	if at := strings.Index(clean, "@"); at != -1 {
		rest := clean[at+1:]
		if colon := strings.Index(rest, ":"); colon != -1 {
			h := strings.ToLower(rest[:colon])
			if _, accepted := acceptedHosts[h]; accepted {
				parts := strings.Split(rest[colon+1:], "/")
				if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
					return parts[0], parts[1], true
				}
			}
		}
	}

	if scheme := strings.Index(clean, "://"); scheme != -1 {
		rest := clean[scheme+3:]
		if colon := strings.Index(rest, ":"); colon != -1 {
			h := strings.ToLower(rest[:colon])
			if _, accepted := acceptedHosts[h]; accepted {
				parts := strings.Split(rest[colon+1:], "/")
				if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
					return parts[0], parts[1], true
				}
			}
		}
	}
	return "", "", false
}

func detectRepoFromRemotes(host string) (owner, repo string, ok bool) {
	outputs := []string{}
	if err := RequireJj(); err == nil {
		if out, err := exec.Command("jj", "git", "remote", "list").Output(); err == nil {
			outputs = append(outputs, string(out))
		}
	}
	if out, err := exec.Command("git", "remote", "-v").Output(); err == nil {
		outputs = append(outputs, string(out))
	}
	var fallbackOwner, fallbackRepo string
	for _, output := range outputs {
		for _, line := range strings.Split(output, "\n") {
			parts := strings.Fields(line)
			if len(parts) < 2 {
				continue
			}
			parsedOwner, parsedRepo, parsed := parseRepoFromURL(parts[1], host)
			if !parsed {
				continue
			}
			if parts[0] == "origin" {
				return parsedOwner, parsedRepo, true
			}
			if fallbackOwner == "" {
				fallbackOwner, fallbackRepo = parsedOwner, parsedRepo
			}
		}
	}
	if fallbackOwner != "" {
		return fallbackOwner, fallbackRepo, true
	}
	return "", "", false
}

func APIRequest(method, path string, body any, options *ResolvedAuthToken) (any, error) {
	result, err := apiRequestWithHeaders(method, path, body, options, nil, nil)
	if strings.HasPrefix(path, "/api/admin/") {
		token := options
		if token == nil {
			token, _ = ResolveAuthToken(nil)
		}
		err = adminLoginError(err, token)
	}
	return result, err
}

// apiRequestWithHeaders sends one authenticated JSON request. A nil client
// uses apiHTTPClient.
func apiRequestWithHeaders(method, path string, body any, options *ResolvedAuthToken, headers map[string]string, client *http.Client) (any, error) {
	token := options
	if token == nil {
		resolved, err := RequireAuthToken(nil)
		if err != nil {
			return nil, err
		}
		token = resolved
	}
	result, _, err := doAPIJSON(apiCall{
		Method:  method,
		URL:     token.APIURL + path,
		Path:    path,
		Body:    body,
		Token:   token.Token,
		Headers: headers,
		Client:  client,
	})
	return result, err
}

func escapePathSegment(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func APIList(path string, options *ResolvedAuthToken) (data any, nextCursor string, err error) {
	token := options
	if token == nil {
		token, err = RequireAuthToken(nil)
		if err != nil {
			return nil, "", err
		}
	}
	decoded, header, err := doAPIJSON(apiCall{Method: http.MethodGet, URL: token.APIURL + path, Path: path, Token: token.Token})
	if err != nil {
		return nil, "", err
	}
	if decoded == nil {
		decoded = []any{}
	}
	return decoded, ParseNextCursor(header.Get("Link")), nil
}

// maxListPages caps how many pages APIListAll follows, so a server that
// never ends its cursor chain cannot grow the result without bound.
var maxListPages = 1000

func APIListAll(buildPath func(cursor string) string, options *ResolvedAuthToken) ([]any, error) {
	all := []any{}
	cursor := ""
	seen := map[string]struct{}{}
	for page := 0; ; page++ {
		if page >= maxListPages {
			return nil, fmt.Errorf("stopped listing after %d pages; the server kept returning a next cursor", maxListPages)
		}
		data, nextCursor, err := APIList(buildPath(cursor), options)
		if err != nil {
			return nil, err
		}
		if items, ok := data.([]any); ok {
			all = append(all, items...)
		}
		if nextCursor == "" {
			break
		}
		if _, repeated := seen[nextCursor]; repeated {
			return nil, fmt.Errorf("the server repeated pagination cursor %q; stopped to avoid an endless listing", nextCursor)
		}
		seen[nextCursor] = struct{}{}
		cursor = nextCursor
	}
	return all, nil
}

func ParseNextCursor(linkHeader string) string {
	if linkHeader == "" {
		return ""
	}
	parts := strings.Split(linkHeader, ", <")
	for _, part := range parts {
		raw := part
		if !strings.HasPrefix(raw, "<") {
			raw = "<" + raw
		}
		end := strings.Index(raw, ">")
		if end == -1 || !strings.Contains(raw, `rel="next"`) {
			continue
		}
		linkURL := raw[1:end]
		parsed, err := url.Parse(linkURL)
		if err != nil {
			return ""
		}
		return parsed.Query().Get("cursor")
	}
	return ""
}
