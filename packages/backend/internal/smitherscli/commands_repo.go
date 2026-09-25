package smitherscli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	incur "github.com/smithersai/incur"
)

const localSmithersConfigPath = ".smithers/config.json"
const defaultGitHubAppInstallURL = "https://github.com/apps/smitherspreviewrelease/installations/new"
const defaultGitHubAppPollInterval = 2 * time.Second

var permittedLicenses = map[string]struct{}{
	"MIT":          {},
	"Apache-2.0":   {},
	"BSD-2-Clause": {},
	"BSD-3-Clause": {},
	"ISC":          {},
	"MPL-2.0":      {},
}

var spdxCanonical = map[string]string{
	"apache-2.0":   "Apache-2.0",
	"bsd-2-clause": "BSD-2-Clause",
	"bsd-3-clause": "BSD-3-Clause",
	"isc":          "ISC",
	"mit":          "MIT",
	"mpl-2.0":      "MPL-2.0",
}

var licenseFilenames = []string{
	"LICENSE", "LICENSE.md", "LICENSE.txt",
	"license", "license.md", "license.txt",
	"COPYING", "COPYING.md", "COPYING.txt",
	"copying", "copying.md", "copying.txt",
}

type localRepoConnection struct {
	ConnectedAt   string `json:"connected_at"`
	LicenseSPDXID string `json:"license_spdx_id"`
	Repo          string `json:"repo"`
}

type cloneProgramResult struct {
	exitCode int
	stdout   string
	stderr   string
}

var resolveRepoCloneTarget = ResolveRepoCloneTarget
var clearLocalRepoConnectionForCommand = clearLocalRepoConnection

