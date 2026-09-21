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
	"sort"
	"strings"

	incur "github.com/smithersai/incur"
)

const stackMarkerStart = "<!-- smithers:stack:start -->"
const stackMarkerEnd = "<!-- smithers:stack:end -->"

type submittedStackChange struct {
	Branch          string
	ChangeID        string
	DescriptionBody string
	Position        int
	PRNumber        int
	PRState         string
	PRURL           string
	Status          string
	Title           string
}

var (
	selectStackLandCountForCommand   = selectStackLandCount
	stackMergeMethods                = []string{"merge", "squash", "rebase"}
	enrichStatusChangeForRefresh     = enrichStatusChangeWithGitHub
	refreshStackLandChangeForCommand = refreshStackLandChange
	buildStackStatusForCommand       = buildStackStatus
	githubPathUnescape               = url.PathUnescape
)

func stackCommand() *incur.Cli {
	cmd := incur.New("stack", incur.WithDescription("Manage stacked pull requests"))
	cmd.Command("submit", &incur.CommandDef{
		Description: "Create or update linked GitHub pull requests from the local jj stack",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"draft":  booleanSchema("Create pull requests as drafts", false),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"target": {Type: "string", Description: "Target branch", Default: "main"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			targetRef := stackTarget(ctx)
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			existing, err := loadExistingStack(owner, repo, targetRef)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			existingByChangeID := stackChangesByID(arrayValue(objectValue(existing)["changes"]))
			localStack, err := ListLocalStackChanges(targetRef)
			if err != nil {
				return nil, err
			}
			for i, j := 0, len(localStack)-1; i < j; i, j = i+1, j-1 {
				localStack[i], localStack[j] = localStack[j], localStack[i]
			}
			if len(localStack) == 0 {
				return nil, errors.New("No non-empty changes found between @ and target")
			}
			submitted := []submittedStackChange{}
			for index, change := range localStack {
				baseBranch := targetRef
				if index > 0 {
					baseBranch = submitted[index-1].Branch
				}
				branch := "smithers/" + shortChangeID(change.ChangeID)
				title, body := splitDescription(change.ChangeID, change.Description)
				if err := SetLocalBookmark(branch, change.ChangeID); err != nil {
					return nil, err
				}
				if err := PushLocalBookmark(branch); err != nil {
					if isDivergedPushError(err) {
						return nil, fmt.Errorf("Remote branch %s has diverged. Run `smithers stack sync` first.", branch)
					}
					return nil, err
				}
				existingPRNumber := intValue(existingByChangeID[change.ChangeID]["pr_number"], 0)
				pr := map[string]any(nil)
				status := "created"
				if existingPRNumber > 0 {
					pr, err = githubAPI("PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), existingPRNumber), map[string]any{
						"base":  baseBranch,
						"body":  body,
						"title": title,
					})
					if err == nil {
						status = "updated"
					} else if !githubNotFound(err) {
						return nil, err
					}
				}
				if pr == nil {
					pr, err = githubAPI("POST", fmt.Sprintf("/repos/%s/%s/pulls", url.PathEscape(owner), url.PathEscape(repo)), map[string]any{
						"base":  baseBranch,
						"body":  body,
						"draft": ctx.Options["draft"] == true,
						"head":  branch,
						"title": title,
					})
					if err != nil {
						return nil, err
					}
				}
				prNumber := intValue(pr["number"], 0)
				if prNumber <= 0 {
					return nil, fmt.Errorf("GitHub did not return a valid PR number for %s", change.ChangeID)
				}
				submitted = append(submitted, submittedStackChange{
					Branch:          branch,
					ChangeID:        change.ChangeID,
					DescriptionBody: body,
					Position:        index,
					PRNumber:        prNumber,
					PRState:         defaultString(stringValue(pr["state"]), "open"),
					PRURL:           stringValue(pr["html_url"]),
					Status:          status,
					Title:           title,
				})
			}
			for _, change := range submitted {
				stackBlock := renderStackBlock(submitted, change.ChangeID)
				if _, err := githubAPI("PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), change.PRNumber), map[string]any{
					"body": composePRBody(change.DescriptionBody, stackBlock),
				}); err != nil {
					return nil, err
				}
			}
			persisted, err := persistStackMapping(owner, repo, targetRef, submitted, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			result := map[string]any{
				"auth_source": githubAuthSource(),
				"change_ids":  stackSubmittedField(submitted, "change_id"),
				"changes":     stackSubmittedChanges(submitted),
				"pr_numbers":  stackSubmittedField(submitted, "pr_number"),
				"push_target": "origin/smithers/*",
				"stack_id":    objectValue(persisted)["id"],
				"target":      targetRef,
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return formatStackSubmitSummary(owner, repo, submitted), nil
		},
	})
	cmd.Command("unsubmit", &incur.CommandDef{
		Description: "Close stacked PRs, delete smithers remote branches, and remove stack mapping",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"target": {Type: "string", Description: "Target branch", Default: "main"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			targetRef := stackTarget(ctx)
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			existing, err := loadExistingStack(owner, repo, targetRef)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			result := map[string]any{"branches": []any{}, "prs": []any{}, "stack_deleted": false, "target": targetRef}
			if existing == nil || intValue(objectValue(existing)["id"], 0) == 0 {
				if ctx.FormatExplicit {
					return result, nil
				}
				return formatStackUnsubmitSummary(owner, repo, targetRef, result), nil
			}
			prs := []any{}
			branches := []any{}
			for _, raw := range arrayValue(objectValue(existing)["changes"]) {
				change := objectValue(raw)
				if prNumber := intValue(change["pr_number"], 0); prNumber > 0 {
					status, err := closePullRequestIfOpen(owner, repo, prNumber)
					if err != nil {
						return nil, err
					}
					prs = append(prs, map[string]any{"pr_number": prNumber, "status": status})
				}
				if branch := resolveStackBranchName(change); branch != "" {
					status, err := deleteRemoteBranchIfExists(owner, repo, branch)
					if err != nil {
						return nil, err
					}
					branches = append(branches, map[string]any{"branch": branch, "status": status})
				}
			}
			if err := deleteActiveStackMapping(owner, repo, targetRef); err != nil {
				return nil, cleanAPIError(err)
			}
			result = map[string]any{"branches": branches, "prs": prs, "stack_deleted": true, "target": targetRef}
			if ctx.FormatExplicit {
				return result, nil
			}
			return formatStackUnsubmitSummary(owner, repo, targetRef, result), nil
		},
	})
	cmd.Command("sync", stackSyncCommand(false))
	cmd.Command("land", stackLandCommand())
	cmd.Command("status", &incur.CommandDef{
		Description: "Show stack status with PR, review, and CI state",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"target": {Type: "string", Description: "Target branch", Default: "main"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			targetRef := stackTarget(ctx)
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			existing, err := loadExistingStack(owner, repo, targetRef)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			status, err := buildStackStatusForCommand(owner, repo, targetRef, existing)
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return status, nil
			}
			return formatStackStatusSummary(owner, repo, targetRef, status), nil
		},
	})
	return cmd
}

