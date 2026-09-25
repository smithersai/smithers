package smitherscli

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
)

const agentSummaryDocsURL = "https://smithers.sh/llms-full.txt"

// agentGetwd is a seam so the defensive os.Getwd error branch in
// collectAgentRepoContext can be exercised.
var agentGetwd = os.Getwd

func agentCommand() *incur.Cli {
	cmd := incur.New("agent", incur.WithDescription("Talk to a local Smithers usage helper or manage remote agent sessions"))
	cmd.Command("ask", &incur.CommandDef{
		Description: "Talk to the local Smithers usage helper",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"prompt": stringSchema("Optional one-shot prompt for the local Smithers helper")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			prompt := stringValue(ctx.Args["prompt"])
			if os.Getenv("SMITHERS_AGENT_TEST_MODE") == "summary" {
				return agentSummary(prompt, stringValue(ctx.Options["repo"]))
			}
			if prompt == "" {
				return map[string]any{
					"status":  "ready",
					"message": "Local Smithers helper is ready for one-shot prompts. Pass a prompt, or use `smithers agent run <prompt>` for a remote agent session.",
				}, nil
			}
			return runLocalAgentPrompt(ctx, prompt, stringValue(ctx.Options["repo"]))
		},
	})
	cmd.Group("session", agentSessionCommand())
	registerAgentRemoteSessionCommands(cmd)
	return cmd
}

func agentSessionCommand() *incur.Cli {
	cmd := incur.New("session", incur.WithDescription("Manage remote Smithers agent sessions"))
	registerAgentRemoteSessionCommands(cmd)
	return cmd
}

func registerAgentRemoteSessionCommands(cmd *incur.Cli) {
	cmd.Command("list", &incur.CommandDef{
		Description: "List remote agent sessions",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"page":     numberSchema("Page number", 1),
			"per-page": numberSchema("Results per page", 30),
			"repo":     stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("per_page", strconv.Itoa(intValue(ctx.Options["per-page"], 30)))
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/agent/sessions?%s", owner, repo, query.Encode()), nil, nil)
		},
	})
	cmd.Command("view", &incur.CommandDef{
		Description: "View a remote agent session",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": stringSchema("Session ID")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/agent/sessions/%s", owner, repo, url.PathEscape(stringValue(ctx.Args["id"]))), nil, nil)
		},
	})
	cmd.Command("run", &incur.CommandDef{
		Description:   "Start a remote agent session and run a prompt",
		ArgsSchema:    objectSchema([]string{"prompt"}, map[string]*incur.JSONSchema{"prompt": stringSchema("Prompt to send to the remote agent")}),
		OptionsSchema: agentMessageOptions(true),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			prompt := stringValue(ctx.Args["prompt"])
			title := stringValue(ctx.Options["title"])
			if title == "" {
				title = prompt
				if len(title) > 60 {
					title = title[:60]
				}
			}
			session, err := createAgentSession(owner, repo, title)
			if err != nil {
				return nil, err
			}
			id := stringValue(objectValue(session)["id"])
			if id == "" {
				return nil, fmt.Errorf("agent session response did not include id")
			}
			if _, err := sendAgentMessage(owner, repo, id, prompt, stringValue(ctx.Options["provider"]), stringValue(ctx.Options["transport"])); err != nil {
				return nil, err
			}
			return session, nil
		},
	})
	cmd.Command("chat", &incur.CommandDef{
		Description: "Send a message to an existing remote agent session",
		ArgsSchema: objectSchema([]string{"id", "message"}, map[string]*incur.JSONSchema{
			"id":      stringSchema("Session ID"),
			"message": stringSchema("Message to send"),
		}),
		OptionsSchema: agentMessageOptions(false),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return sendAgentMessage(owner, repo, stringValue(ctx.Args["id"]), stringValue(ctx.Args["message"]), stringValue(ctx.Options["provider"]), stringValue(ctx.Options["transport"]))
		},
	})
}