func repoCommand() *incur.Cli {
	cmd := incur.New("repo", incur.WithDescription("Manage repositories"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a new repository",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Repository name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"description": {Type: "string", Description: "Repository description", Default: ""},
			"private":     booleanSchema("Make repository private", false),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			body := map[string]any{"name": stringValue(ctx.Args["name"])}
			if description := stringValue(ctx.Options["description"]); description != "" {
				body["description"] = description
			}
			if ctx.Options["private"] == true {
				body["private"] = true
			}
			repo, err := APIRequest("POST", "/api/user/repos", body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				if ctx.Format == string(incur.FormatTOON) {
					return formatRepoCreateToon(repo), nil
				}
				return repo, nil
			}
			return formatRepoCreate(repo), nil
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description:   "List your repositories",
		OptionsSchema: pageLimitOptions(),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("per_page", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
			repos, err := APIRequest("GET", "/api/user/repos?"+query.Encode(), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return repos, nil
			}
			return formatRepoList(arrayValue(repos)), nil
		},
	})
	cmd.Command("view", &incur.CommandDef{
		Description: "View repository details",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository in OWNER/REPO format"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			repoArg := stringValue(ctx.Options["repo"])
			if repoArg == "" {
				repoArg = stringValue(ctx.Args["repo"])
			}
			owner, name, err := ResolveRepoRef(repoArg)
			if err != nil {
				return nil, err
			}
			repo, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s", owner, name), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return repo, nil
			}
			return formatRepoView(repo), nil
		},
	})
	cmd.Command("connect", &incur.CommandDef{
		Description: "Connect this jj repository to a public GitHub repository",
		ArgsSchema:  objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			cwd, _ := os.Getwd()
			if err := requireJjRepoDirectory(cwd); err != nil {
				return nil, err
			}
			owner, repoName, err := parseOwnerRepoRefOrThrow(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			githubRepo, err := fetchGithubRepo(owner, repoName)
			if err != nil {
				return nil, err
			}
			if private, _ := githubRepo["private"].(bool); private {
				return nil, fmt.Errorf("REPO_NOT_PUBLIC")
			}
			resolvedLicense, err := resolveRepoLicense(cwd, githubRepo)
			if err != nil {
				return nil, err
			}
			appStatus, err := waitForGitHubAppInstallation(owner, repoName, ctx.FormatExplicit)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if _, err := APIRequest("POST", "/api/repo-connection", map[string]any{
				"license_spdx_id": resolvedLicense,
				"owner":           owner,
				"repo":            repoName,
			}, nil); err != nil {
				return nil, cleanAPIError(err)
			}
			repoRef := owner + "/" + repoName
			connection := localRepoConnection{
				ConnectedAt:   time.Now().UTC().Format(time.RFC3339Nano),
				LicenseSPDXID: resolvedLicense,
				Repo:          repoRef,
			}
			if err := saveLocalRepoConnection(cwd, connection); err != nil {
				rollbackRepoConnection(cwd, owner, repoName)
				return nil, err
			}
			result := map[string]any{
				"connected":            true,
				"github_app_installed": appStatus["github_app_installed"] == true,
				"license_spdx_id":      resolvedLicense,
				"repo":                 repoRef,
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return fmt.Sprintf("Connected %s (license: %s)", repoRef, resolvedLicense), nil
		},
	})
	cmd.Command("disconnect", &incur.CommandDef{
		Description: "Disconnect this repository from Smithers",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			cwd, _ := os.Getwd()
			if err := requireJjRepoDirectory(cwd); err != nil {
				return nil, err
			}
			current, err := localRepoConnectionFor(cwd)
			if err != nil {
				return nil, err
			}
			if current != nil {
				owner, repoName, err := parseOwnerRepoRefOrThrow(current.Repo)
				if err != nil {
					return nil, err
				}
				if _, err := APIRequest("DELETE", "/api/repo-connection", map[string]any{"owner": owner, "repo": repoName}, nil); err != nil {
					return nil, cleanAPIError(err)
				}
				if err := clearLocalRepoConnectionForCommand(cwd); err != nil {
					return nil, err
				}
			}
			result := map[string]any{"connected": false}
			if ctx.FormatExplicit {
				return result, nil
			}
			return "Disconnected", nil
		},
	})
	cmd.Command("status", &incur.CommandDef{
		Description: "Show local repository connection status",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			cwd, _ := os.Getwd()
			if err := requireJjRepoDirectory(cwd); err != nil {
				return nil, err
			}
			current, err := localRepoConnectionFor(cwd)
			if err != nil {
				return nil, err
			}
			var appStatus map[string]any
			if current != nil {
				owner, repoName, err := parseOwnerRepoRefOrThrow(current.Repo)
				if err != nil {
					return nil, err
				}
				appStatus, err = fetchGitHubAppStatus(owner, repoName)
				if err != nil {
					return nil, cleanAPIError(err)
				}
			}
			result := map[string]any{
				"connected":                   current != nil,
				"github_app_installed":        objectValue(appStatus)["github_app_installed"] == true,
				"github_rate_limit_limit":     objectValue(appStatus)["github_rate_limit_limit"],
				"github_rate_limit_remaining": objectValue(appStatus)["github_rate_limit_remaining"],
				"github_rate_limit_reset":     objectValue(appStatus)["github_rate_limit_reset"],
			}
			if current != nil {
				result["license_spdx_id"] = current.LicenseSPDXID
				result["repo"] = current.Repo
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			if current == nil {
				return "connected: false", nil
			}
			lines := []string{
				"connected: true",
				"repo: " + current.Repo,
				fmt.Sprintf("github_app_installed: %t", result["github_app_installed"] == true),
			}
			limit := stringValue(result["github_rate_limit_limit"])
			remaining := stringValue(result["github_rate_limit_remaining"])
			if limit != "" && remaining != "" {
				lines = append(lines, fmt.Sprintf("github_rate_limit_remaining: %s/%s", remaining, limit))
			}
			if reset := stringValue(result["github_rate_limit_reset"]); reset != "" {
				lines = append(lines, "github_rate_limit_reset: "+reset)
			}
			return strings.Join(lines, "\n"), nil
		},
	})
	cmd.Command("mirror-sync", &incur.CommandDef{
		Description: "Start a GitHub mirror sync run",
		OptionsSchema: objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository in OWNER/REPO format"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repoName, err := parseOwnerRepoRefOrThrow(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			result, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/mirror-sync", owner, repoName), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			runID := formatNumber(objectValue(result)["run_id"])
			return "Mirror sync run " + runID + " started for " + owner + "/" + repoName, nil
		},
	})
	cmd.Command("clone", &incur.CommandDef{
		Description: "Clone a repository",
		ArgsSchema:  objectSchema(nil, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format or URL")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"clone-arg": arraySchema("Extra arguments for clone"),
			"directory": stringSchema("Target directory"),
			"protocol":  enumSchema("Git protocol to use", []string{"ssh", "https"}, ""),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			repoArg := stringValue(ctx.Args["repo"])
			if repoArg == "" {
				return nil, fmt.Errorf("required arguments were not provided: repo")
			}
			config, err := LoadConfig()
			if err != nil {
				return nil, err
			}
			protocol := config.GitProtocol
			if value := stringValue(ctx.Options["protocol"]); value != "" {
				protocol = GitProtocol(value)
			}
			cloneURL := repoArg
			owner := ""
			name := ""
			if isOwnerRepoRef(repoArg) {
				var err error
				owner, name, cloneURL, err = resolveRepoCloneTarget(repoArg, protocol, config.APIURL)
				if err != nil {
					return nil, err
				}
				if err := maybeLookupRepoMetadata(owner, name); err != nil {
					return nil, cleanAPIError(err)
				}
			}
			if name == "" {
				slashIndex := strings.LastIndex(cloneURL, "/")
				if slashIndex == -1 {
					name = strings.TrimSuffix(cloneURL, ".git")
				} else {
					name = strings.TrimSuffix(cloneURL[slashIndex+1:], ".git")
				}
			}
			targetDir := stringValue(ctx.Options["directory"])
			if targetDir == "" {
				targetDir = name
			}
			cloneArgs := append([]string{cloneURL, targetDir}, stringSliceValue(ctx.Options["clone-arg"])...)
			jjResult := runCloneProgram("jj", append([]string{"git", "clone"}, cloneArgs...))
			writeCloneLogs(jjResult)
			if jjResult.exitCode == 0 {
				return cloneResult(owner, name, targetDir, protocol, "jj", ctx), nil
			}
			gitResult := runCloneProgram("git", append([]string{"clone"}, cloneArgs...))
			writeCloneLogs(gitResult)
			if gitResult.exitCode == 0 {
				return cloneResult(owner, name, targetDir, protocol, "git", ctx), nil
			}
			return nil, errors.New(strings.Join([]string{
				"Clone failed with jj and git.",
				"",
				"jj: " + cloneErrorText(jjResult),
				"git: " + cloneErrorText(gitResult),
			}, "\n"))
		},
	})
	registerRepoMutationCommands(cmd)
	return cmd
}