func stackSyncCommand(forLanding bool) *incur.CommandDef {
	return &incur.CommandDef{
		Description: "Sync stack with merged PRs, rebase remaining changes, and refresh PR tables",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"target": {Type: "string", Description: "Target branch", Default: "main"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			targetRef := stackTarget(ctx)
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			result, err := syncStack(owner, repo, targetRef)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return formatStackSyncSummary(owner, repo, targetRef, result), nil
		},
	}
}

func stackLandCommand() *incur.CommandDef {
	return &incur.CommandDef{
		Description: "Land approved stack PRs from the bottom and re-stack remaining changes",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"all":    booleanSchema("Land all consecutively approved+passing changes from the bottom", false),
			"change": stringSchema("Land this change and everything below it"),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"target": {Type: "string", Description: "Target branch", Default: "main"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			targetRef := stackTarget(ctx)
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			requestedChange, requested := ctx.Options["change"]
			requestedChangeText := strings.TrimSpace(stringValue(requestedChange))
			if requested && requestedChangeText == "" {
				return nil, errors.New("`--change` requires a non-empty change id.")
			}
			if ctx.Options["all"] == true && requested {
				return nil, errors.New("Specify only one of `--all` or `--change`.")
			}
			existing, err := loadExistingStack(owner, repo, targetRef)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if existing == nil || intValue(objectValue(existing)["id"], 0) == 0 {
				result := map[string]any{"fetched": false, "landed": []any{}, "remaining": []any{}, "stack_deleted": false, "stack_found": false, "stack_id": nil, "target": targetRef}
				if ctx.FormatExplicit {
					return result, nil
				}
				return formatStackLandSummary(owner, repo, targetRef, result), nil
			}
			changes := normalizeMappedStackChanges(arrayValue(objectValue(existing)["changes"]))
			landable, err := buildStackLandChanges(owner, repo, changes)
			if err != nil {
				return nil, err
			}
			landCount, err := selectStackLandCountForCommand(landable, ctx.Options["all"] == true, requestedChangeText, requested)
			if err != nil {
				return nil, err
			}
			landed := []any{}
			remaining := landable
			fetched := false
			remainingSummary := []any{}
			stackDeleted := false
			var stackID any = objectValue(existing)["id"]
			for i := 0; i < landCount; i++ {
				if len(remaining) == 0 {
					return nil, errors.New("Stack changed while landing. Re-run `smithers stack land`.")
				}
				change := remaining[0]
				refreshed, err := refreshStackLandChangeForCommand(owner, repo, change)
				if err != nil {
					return nil, err
				}
				if reason := stackLandabilityError(refreshed); reason != "" {
					return nil, errors.New(reason)
				}
				if err := mergePullRequest(owner, repo, refreshed.PRNumber); err != nil {
					return nil, err
				}
				landed = append(landed, stackLandedSummary(refreshed))
				remaining = remaining[1:]
				restacked, err := restackRemainingAfterLanding(owner, repo, targetRef, remaining)
				if err != nil {
					return nil, err
				}
				fetched = fetched || restacked["fetched"] == true
				remainingSummary = arrayValue(restacked["remaining"])
				stackDeleted = restacked["stack_deleted"] == true
				stackID = restacked["stack_id"]
			}
			result := map[string]any{
				"fetched":       fetched,
				"landed":        landed,
				"remaining":     remainingSummary,
				"stack_deleted": stackDeleted,
				"stack_found":   true,
				"stack_id":      stackID,
				"target":        targetRef,
			}
			if stackDeleted {
				result["stack_id"] = nil
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			return formatStackLandSummary(owner, repo, targetRef, result), nil
		},
	}
}

func stackTarget(ctx *incur.CommandContext) string {
	target := strings.TrimSpace(stringValue(ctx.Options["target"]))
	if target == "" {
		return "main"
	}
	return target
}

func githubAPI(method, path string, body any) (map[string]any, error) {
	if strings.TrimSpace(os.Getenv("GITHUB_TOKEN")) == "" {
		return githubAPIViaSmithersProxy(method, path, body)
	}

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, githubAPIBaseURL()+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-cli")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := resp.Status
		var parsed struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &parsed) == nil && strings.TrimSpace(parsed.Message) != "" {
			detail = strings.TrimSpace(parsed.Message)
		}
		return nil, &APIError{Method: method, Path: path, Status: resp.StatusCode, Detail: detail}
	}
	var out map[string]any
	if len(raw) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		var arr []any
		if err := json.Unmarshal(raw, &arr); err == nil {
			return map[string]any{"items": arr}, nil
		}
		return nil, err
	}
	return out, nil
}