func agentMessageOptions(includeTitle bool) *incur.JSONSchema {
	properties := map[string]*incur.JSONSchema{
		"repo":      stringSchema("Repository (OWNER/REPO)"),
		"provider":  enumSchema("Remote agent provider", []string{"smithers", "codex"}, "smithers"),
		"transport": enumSchema("Remote agent transport", []string{"workflow", "http"}, "workflow"),
	}
	if includeTitle {
		properties["title"] = stringSchema("Optional title for the session")
	}
	return objectSchema(nil, properties)
}

func createAgentSession(owner, repo, title string) (any, error) {
	return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/agent/sessions", owner, repo), map[string]any{"title": title}, nil)
}

func sendAgentMessage(owner, repo, sessionID, content, provider, transport string) (any, error) {
	if provider == "" {
		provider = "smithers"
	}
	if transport == "" {
		transport = "workflow"
	}
	return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/agent/sessions/%s/messages", owner, repo, url.PathEscape(sessionID)), map[string]any{
		"role":            "user",
		"parts":           []map[string]any{{"type": "text", "content": content}},
		"agent_provider":  provider,
		"agent_transport": transport,
	}, nil)
}

func runLocalAgentPrompt(ctx *incur.CommandContext, prompt, repoOverride string) (any, error) {
	repoContext, err := collectAgentRepoContext(repoOverride)
	if err != nil {
		return nil, err
	}
	repoContext["backend"] = map[string]any{
		"backend": "local",
		"cwd":     firstNonEmpty(stringValue(repoContext["repoRoot"]), stringValue(repoContext["cwd"])),
	}

	docsEntry := refreshAgentDocsCache("")
	docsIndex := prepareAgentDocsIndex(docsEntry)
	results := searchAgentDocsIndex(docsIndex, prompt, agentDocsDefaultResults)
	response := formatAgentDocsResults(results, docsEntry.Status)

	if ctx.FormatExplicit {
		return map[string]any{
			"backend":      "local",
			"repo_context": repoContext,
			"docs_status":  docsEntry.Status,
			"docs_results": results,
			"response":     response,
		}, nil
	}
	if stringValue(repoContext["repoSlug"]) != "" {
		return fmt.Sprintf("Repo: %s\n\n%s", stringValue(repoContext["repoSlug"]), response), nil
	}
	return response, nil
}

func agentSummary(prompt, repoOverride string) (any, error) {
	repoContext, err := collectAgentRepoContext(repoOverride)
	if err != nil {
		return nil, err
	}
	repoContext["backend"] = map[string]any{
		"backend": "local",
		"cwd":     firstNonEmpty(stringValue(repoContext["repoRoot"]), stringValue(repoContext["cwd"])),
	}

	result := map[string]any{
		"backend":      "local",
		"repo_context": repoContext,
		"docs_status": map[string]any{
			"url":     firstNonEmpty(strings.TrimSpace(os.Getenv("SMITHERS_AGENT_DOCS_URL")), agentSummaryDocsURL),
			"status":  "unavailable",
			"source":  "none",
			"warning": "Smithers docs refresh was skipped for lightweight summary mode.",
		},
	}
	if prompt != "" {
		result["response"] = prompt
	}
	return result, nil
}