func registerRepoMutationCommands(cmd *incur.Cli) {
	cmd.Command("fork", &incur.CommandDef{
		Description: "Fork a repository",
		ArgsSchema:  objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{"repo": stringSchema("Repository to fork in OWNER/REPO format")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"name":         stringSchema("Name for the forked repository"),
			"organization": stringSchema("Organization to fork into"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repoName, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{}
			if name := stringValue(ctx.Options["name"]); name != "" {
				body["name"] = name
			}
			if organization := stringValue(ctx.Options["organization"]); organization != "" {
				body["organization"] = organization
			}
			repo, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/forks", owner, repoName), body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return repo, nil
			}
			return "Forked repository " + repoFullName(objectValue(repo)), nil
		},
	})
	cmd.Command("transfer", &incur.CommandDef{
		Description:   "Transfer repository ownership",
		ArgsSchema:    objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format")}),
		OptionsSchema: objectSchema([]string{"to"}, map[string]*incur.JSONSchema{"to": stringSchema("New owner (user or organization)")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repoName, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			to := stringValue(ctx.Options["to"])
			repo, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/transfer", owner, repoName), map[string]any{"new_owner": to}, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return repo, nil
			}
			return "Transferred repository " + repoFullName(objectValue(repo)) + " to " + to, nil
		},
	})
	for _, spec := range []struct {
		name        string
		method      string
		path        string
		status      string
		action      string
		destructive bool
	}{
		{"archive", "POST", "/archive", "archived", "Archived", false},
		{"unarchive", "DELETE", "/archive", "unarchived", "Unarchived", false},
		{"delete", "DELETE", "", "deleted", "Deleted", true},
	} {
		spec := spec
		def := &incur.CommandDef{
			Description: repoMutationDescription(spec.name),
			ArgsSchema:  objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format")}),
			Handler: func(ctx *incur.CommandContext) (any, error) {
				owner, repoName, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
				if err != nil {
					return nil, err
				}
				if spec.destructive {
					if err := confirmDestructiveOperation(ctx.Options["yes"] == true, spec.name+" repository "+strconv.Quote(owner+"/"+repoName)); err != nil {
						return nil, err
					}
				}
				path := fmt.Sprintf("/api/repos/%s/%s%s", owner, repoName, spec.path)
				if _, err := APIRequest(spec.method, path, nil, nil); err != nil {
					return nil, cleanAPIError(err)
				}
				repoRef := owner + "/" + repoName
				if ctx.FormatExplicit {
					return map[string]any{"status": spec.status, "repo": repoRef}, nil
				}
				return formatRepoMutation(spec.action, repoRef), nil
			},
		}
		if spec.destructive {
			def.OptionsSchema = objectSchema(nil, map[string]*incur.JSONSchema{"yes": booleanSchema("Confirm deleting the repository", false)})
		}
		cmd.Command(spec.name, def)
	}
	cmd.Command("edit", &incur.CommandDef{
		Description: "Edit repository settings",
		ArgsSchema:  objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{"repo": stringSchema("Repository in OWNER/REPO format")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"description": stringSchema("New description"),
			"private":     {Type: "boolean", Description: "Set visibility"},
			"name":        stringSchema("New repository name"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repoName, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{}
			if _, ok := ctx.Options["description"]; ok {
				body["description"] = stringValue(ctx.Options["description"])
			}
			if _, ok := ctx.Options["private"]; ok {
				body["private"] = ctx.Options["private"] == true
			}
			if _, ok := ctx.Options["name"]; ok {
				body["name"] = stringValue(ctx.Options["name"])
			}
			repo, err := APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s", owner, repoName), body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return repo, nil
			}
			return "Updated repository " + repoFullName(objectValue(repo)), nil
		},
	})

}