func githubAPIViaSmithersProxy(method, path string, body any) (map[string]any, error) {
	owner, repo, ok := githubRepoFromAPIPath(path)
	if !ok {
		return nil, fmt.Errorf("GitHub proxy path must target /repos/{owner}/{repo}")
	}
	proxyBody := map[string]any{
		"method": method,
		"path":   path,
	}
	if body != nil {
		proxyBody["body"] = body
	}
	resp, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/github-proxy", url.PathEscape(owner), url.PathEscape(repo)), proxyBody, nil)
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, nil
	}
	if object, ok := resp.(map[string]any); ok {
		return object, nil
	}
	if items, ok := resp.([]any); ok {
		return map[string]any{"items": items}, nil
	}
	return nil, fmt.Errorf("GitHub proxy returned unsupported response")
}

func githubRepoFromAPIPath(path string) (owner string, repo string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(path))
	if err != nil {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "repos" {
		return "", "", false
	}
	owner, err = githubPathUnescape(parts[1])
	if err != nil {
		return "", "", false
	}
	repo, err = githubPathUnescape(parts[2])
	if err != nil {
		return "", "", false
	}
	return owner, repo, strings.TrimSpace(owner) != "" && strings.TrimSpace(repo) != ""
}

func githubAuthSource() string {
	if strings.TrimSpace(os.Getenv("GITHUB_TOKEN")) != "" {
		return "github_token"
	}
	return "server_github_app_installation"
}

func githubNotFound(err error) bool {
	apiErr, ok := err.(*APIError)
	return ok && apiErr.Status == http.StatusNotFound
}

func githubUnprocessableOrMissing(err error) bool {
	apiErr, ok := err.(*APIError)
	return ok && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusUnprocessableEntity)
}

func shortChangeID(changeID string) string {
	if len(changeID) <= 8 {
		return changeID
	}
	return changeID[:8]
}

func splitDescription(changeID, description string) (string, string) {
	trimmed := strings.TrimSpace(description)
	if trimmed == "" {
		return changeID, ""
	}
	lines := strings.Split(trimmed, "\n")
	title := strings.TrimSpace(lines[0])
	body := ""
	if len(lines) > 1 {
		body = strings.TrimSpace(strings.Join(lines[1:], "\n"))
	}
	return title, body
}

func isDivergedPushError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "last fetched") ||
		strings.Contains(message, "jj git fetch") ||
		strings.Contains(message, "remote bookmark") ||
		strings.Contains(message, "unexpectedly moved")
}

func renderStackBlock(changes []submittedStackChange, currentChangeID string) string {
	lines := []string{
		stackMarkerStart,
		"### Smithers Stack",
		"",
		"| | Change | PR | Branch |",
		"|---|---|---|---|",
	}
	for _, change := range changes {
		marker := ""
		title := change.Title
		if change.ChangeID == currentChangeID {
			marker = "\u2192"
			title = "**" + title + "**"
		}
		lines = append(lines, fmt.Sprintf("| %s | %s | #%d | `%s` |", marker, title, change.PRNumber, change.Branch))
	}
	lines = append(lines,
		"",
		"> \u26a0\ufe0f Do not merge this PR directly. Use `smithers stack land` to land changes in order.",
		"",
		"*Managed by Smithers*",
		stackMarkerEnd,
	)
	return strings.Join(lines, "\n")
}

func stripExistingStackBlock(body string) string {
	start := strings.Index(body, stackMarkerStart)
	if start == -1 {
		return strings.TrimSpace(body)
	}
	end := strings.Index(body[start:], stackMarkerEnd)
	if end == -1 {
		return strings.TrimSpace(body)
	}
	end += start
	before := strings.TrimSpace(body[:start])
	after := strings.TrimSpace(body[end+len(stackMarkerEnd):])
	parts := []string{}
	if before != "" {
		parts = append(parts, before)
	}
	if after != "" {
		parts = append(parts, after)
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func composePRBody(descriptionBody, stackBlock string) string {
	cleaned := stripExistingStackBlock(descriptionBody)
	if cleaned == "" {
		return stackBlock
	}
	return cleaned + "\n\n" + stackBlock
}

func loadExistingStack(owner, repo, targetRef string) (any, error) {
	stack, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/stacks/active?target_ref=%s", owner, repo, url.QueryEscape(targetRef)), nil, nil)
	if err != nil {
		if apiErr, ok := err.(*APIError); ok && apiErr.Status == http.StatusNotFound {
			return nil, nil
		}
		return nil, err
	}
	return stack, nil
}

func deleteActiveStackMapping(owner, repo, targetRef string) error {
	_, err := APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/stacks/active?target_ref=%s", owner, repo, url.QueryEscape(targetRef)), nil, nil)
	if err != nil {
		if apiErr, ok := err.(*APIError); ok && apiErr.Status == http.StatusNotFound {
			return nil
		}
		return err
	}
	return nil
}

func persistStackMapping(owner, repo, targetRef string, submitted []submittedStackChange, statuses []stackLandChange) (any, error) {
	changes := make([]map[string]any, 0, len(submitted))
	for index, change := range submitted {
		ciStatus := "pending"
		reviewStatus := "pending"
		if index < len(statuses) {
			ciStatus = statuses[index].CIStatus
			reviewStatus = statuses[index].ReviewStatus
		}
		changes = append(changes, map[string]any{
			"branch_name":   change.Branch,
			"change_id":     change.ChangeID,
			"ci_status":     ciStatus,
			"position":      change.Position,
			"pr_number":     change.PRNumber,
			"pr_state":      change.PRState,
			"review_status": reviewStatus,
		})
	}
	return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/stacks/active", owner, repo), map[string]any{
		"changes":    changes,
		"target_ref": targetRef,
	}, nil)
}

func stackChangesByID(changes []any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, raw := range changes {
		record := objectValue(raw)
		if changeID := strings.TrimSpace(stringValue(record["change_id"])); changeID != "" {
			out[changeID] = record
		}
	}
	return out
}