func collectAgentRepoContext(repoOverride string) (map[string]any, error) {
	cwd, err := agentGetwd()
	if err != nil {
		cwd = "."
	}
	repoRoot := detectAgentRepoRoot(cwd)
	commandCWD := cwd
	if repoRoot != "" {
		commandCWD = repoRoot
	}
	jjRemotes := captureAgentCommand("jj", []string{"git", "remote", "list"}, commandCWD)
	jjStatus := captureAgentCommand("jj", []string{"status"}, commandCWD)

	warnings := []any{}
	repoSlug := ""
	repoSource := "unavailable"
	if strings.TrimSpace(repoOverride) != "" {
		owner, repo, err := ResolveRepoRef(repoOverride)
		if err != nil {
			return nil, err
		}
		repoSlug = owner + "/" + repo
		repoSource = "override"
	} else if slug := detectAgentRepoSlugFromRemotes(stringValue(jjRemotes["output"])); slug != "" {
		repoSlug = slug
		repoSource = "detected"
	} else {
		warnings = append(warnings, "Could not determine the current Smithers repository from local remotes.")
	}
	if repoRoot == "" {
		warnings = append(warnings, "No local jj repository was detected from the current working directory.")
	}
	if jjRemotes["ok"] != true && stringValue(jjRemotes["error"]) != "" {
		warnings = append(warnings, "Failed to collect `jj git remote list`: "+stringValue(jjRemotes["error"]))
	}
	if jjStatus["ok"] != true && stringValue(jjStatus["error"]) != "" {
		warnings = append(warnings, "Failed to collect `jj status`: "+stringValue(jjStatus["error"]))
	}

	auth := GetAuthStatus(nil, nil)
	authMap := map[string]any{
		"loggedIn": auth.LoggedIn,
		"host":     auth.Host,
		"message":  auth.Message,
		"verified": auth.LoggedIn && !strings.Contains(strings.ToLower(auth.Message), "could not verify"),
	}
	if auth.User != "" {
		authMap["user"] = auth.User
	}
	if auth.TokenSource != "" {
		authMap["tokenSource"] = string(auth.TokenSource)
	}

	return map[string]any{
		"collectedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"cwd":         cwd,
		"repoRoot":    nilIfEmpty(repoRoot),
		"repoSlug":    nilIfEmpty(repoSlug),
		"repoSource":  repoSource,
		"jjRemotes":   jjRemotes,
		"jjStatus":    jjStatus,
		"auth":        authMap,
		"remoteRepo":  checkAgentRemoteRepo(repoSlug, auth),
		"warnings":    warnings,
	}, nil
}

func detectAgentRepoRoot(cwd string) string {
	cmd := exec.Command("jj", "root")
	cmd.Dir = cwd
	out, err := runCommandWithTimeout(cmd, 10*time.Second)
	if err != nil {
		return ""
	}
	root := strings.TrimSpace(out)
	if root == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		return resolved
	}
	return root
}

func captureAgentCommand(command string, args []string, cwd string) map[string]any {
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	out, err := runCommandWithTimeout(cmd, 10*time.Second)
	commandText := strings.Join(append([]string{command}, args...), " ")
	if err == nil {
		return map[string]any{
			"command":  commandText,
			"ok":       true,
			"output":   trimAgentOutput(out),
			"exitCode": 0,
		}
	}
	return map[string]any{
		"command":  commandText,
		"ok":       false,
		"output":   trimAgentOutput(out),
		"error":    err.Error(),
		"exitCode": nil,
	}
}

func trimAgentOutput(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > 8000 {
		return trimmed[:8000] + "\n...[truncated]"
	}
	return trimmed
}

func detectAgentRepoSlugFromRemotes(output string) string {
	if output == "" {
		return ""
	}
	// Agent context is best effort; the auth status beside it reports a
	// broken config file.
	cfg, _ := LoadConfig()
	host := hostFromURL(cfg.APIURL)
	fallback := ""
	for _, rawLine := range strings.Split(output, "\n") {
		fields := strings.Fields(rawLine)
		if len(fields) < 2 {
			continue
		}
		owner, repo, ok := parseRepoFromURL(fields[1], host)
		if !ok {
			continue
		}
		slug := owner + "/" + repo
		if fields[0] == "origin" {
			return slug
		}
		if fallback == "" {
			fallback = slug
		}
	}
	return fallback
}

func checkAgentRemoteRepo(repoSlug string, auth AuthStatusResult) map[string]any {
	if repoSlug == "" || !auth.LoggedIn {
		message := "No Smithers repo detected"
		if repoSlug != "" {
			message = "Skipped because Smithers auth is unavailable"
		}
		return map[string]any{"checked": false, "message": message}
	}
	owner, repo, err := parseOwnerRepoRefOrThrow(repoSlug)
	if err != nil {
		return map[string]any{"checked": false, "message": err.Error()}
	}
	if _, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo)), nil, nil); err != nil {
		return map[string]any{"checked": true, "available": false, "message": err.Error()}
	}
	return map[string]any{"checked": true, "available": true}
}

func nilIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