func repoMutationDescription(name string) string {
	switch name {
	case "archive":
		return "Archive a repository"
	case "unarchive":
		return "Unarchive a repository"
	case "delete":
		return "Delete a repository"
	default:
		return "Update repository"
	}
}

func isOwnerRepoRef(value string) bool {
	_, _, ok := parseOwnerRepoRef(strings.TrimSpace(value))
	return ok
}

func parseOwnerRepoRefOrThrow(value string) (string, string, error) {
	owner, repo, ok := parseOwnerRepoRef(strings.TrimSpace(value))
	if !ok {
		return "", "", fmt.Errorf("Repository must be in OWNER/REPO format")
	}
	return owner, repo, nil
}

func requireJjRepoDirectory(cwd string) error {
	info, err := os.Stat(filepath.Join(cwd, ".jj"))
	if err != nil || !info.IsDir() {
		return fmt.Errorf("NOT_JJ_REPO")
	}
	return nil
}

func normalizeSpdxID(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if canonical := spdxCanonical[strings.ToLower(trimmed)]; canonical != "" {
		return canonical
	}
	return trimmed
}

func isPermittedLicense(value string) bool {
	_, ok := permittedLicenses[normalizeSpdxID(value)]
	return ok
}

func isUnresolvedGitHubLicense(value string) bool {
	upper := strings.ToUpper(strings.TrimSpace(value))
	return upper == "NOASSERTION" || upper == "NONE"
}

func detectLicenseFromText(text string) string {
	lower := strings.ToLower(text)
	if idx := strings.Index(lower, "spdx-license-identifier:"); idx != -1 {
		rest := strings.TrimSpace(text[idx+len("spdx-license-identifier:"):])
		fields := strings.Fields(rest)
		if len(fields) > 0 {
			normalized := normalizeSpdxID(fields[0])
			if isPermittedLicense(normalized) {
				return normalized
			}
		}
	}
	if (strings.Contains(lower, "mit license") || strings.Contains(lower, "permission is hereby granted, free of charge")) && strings.Contains(lower, "without limitation the rights to use") {
		return "MIT"
	}
	if strings.Contains(lower, "apache license") && strings.Contains(lower, "version 2.0") {
		return "Apache-2.0"
	}
	if strings.Contains(lower, "mozilla public license") && (strings.Contains(lower, "version 2.0") || strings.Contains(lower, "mozilla public license, v. 2.0")) {
		return "MPL-2.0"
	}
	if strings.Contains(lower, "permission to use, copy, modify, and/or distribute this software for any purpose") {
		return "ISC"
	}
	hasBSDHeader := strings.Contains(lower, "redistribution and use in source and binary forms")
	if hasBSDHeader && strings.Contains(lower, "neither the name") {
		return "BSD-3-Clause"
	}
	if hasBSDHeader && strings.Contains(lower, "this software is provided by the copyright holders and contributors \"as is\"") {
		return "BSD-2-Clause"
	}
	return ""
}