func stackSubmittedField(changes []submittedStackChange, field string) []any {
	out := make([]any, 0, len(changes))
	for _, change := range changes {
		switch field {
		case "change_id":
			out = append(out, change.ChangeID)
		case "pr_number":
			out = append(out, change.PRNumber)
		}
	}
	return out
}

func stackSubmittedChanges(changes []submittedStackChange) []map[string]any {
	out := make([]map[string]any, 0, len(changes))
	for _, change := range changes {
		out = append(out, map[string]any{
			"auth_source": githubAuthSource(),
			"branch":      change.Branch,
			"change_id":   change.ChangeID,
			"pr_number":   change.PRNumber,
			"pr_url":      change.PRURL,
			"push_target": "origin/" + change.Branch,
			"status":      change.Status,
			"title":       change.Title,
		})
	}
	return out
}

func resolveStackBranchName(change map[string]any) string {
	if branch := strings.TrimSpace(stringValue(change["branch_name"])); branch != "" {
		return branch
	}
	changeID := strings.TrimSpace(stringValue(change["change_id"]))
	if changeID == "" {
		return ""
	}
	return "smithers/" + shortChangeID(changeID)
}

func closePullRequestIfOpen(owner, repo string, prNumber int) (string, error) {
	pull, err := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), prNumber), nil)
	if err != nil {
		if githubNotFound(err) {
			return "missing", nil
		}
		return "", err
	}
	if normalizePRState(pull["state"]) != "open" {
		return "already_closed", nil
	}
	if _, err := githubAPI("PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), prNumber), map[string]any{"state": "closed"}); err != nil {
		if githubNotFound(err) {
			return "missing", nil
		}
		apiErr, ok := err.(*APIError)
		if ok && apiErr.Status == http.StatusUnprocessableEntity {
			refreshed, refreshErr := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), prNumber), nil)
			if refreshErr != nil {
				if githubNotFound(refreshErr) {
					return "missing", nil
				}
			} else if normalizePRState(refreshed["state"]) != "open" {
				return "already_closed", nil
			}
		}
		return "", err
	}
	return "closed", nil
}

func deleteRemoteBranchIfExists(owner, repo, branch string) (string, error) {
	_, err := githubAPI("DELETE", fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch)), nil)
	if err != nil {
		if githubUnprocessableOrMissing(err) {
			return "missing", nil
		}
		return "", err
	}
	return "deleted", nil
}

func normalizeMappedStackChanges(changes []any) []map[string]any {
	out := []map[string]any{}
	for _, raw := range changes {
		record := objectValue(raw)
		if strings.TrimSpace(stringValue(record["change_id"])) != "" {
			out = append(out, record)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return intValue(out[i]["position"], 1<<30) < intValue(out[j]["position"], 1<<30)
	})
	return out
}

func syncStack(owner, repo, targetRef string) (map[string]any, error) {
	if err := FetchGitRemote(); err != nil {
		return nil, err
	}
	existing, err := loadExistingStack(owner, repo, targetRef)
	if err != nil {
		return nil, err
	}
	if existing == nil || intValue(objectValue(existing)["id"], 0) == 0 {
		return map[string]any{"fetched": true, "merged": []any{}, "remaining": []any{}, "stack_deleted": false, "stack_found": false, "stack_id": nil, "target": targetRef}, nil
	}
	mappedChanges := normalizeMappedStackChanges(arrayValue(objectValue(existing)["changes"]))
	localStack, err := ListLocalStackChanges(targetRef)
	if err != nil {
		return nil, err
	}
	localByID := map[string]LocalStackChange{}
	for _, change := range localStack {
		localByID[change.ChangeID] = change
	}
	merged := []any{}
	remainingStatuses := []stackLandChange{}
	submitted := []submittedStackChange{}
	for _, mapped := range mappedChanges {
		changeID := stringValue(mapped["change_id"])
		branch := resolveStackBranchName(mapped)
		prNumber := intValue(mapped["pr_number"], 0)
		if prNumber <= 0 {
			return nil, fmt.Errorf("Stack mapping for change %s is missing pr_number. Run `smithers stack submit` first.", changeID)
		}
		pull, err := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), prNumber), nil)
		if err != nil {
			return nil, err
		}
		if normalizePRState(pull["state"]) == "closed" && pull["merged"] == true {
			merged = append(merged, map[string]any{"branch": branch, "change_id": changeID, "pr_number": prNumber})
			continue
		}
		local, ok := localByID[changeID]
		if !ok {
			return nil, fmt.Errorf("Local stack is missing change %s. Recreate it locally, then run `smithers stack submit`.", changeID)
		}
		title, body := splitDescription(changeID, local.Description)
		remainingStatuses = append(remainingStatuses, stackLandChange{
			Branch:       branch,
			ChangeID:     changeID,
			CIStatus:     normalizeCIStatus(mapped["ci_status"]),
			PRNumber:     prNumber,
			PRState:      defaultString(normalizePRState(pull["state"]), defaultString(normalizePRState(mapped["pr_state"]), "open")),
			PRURL:        defaultString(stringValue(pull["html_url"]), defaultString(stringValue(mapped["pr_url"]), pullRequestURL(owner, repo, prNumber))),
			ReviewStatus: normalizeReviewStatus(mapped["review_status"]),
		})
		submitted = append(submitted, submittedStackChange{
			Branch:          branch,
			ChangeID:        changeID,
			DescriptionBody: body,
			Position:        len(submitted),
			PRNumber:        prNumber,
			PRState:         normalizePRState(pull["state"]),
			PRURL:           defaultString(stringValue(pull["html_url"]), stringValue(mapped["pr_url"])),
			Status:          "updated",
			Title:           title,
		})
	}
	if len(submitted) == 0 {
		if err := deleteActiveStackMapping(owner, repo, targetRef); err != nil {
			return nil, err
		}
		return map[string]any{"fetched": true, "merged": merged, "remaining": []any{}, "stack_deleted": true, "stack_found": true, "stack_id": nil, "target": targetRef}, nil
	}
	if _, err := restackSubmitted(owner, repo, targetRef, submitted, remainingStatuses); err != nil {
		return nil, err
	}
	persisted, err := persistStackMapping(owner, repo, targetRef, submitted, remainingStatuses)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"fetched":       true,
		"merged":        merged,
		"remaining":     stackRemainingSummary(submitted),
		"stack_deleted": false,
		"stack_found":   true,
		"stack_id":      objectValue(persisted)["id"],
		"target":        targetRef,
	}, nil
}

