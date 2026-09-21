package smitherscli

import (
	"fmt"
	"strings"
)

type agentIssueParams struct {
	Title                  string
	Summary                string
	ExpectedBehavior       string
	ActualBehavior         string
	ReproSteps             string
	Workaround             string
	WhyThisIsStillAProblem string
	Repo                   string
}

func resolveAgentIssueTargetRepo(explicitRepo string) (string, error) {
	if repo := strings.TrimSpace(explicitRepo); repo != "" {
		return repo, nil
	}
	config := LoadConfig()
	if repo := strings.TrimSpace(config.AgentIssueRepo); repo != "" {
		return repo, nil
	}
	return "", fmt.Errorf("No Smithers issue destination is configured. Set SMITHERS_AGENT_ISSUE_REPO or add agent_issue_repo to your Smithers config.")
}

func buildAgentIssueBody(params agentIssueParams, repoContext map[string]any) string {
	auth := objectValue(repoContext["auth"])
	remoteRepo := objectValue(repoContext["remoteRepo"])
	backend := objectValue(repoContext["backend"])
	jjStatus := objectValue(repoContext["jjStatus"])
	jjRemotes := objectValue(repoContext["jjRemotes"])

	authText := "not logged in"
	if auth != nil {
		host := stringValue(auth["host"])
		if auth["loggedIn"] == true {
			authText = "logged in to " + host
		} else {
			authText = "not logged in to " + host
		}
	}

	lines := []string{
		"## Summary",
		strings.TrimSpace(params.Summary),
		"",
		"## Startup Context",
		"- cwd: " + stringValue(repoContext["cwd"]),
		"- repo root: " + displayAgentNullable(repoContext["repoRoot"]),
		"- detected Smithers repo: " + displayAgentNullable(repoContext["repoSlug"]),
		"- auth: " + authText,
	}

	if backendName := stringValue(backend["backend"]); backendName != "" {
		lines = append(lines, "- backend: "+backendName)
	}
	if remoteRepo != nil && remoteRepo["checked"] == true {
		availability := "unavailable"
		if remoteRepo["available"] == true {
			availability = "available"
		}
		if status := stringValue(remoteRepo["status"]); status != "" {
			availability += " (" + status + ")"
		}
		lines = append(lines, "- Smithers repo availability: "+availability)
	}

	appendSection := func(title, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		lines = append(lines, "", title, strings.TrimSpace(body))
	}
	appendSection("## Expected Behavior", params.ExpectedBehavior)
	appendSection("## Actual Behavior", params.ActualBehavior)
	appendSection("## Repro Steps", params.ReproSteps)
	appendSection("## Workaround", params.Workaround)
	appendSection("## Why This Is Still A Product/UX Issue", params.WhyThisIsStillAProblem)

	if output := stringValue(jjStatus["output"]); output != "" {
		lines = append(lines, "", "## `jj status`", "```text", output, "```")
	}
	if output := stringValue(jjRemotes["output"]); output != "" {
		lines = append(lines, "", "## `jj git remote list`", "```text", output, "```")
	}

	return strings.TrimSpace(strings.Join(lines, "\n")) + "\n"
}

func createAgentIssue(params agentIssueParams, repoContext map[string]any) (any, error) {
	targetRepo, err := resolveAgentIssueTargetRepo(params.Repo)
	if err != nil {
		return nil, err
	}
	owner, repo, err := parseOwnerRepoRefOrThrow(targetRepo)
	if err != nil {
		return nil, fmt.Errorf("Invalid Smithers issue destination: %s", targetRepo)
	}
	return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/issues", owner, repo), map[string]any{
		"title": strings.TrimSpace(params.Title),
		"body":  buildAgentIssueBody(params, repoContext),
	}, nil)
}

func displayAgentNullable(value any) string {
	if value == nil {
		return "(not detected)"
	}
	text := strings.TrimSpace(stringValue(value))
	if text == "" {
		return "(not detected)"
	}
	return text
}