func readFallbackLicenseFromRepoRoot(cwd string) string {
	for _, filename := range licenseFilenames {
		raw, err := os.ReadFile(filepath.Join(cwd, filename))
		if err != nil {
			continue
		}
		if detected := detectLicenseFromText(string(raw)); detected != "" {
			return detected
		}
	}
	return ""
}

func githubAPIBaseURL() string {
	configured := strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_API_URL"))
	if configured == "" {
		configured = "https://api.github.com"
	}
	return strings.TrimRight(configured, "/")
}

func fetchGithubRepo(owner, repo string) (map[string]any, error) {
	path := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	headers := map[string]string{"X-GitHub-Api-Version": "2022-11-28"}
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	decoded, _, err := doAPIJSON(apiCall{Method: http.MethodGet, URL: githubAPIBaseURL() + path, Path: path, Accept: "application/vnd.github+json", Headers: headers})
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return nil, fmt.Errorf("GitHub API request failed (%d): %s", apiErr.Status, apiErr.Detail)
		}
		return nil, err
	}
	out, ok := decoded.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("GitHub API returned an unexpected repository response")
	}
	return out, nil
}

func resolveRepoLicense(cwd string, githubRepo map[string]any) (string, error) {
	licenseObj := objectValue(githubRepo["license"])
	githubSpdx := normalizeSpdxID(stringValue(licenseObj["spdx_id"]))
	if githubSpdx != "" && !isUnresolvedGitHubLicense(githubSpdx) {
		if !isPermittedLicense(githubSpdx) {
			return "", fmt.Errorf("LICENSE_NOT_PERMITTED")
		}
		return githubSpdx, nil
	}
	fallback := readFallbackLicenseFromRepoRoot(cwd)
	if fallback == "" || !isPermittedLicense(fallback) {
		return "", fmt.Errorf("LICENSE_NOT_PERMITTED")
	}
	return fallback, nil
}

func githubAppPollInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_APP_POLL_INTERVAL_MS"))
	if raw == "" {
		return defaultGitHubAppPollInterval
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return defaultGitHubAppPollInterval
	}
	return time.Duration(parsed) * time.Millisecond
}

func defaultGitHubAppStatus() map[string]any {
	return map[string]any{"github_app_installed": false, "install_url": defaultGitHubAppInstallURL}
}

func fetchGitHubAppStatus(owner, repo string) (map[string]any, error) {
	status, err := APIRequest("GET", "/api/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(repo)+"/github-app-status", nil, nil)
	if err != nil {
		return nil, err
	}
	out := defaultGitHubAppStatus()
	for key, value := range objectValue(status) {
		out[key] = value
	}
	return out, nil
}

func waitForGitHubAppInstallation(owner, repo string, structured bool) (map[string]any, error) {
	status, err := fetchGitHubAppStatus(owner, repo)
	if err != nil {
		return nil, err
	}
	if status["github_app_installed"] == true {
		return status, nil
	}
	if !structured {
		installURL := stringValue(status["install_url"])
		if installURL == "" {
			installURL = defaultGitHubAppInstallURL
		}
		_, _ = fmt.Fprint(os.Stdout, strings.Join([]string{
			"GitHub App not detected. Install it:",
			"  " + installURL,
			"",
			"Waiting for installation...",
			"",
		}, "\n"))
	}
	interval := githubAppPollInterval()
	for status["github_app_installed"] != true {
		time.Sleep(interval)
		status, err = fetchGitHubAppStatus(owner, repo)
		if err != nil {
			return nil, err
		}
	}
	if !structured {
		_, _ = fmt.Fprintln(os.Stdout, "Detected GitHub App installation.")
	}
	return status, nil
}

func readSmithersLocalConfig(cwd string) (map[string]any, error) {
	path := filepath.Join(cwd, localSmithersConfigPath)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		if errors.Is(err, syscall.EISDIR) {
			return nil, fmt.Errorf("EISDIR: %w", err)
		}
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("Invalid .smithers/config.json")
	}
	if parsed == nil {
		return nil, fmt.Errorf("Invalid .smithers/config.json")
	}
	return parsed, nil
}