func restackSubmitted(owner, repo, targetRef string, submitted []submittedStackChange, statuses []stackLandChange) ([]submittedStackChange, error) {
	for index, change := range submitted {
		destination := targetRef
		if index > 0 {
			destination = submitted[index-1].ChangeID
		}
		if err := RebaseLocalChange(change.ChangeID, destination); err != nil {
			return nil, err
		}
	}
	for _, change := range submitted {
		if err := SetLocalBookmark(change.Branch, change.ChangeID); err != nil {
			return nil, err
		}
		if err := PushLocalBookmark(change.Branch); err != nil {
			if isDivergedPushError(err) {
				return nil, fmt.Errorf("Remote branch %s has diverged after fetch. Re-run `smithers stack sync`.", change.Branch)
			}
			return nil, err
		}
	}
	for index, change := range submitted {
		baseBranch := targetRef
		if index > 0 {
			baseBranch = submitted[index-1].Branch
		}
		stackBlock := renderStackBlock(submitted, change.ChangeID)
		updated, err := githubAPI("PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), change.PRNumber), map[string]any{
			"base":  baseBranch,
			"body":  composePRBody(change.DescriptionBody, stackBlock),
			"title": change.Title,
		})
		if err != nil {
			return nil, err
		}
		if state := stringValue(updated["state"]); state != "" {
			submitted[index].PRState = state
		}
		if htmlURL := stringValue(updated["html_url"]); htmlURL != "" {
			submitted[index].PRURL = htmlURL
		}
	}
	return submitted, nil
}

func restackRemainingAfterLanding(owner, repo, targetRef string, remaining []stackLandChange) (map[string]any, error) {
	if err := FetchGitRemote(); err != nil {
		return nil, err
	}
	if len(remaining) == 0 {
		if err := deleteActiveStackMapping(owner, repo, targetRef); err != nil {
			return nil, err
		}
		return map[string]any{"fetched": true, "stack_deleted": true, "remaining": []any{}, "stack_id": nil}, nil
	}
	localStack, err := ListLocalStackChanges(targetRef)
	if err != nil {
		return nil, err
	}
	localByID := map[string]LocalStackChange{}
	for _, change := range localStack {
		localByID[change.ChangeID] = change
	}
	submitted := []submittedStackChange{}
	for index, change := range remaining {
		local, ok := localByID[change.ChangeID]
		if !ok {
			return nil, fmt.Errorf("Local stack is missing change %s. Recreate it locally, then run `smithers stack submit`.", change.ChangeID)
		}
		title, body := splitDescription(change.ChangeID, local.Description)
		submitted = append(submitted, submittedStackChange{
			Branch:          change.Branch,
			ChangeID:        change.ChangeID,
			DescriptionBody: body,
			Position:        index,
			PRNumber:        change.PRNumber,
			PRState:         change.PRState,
			PRURL:           change.PRURL,
			Status:          "updated",
			Title:           title,
		})
	}
	if _, err := restackSubmitted(owner, repo, targetRef, submitted, remaining); err != nil {
		return nil, err
	}
	persisted, err := persistStackMapping(owner, repo, targetRef, submitted, remaining)
	if err != nil {
		return nil, err
	}
	return map[string]any{"fetched": true, "stack_deleted": false, "remaining": stackRemainingSummary(submitted), "stack_id": objectValue(persisted)["id"]}, nil
}

func stackRemainingSummary(submitted []submittedStackChange) []any {
	out := make([]any, 0, len(submitted))
	for _, change := range submitted {
		out = append(out, map[string]any{
			"auth_source": githubAuthSource(),
			"branch":      change.Branch,
			"change_id":   change.ChangeID,
			"pr_number":   change.PRNumber,
			"pr_url":      change.PRURL,
			"push_target": "origin/" + change.Branch,
			"title":       change.Title,
		})
	}
	return out
}

func stackLandedSummary(change stackLandChange) map[string]any {
	return map[string]any{
		"auth_source": githubAuthSource(),
		"branch":      change.Branch,
		"change_id":   change.ChangeID,
		"pr_number":   change.PRNumber,
		"pr_url":      change.PRURL,
		"push_target": "origin/" + change.Branch,
	}
}

type stackLandChange struct {
	Branch       string
	ChangeID     string
	CIStatus     string
	PRNumber     int
	PRState      string
	PRURL        string
	ReviewStatus string
}

func buildStackLandChanges(owner, repo string, mapped []map[string]any) ([]stackLandChange, error) {
	out := []stackLandChange{}
	for _, change := range mapped {
		branch := resolveStackBranchName(change)
		changeID := stringValue(change["change_id"])
		prNumber := intValue(change["pr_number"], 0)
		if branch == "" {
			return nil, fmt.Errorf("Unable to resolve branch for stack change %s", changeID)
		}
		if prNumber <= 0 {
			return nil, fmt.Errorf("Stack mapping for change %s is missing pr_number. Run `smithers stack submit` first.", changeID)
		}
		status := stackLandChange{
			Branch:       branch,
			ChangeID:     changeID,
			CIStatus:     normalizeCIStatus(change["ci_status"]),
			PRNumber:     prNumber,
			PRState:      defaultString(normalizePRState(change["pr_state"]), "open"),
			PRURL:        defaultString(stringValue(change["pr_url"]), pullRequestURL(owner, repo, prNumber)),
			ReviewStatus: normalizeReviewStatus(change["review_status"]),
		}
		refreshed, err := refreshStackLandChange(owner, repo, status)
		if err != nil {
			return nil, err
		}
		out = append(out, refreshed)
	}
	return out, nil
}

func refreshStackLandChange(owner, repo string, change stackLandChange) (stackLandChange, error) {
	enriched, err := enrichStatusChangeForRefresh(owner, repo, map[string]any{
		"branch_name":   change.Branch,
		"change_id":     change.ChangeID,
		"ci_status":     change.CIStatus,
		"pr_number":     change.PRNumber,
		"pr_state":      change.PRState,
		"pr_url":        change.PRURL,
		"review_status": change.ReviewStatus,
	}, true)
	if err != nil {
		return change, err
	}
	change.CIStatus = normalizeCIStatus(enriched["ci_status"])
	change.ReviewStatus = normalizeReviewStatus(enriched["review_status"])
	change.PRState = defaultString(normalizePRState(enriched["pr_state"]), change.PRState)
	change.PRURL = defaultString(stringValue(enriched["pr_url"]), change.PRURL)
	return change, nil
}

func stackLandabilityError(change stackLandChange) string {
	changeRef := shortChangeID(change.ChangeID) + fmt.Sprintf(" (PR #%d)", change.PRNumber)
	if change.ReviewStatus != "approved" {
		detail := "pending review"
		if change.ReviewStatus == "changes_requested" {
			detail = "changes requested"
		}
		return "Refusing to land " + changeRef + ": review is " + detail + "."
	}
	if change.CIStatus != "passing" {
		return "Refusing to land " + changeRef + ": CI is " + change.CIStatus + "."
	}
	prState := normalizePRState(change.PRState)
	if prState != "open" {
		if prState == "" {
			prState = "unknown"
		}
		return "Refusing to land " + changeRef + ": PR is " + prState + ". Run `smithers stack sync` first."
	}
	return ""
}

func selectStackLandCount(changes []stackLandChange, all bool, requestedChange string, hasRequested bool) (int, error) {
	if len(changes) == 0 {
		return 0, errors.New("Active stack has no changes to land.")
	}
	if hasRequested {
		index := -1
		for i, change := range changes {
			if change.ChangeID == requestedChange || strings.HasPrefix(change.ChangeID, requestedChange) {
				if index != -1 {
					return 0, fmt.Errorf("Change prefix %q is ambiguous in the active stack.", requestedChange)
				}
				index = i
			}
		}
		if index == -1 {
			return 0, fmt.Errorf("Change %s was not found in the active stack.", requestedChange)
		}
		for i := 0; i <= index; i++ {
			if reason := stackLandabilityError(changes[i]); reason != "" {
				return 0, errors.New(reason)
			}
		}
		return index + 1, nil
	}
	if all {
		count := 0
		for count < len(changes) && stackLandabilityError(changes[count]) == "" {
			count++
		}
		if count == 0 {
			return 0, errors.New(stackLandabilityError(changes[0]))
		}
		return count, nil
	}
	if reason := stackLandabilityError(changes[0]); reason != "" {
		return 0, errors.New(reason)
	}
	return 1, nil
}