func writeSmithersLocalConfig(cwd string, config map[string]any) error {
	path := filepath.Join(cwd, localSmithersConfigPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		if errors.Is(err, syscall.EISDIR) {
			return fmt.Errorf("EISDIR: %w", err)
		}
		return err
	}
	return nil
}

func saveLocalRepoConnection(cwd string, connection localRepoConnection) error {
	config, err := readSmithersLocalConfig(cwd)
	if err != nil {
		return err
	}
	config["repo_connection"] = map[string]any{
		"connected_at":    connection.ConnectedAt,
		"license_spdx_id": connection.LicenseSPDXID,
		"repo":            connection.Repo,
	}
	return writeSmithersLocalConfig(cwd, config)
}

func clearLocalRepoConnection(cwd string) error {
	config, err := readSmithersLocalConfig(cwd)
	if err != nil {
		return err
	}
	if _, ok := config["repo_connection"]; !ok {
		return nil
	}
	delete(config, "repo_connection")
	return writeSmithersLocalConfig(cwd, config)
}

func localRepoConnectionFor(cwd string) (*localRepoConnection, error) {
	config, err := readSmithersLocalConfig(cwd)
	if err != nil {
		return nil, err
	}
	candidate := objectValue(config["repo_connection"])
	if candidate == nil {
		return nil, nil
	}
	connection := localRepoConnection{
		ConnectedAt:   stringValue(candidate["connected_at"]),
		LicenseSPDXID: stringValue(candidate["license_spdx_id"]),
		Repo:          stringValue(candidate["repo"]),
	}
	if connection.ConnectedAt == "" || connection.LicenseSPDXID == "" || connection.Repo == "" {
		return nil, nil
	}
	return &connection, nil
}

func rollbackRepoConnection(cwd, owner, repo string) {
	_ = clearLocalRepoConnection(cwd)
	_, _ = APIRequest("DELETE", "/api/repo-connection", map[string]any{"owner": owner, "repo": repo}, nil)
}

func maybeLookupRepoMetadata(owner, repo string) error {
	auth, err := ResolveAuthToken(nil)
	if err != nil || auth == nil {
		return nil
	}
	_, err = APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s", owner, repo), nil, auth)
	if err == nil {
		return nil
	}
	if apiErr, ok := err.(*APIError); ok && (apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden) {
		return nil
	}
	if _, ok := err.(*APIError); ok {
		return err
	}
	return nil
}

func runCloneProgram(command string, args []string) cloneProgramResult {
	cmd := exec.Command(command, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		exitCode = 127
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}
	return cloneProgramResult{exitCode: exitCode, stdout: stdout.String(), stderr: stderr.String()}
}

func writeCloneLogs(result cloneProgramResult) {
	writeWithTrailingNewline(os.Stderr, result.stderr)
	writeWithTrailingNewline(os.Stderr, result.stdout)
}

func writeWithTrailingNewline(writer io.Writer, text string) {
	if text == "" {
		return
	}
	if strings.HasSuffix(text, "\n") {
		_, _ = fmt.Fprint(writer, text)
		return
	}
	_, _ = fmt.Fprintln(writer, text)
}

func cloneResult(owner, name, targetDir string, protocol GitProtocol, tool string, ctx *incur.CommandContext) any {
	cloned := targetDir
	if owner != "" && name != "" {
		cloned = owner + "/" + name
	}
	result := map[string]any{"cloned": cloned, "directory": targetDir, "protocol": string(protocol), "tool": tool}
	if ctx.FormatExplicit {
		return result
	}
	return fmt.Sprintf("Cloned %s into %s using %s", cloned, targetDir, tool)
}

func cloneErrorText(result cloneProgramResult) string {
	if result.stderr != "" {
		return result.stderr
	}
	if result.stdout != "" {
		return result.stdout
	}
	return fmt.Sprintf("exit code %d", result.exitCode)
}