func mergePullRequest(owner, repo string, prNumber int) error {
	methods := stackMergeMethods
	var rejected error
	for _, method := range methods {
		response, err := githubAPI("PUT", fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", url.PathEscape(owner), url.PathEscape(repo), prNumber), map[string]any{"merge_method": method})
		if err == nil {
			if response != nil && response["merged"] == false {
				return fmt.Errorf("GitHub did not merge PR #%d.", prNumber)
			}
			return nil
		}
		if apiErr, ok := err.(*APIError); ok {
			switch apiErr.Status {
			case http.StatusNotFound:
				return fmt.Errorf("PR #%d was not found on GitHub.", prNumber)
			case http.StatusMethodNotAllowed:
				rejected = err
				continue
			case http.StatusConflict, http.StatusUnprocessableEntity:
				return fmt.Errorf("Failed to merge PR #%d: %s", prNumber, apiErr.Detail)
			}
		}
		return err
	}
	if rejected != nil {
		return fmt.Errorf("Failed to merge PR #%d: GitHub rejected available merge methods (%s): %s", prNumber, strings.Join(methods, ", "), rejected.Error())
	}
	return fmt.Errorf("Failed to merge PR #%d.", prNumber)
}

func buildStackStatus(owner, repo, targetRef string, existing any) (map[string]any, error) {
	if existing == nil || intValue(objectValue(existing)["id"], 0) == 0 {
		return map[string]any{"changes": []any{}, "stack_id": nil, "state": "inactive", "target": targetRef}, nil
	}
	localStack, _ := ListLocalStackChanges(targetRef)
	existingByID := stackChangesByID(arrayValue(objectValue(existing)["changes"]))
	used := map[string]struct{}{}
	changes := []any{}
	for _, local := range localStack {
		used[local.ChangeID] = struct{}{}
		change := composeStatusChange(owner, repo, local, existingByID[local.ChangeID])
		enriched, _ := enrichStatusChangeWithGitHub(owner, repo, change, false)
		changes = append(changes, enriched)
	}
	unmatched := normalizeMappedStackChanges(arrayValue(objectValue(existing)["changes"]))
	for _, mapped := range unmatched {
		changeID := stringValue(mapped["change_id"])
		if _, ok := used[changeID]; ok {
			continue
		}
		change := composeStatusChange(owner, repo, LocalStackChange{}, mapped)
		enriched, _ := enrichStatusChangeWithGitHub(owner, repo, change, false)
		changes = append(changes, enriched)
	}
	state := defaultString(stringValue(objectValue(existing)["state"]), "active")
	target := defaultString(stringValue(objectValue(existing)["target_ref"]), targetRef)
	return map[string]any{"changes": changes, "stack_id": objectValue(existing)["id"], "state": state, "target": target}, nil
}

func composeStatusChange(owner, repo string, local LocalStackChange, mapped map[string]any) map[string]any {
	changeID := local.ChangeID
	title := ""
	if changeID != "" {
		title, _ = splitDescription(local.ChangeID, local.Description)
	} else {
		changeID = stringValue(mapped["change_id"])
		title = changeID
	}
	prNumber := intValue(mapped["pr_number"], 0)
	var prNumberValue any
	if prNumber > 0 {
		prNumberValue = prNumber
	}
	prURL := stringValue(mapped["pr_url"])
	if prURL == "" && prNumber > 0 {
		prURL = pullRequestURL(owner, repo, prNumber)
	}
	prState := normalizePRState(mapped["pr_state"])
	if prState == "" && prNumber > 0 {
		prState = "open"
	}
	return map[string]any{
		"branch_name":   stringValue(mapped["branch_name"]),
		"change_id":     changeID,
		"ci_status":     normalizeCIStatus(mapped["ci_status"]),
		"checks":        []any{},
		"description":   title,
		"mergeable":     false,
		"pr_number":     prNumberValue,
		"pr_state":      nullableString(prState),
		"pr_url":        nullableString(prURL),
		"review_status": normalizeReviewStatus(mapped["review_status"]),
		"reviewers":     []any{},
	}
}

func enrichStatusChangeWithGitHub(owner, repo string, change map[string]any, strict bool) (map[string]any, error) {
	prNumber := intValue(change["pr_number"], 0)
	if prNumber <= 0 {
		return change, nil
	}
	if strings.TrimSpace(os.Getenv("GITHUB_TOKEN")) == "" {
		if strict {
			change["checks"] = []any{}
			change["ci_status"] = "pending"
			change["mergeable"] = false
			change["review_status"] = "pending"
			change["reviewers"] = []any{}
		}
		return change, nil
	}
	pull, err := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), prNumber), nil)
	if err != nil {
		if strict {
			change["ci_status"] = "pending"
			change["review_status"] = "pending"
		}
		return change, nil
	}
	if mergeable, ok := pull["mergeable"].(bool); ok {
		change["mergeable"] = mergeable
	}
	if state := normalizePRState(pull["state"]); state != "" {
		change["pr_state"] = state
	}
	if htmlURL := stringValue(pull["html_url"]); htmlURL != "" {
		change["pr_url"] = htmlURL
	}
	headSHA := stringValue(objectValue(pull["head"])["sha"])
	if headSHA != "" {
		checkRuns, err := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(headSHA)), nil)
		if err == nil {
			runs := arrayValue(checkRuns["check_runs"])
			checks := []any{}
			statuses := []string{}
			for _, run := range runs {
				record := objectValue(run)
				status := checkRunStatus(record)
				statuses = append(statuses, status)
				name := stringValue(record["name"])
				if name == "" {
					name = "unnamed check"
				}
				checks = append(checks, map[string]any{"name": name, "status": status})
			}
			change["checks"] = checks
			change["ci_status"] = aggregateCheckStatus(statuses)
		} else if strict {
			change["ci_status"] = "pending"
		}
	}
	reviews, err := githubAPI("GET", fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", url.PathEscape(owner), url.PathEscape(repo), prNumber), nil)
	if err == nil {
		status, reviewers := aggregateReviewStatus(arrayValue(reviews["items"]))
		change["review_status"] = status
		change["reviewers"] = reviewers
	} else if strict {
		change["review_status"] = "pending"
		change["reviewers"] = []any{}
	}
	return change, nil
}

func normalizeReviewStatus(value any) string {
	normalized := strings.ToLower(strings.TrimSpace(stringValue(value)))
	switch normalized {
	case "approved":
		return "approved"
	case "changes_requested", "changes-requested", "changes requested":
		return "changes_requested"
	default:
		return "pending"
	}
}

func normalizeCIStatus(value any) string {
	normalized := strings.ToLower(strings.TrimSpace(stringValue(value)))
	switch normalized {
	case "passing", "success", "passed":
		return "passing"
	case "failing", "failure", "failed", "error", "cancelled", "canceled":
		return "failing"
	default:
		return "pending"
	}
}

func normalizePRState(value any) string {
	return strings.ToLower(strings.TrimSpace(stringValue(value)))
}

func checkRunStatus(run map[string]any) string {
	status := strings.ToLower(strings.TrimSpace(stringValue(run["status"])))
	conclusion := strings.ToLower(strings.TrimSpace(stringValue(run["conclusion"])))
	if status != "completed" || conclusion == "" {
		return "pending"
	}
	switch conclusion {
	case "success", "neutral", "skipped":
		return "success"
	case "failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale":
		return "failure"
	default:
		return "pending"
	}
}

func aggregateCheckStatus(statuses []string) string {
	if len(statuses) == 0 {
		return "pending"
	}
	hasPending := false
	for _, status := range statuses {
		if status == "failure" {
			return "failing"
		}
		if status == "pending" {
			hasPending = true
		}
	}
	if hasPending {
		return "pending"
	}
	return "passing"
}

func aggregateReviewStatus(reviews []any) (string, []any) {
	latest := map[string]map[string]any{}
	for _, raw := range reviews {
		review := objectValue(raw)
		login := strings.TrimSpace(stringValue(objectValue(review["user"])["login"]))
		if login == "" {
			continue
		}
		state := normalizeReviewStatus(review["state"])
		if state != "approved" && state != "changes_requested" {
			continue
		}
		latest[strings.ToLower(login)] = map[string]any{"login": login, "state": state}
	}
	keys := make([]string, 0, len(latest))
	for key := range latest {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	reviewers := []any{}
	status := "pending"
	for _, key := range keys {
		reviewer := latest[key]
		reviewers = append(reviewers, reviewer)
		if reviewer["state"] == "changes_requested" {
			status = "changes_requested"
		} else if status != "changes_requested" && reviewer["state"] == "approved" {
			status = "approved"
		}
	}
	return status, reviewers
}

func pullRequestURL(owner, repo string, prNumber int) string {
	if prNumber <= 0 {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, prNumber)
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func formatStackSubmitSummary(owner, repo string, submitted []submittedStackChange) string {
	lines := []string{fmt.Sprintf("Submitted stack (%d changes) -> %s/%s", len(submitted), owner, repo), ""}
	for _, change := range submitted {
		lines = append(lines, fmt.Sprintf("  #%d %s %s %s", change.PRNumber, change.Title, change.Branch, change.Status))
	}
	return strings.Join(lines, "\n")
}

func formatStackUnsubmitSummary(owner, repo, targetRef string, result map[string]any) string {
	if result["stack_deleted"] != true {
		return fmt.Sprintf("No active stack for %s/%s (target: %s)", owner, repo, targetRef)
	}
	return fmt.Sprintf("Unsubmitted stack -> %s/%s (target: %s)", owner, repo, targetRef)
}

func formatStackSyncSummary(owner, repo, targetRef string, result map[string]any) string {
	if result["stack_found"] != true {
		return fmt.Sprintf("No active stack for %s/%s (target: %s)", owner, repo, targetRef)
	}
	lines := []string{fmt.Sprintf("Synced stack -> %s/%s (target: %s)", owner, repo, targetRef), ""}
	lines = append(lines, fmt.Sprintf("  Merged PRs removed: %s", stackPRList(arrayValue(result["merged"]))))
	if result["stack_deleted"] == true {
		lines = append(lines, "  Remaining PRs: (none)", "  Backend stack mapping removed.")
		return strings.Join(lines, "\n")
	}
	lines = append(lines, fmt.Sprintf("  Remaining PRs: %s", stackPRList(arrayValue(result["remaining"]))))
	return strings.Join(lines, "\n")
}

func formatStackLandSummary(owner, repo, targetRef string, result map[string]any) string {
	if result["stack_found"] != true {
		return fmt.Sprintf("No active stack for %s/%s (target: %s)", owner, repo, targetRef)
	}
	lines := []string{fmt.Sprintf("Landed stack -> %s/%s (target: %s)", owner, repo, targetRef), ""}
	lines = append(lines, fmt.Sprintf("  PRs merged: %s", stackPRList(arrayValue(result["landed"]))))
	if result["stack_deleted"] == true {
		lines = append(lines, "  Remaining PRs: (none)", "  Backend stack mapping removed.")
		return strings.Join(lines, "\n")
	}
	lines = append(lines, fmt.Sprintf("  Remaining PRs: %s", stackPRList(arrayValue(result["remaining"]))))
	return strings.Join(lines, "\n")
}

func stackPRList(values []any) string {
	if len(values) == 0 {
		return "(none)"
	}
	parts := []string{}
	for _, raw := range values {
		if pr := intValue(objectValue(raw)["pr_number"], 0); pr > 0 {
			parts = append(parts, fmt.Sprintf("#%d", pr))
		}
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, ", ")
}

func formatStackStatusSummary(owner, repo, targetRef string, status map[string]any) string {
	if status["stack_id"] == nil {
		return fmt.Sprintf("No active stack for %s/%s (target: %s)", owner, repo, targetRef)
	}
	lines := []string{fmt.Sprintf("Stack -> %s/%s (target: %s)", owner, repo, stringValue(status["target"])), ""}
	changes := arrayValue(status["changes"])
	if len(changes) == 0 {
		lines = append(lines, "  (no local stack changes matched)")
		return strings.Join(lines, "\n")
	}
	for _, raw := range changes {
		change := objectValue(raw)
		prText := "(not submitted)"
		if pr := intValue(change["pr_number"], 0); pr > 0 {
			prText = fmt.Sprintf("#%d", pr)
		}
		lines = append(lines, fmt.Sprintf("  %s  %s  %s", shortChangeID(stringValue(change["change_id"])), prText, stringValue(change["description"])))
		if pr := intValue(change["pr_number"], 0); pr > 0 {
			prURL := stringValue(change["pr_url"])
			if prURL == "" {
				prURL = pullRequestURL(owner, repo, pr)
			}
			prLine := "    PR: " + prStateIndicator(normalizePRState(change["pr_state"]))
			if prURL != "" {
				prLine += " " + prURL
			}
			lines = append(lines, prLine)
		} else {
			lines = append(lines, "    PR: 🟡 Not submitted")
		}
		reviewStatus := normalizeReviewStatus(change["review_status"])
		lines = append(lines, "    Review: "+reviewIndicator(reviewStatus)+" "+formatReviewLabel(reviewStatus))
		ciStatus := normalizeCIStatus(change["ci_status"])
		lines = append(lines, "    CI: "+ciIndicator(ciStatus)+" "+formatCILabel(ciStatus))
	}
	return strings.Join(lines, "\n")
}

func prStateIndicator(state string) string {
	switch state {
	case "merged":
		return "🟢"
	case "closed":
		return "❌"
	default:
		return "🟡"
	}
}

func reviewIndicator(status string) string {
	switch status {
	case "approved":
		return "✅"
	case "changes_requested":
		return "❌"
	default:
		return "🟡"
	}
}

func ciIndicator(status string) string {
	switch status {
	case "passing":
		return "✅"
	case "failing":
		return "❌"
	default:
		return "🟡"
	}
}

func formatReviewLabel(status string) string {
	switch status {
	case "approved":
		return "Approved"
	case "changes_requested":
		return "Changes requested"
	default:
		return "Pending review"
	}
}

func formatCILabel(status string) string {
	switch status {
	case "passing":
		return "CI passing"
	case "failing":
		return "CI failing"
	default:
		return "CI pending"
	}
}
