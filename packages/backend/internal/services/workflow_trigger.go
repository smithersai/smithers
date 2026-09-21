package services

import (
	"encoding/json"
	"strings"
)

// WorkflowTriggerConfig is the parsed config field from workflow_definitions.config.
// Example config JSON:
//
//	{
//	  "on": {
//	    "push": { "branches": ["main", "feature/*"] },
//	    "landing_request": { "types": ["opened", "closed"] },
//	    "schedule": [{ "cron": "0 * * * *" }]
//	  },
//	  "jobs": { ... }
//	}
type WorkflowTriggerConfig struct {
	On          WorkflowOnConfig           `json:"on"`
	Concurrency *WorkflowConcurrencyConfig `json:"concurrency,omitempty"`
	Jobs        map[string]interface{}     `json:"jobs,omitempty"`
}

// WorkflowOnConfig contains the event triggers for a workflow.
type WorkflowOnConfig struct {
	Push              *PushTrigger             `json:"push,omitempty"`
	PullRequest       *ActionTypeTrigger       `json:"pull_request,omitempty"`
	PullRequestReview *ActionTypeTrigger       `json:"pull_request_review,omitempty"`
	CheckSuite        *ActionTypeTrigger       `json:"check_suite,omitempty"`
	CheckRun          *ActionTypeTrigger       `json:"check_run,omitempty"`
	StackSubmit       *StackSubmitTrigger      `json:"stack_submit,omitempty"`
	Manual            *ManualTrigger           `json:"manual,omitempty"`
	Webhook           *WebhookTrigger          `json:"webhook,omitempty"`
	Issue             *IssueTrigger            `json:"issue,omitempty"`
	Issues            *IssueTrigger            `json:"issues,omitempty"`
	IssueComment      *IssueCommentTrigger     `json:"issue_comment,omitempty"`
	LandingRequest    *LandingRequestTrigger   `json:"landing_request,omitempty"`
	Release           *ReleaseTrigger          `json:"release,omitempty"`
	Schedule          []ScheduleTrigger        `json:"schedule,omitempty"`
	WorkflowRun       *WorkflowRunTrigger      `json:"workflow_run,omitempty"`
	WorkflowArtifact  *WorkflowArtifactTrigger `json:"workflow_artifact,omitempty"`
	WorkflowDispatch  *WorkflowDispatchTrigger `json:"workflow_dispatch,omitempty"`
}

// ActionTypeTrigger configures event matching by webhook action type.
type ActionTypeTrigger struct {
	Types []string `json:"types,omitempty"`
}

// StackSubmitTrigger configures stack_submit synthetic-event matching.
type StackSubmitTrigger struct{}

// ManualTrigger configures "manual" trigger matching.
type ManualTrigger struct{}

// WebhookTrigger configures a single webhook descriptor trigger.
// Example: {"event":"pull_request.opened"}.
type WebhookTrigger struct {
	Event string `json:"event,omitempty"`
}

// WorkflowDispatchTrigger configures workflow_dispatch (manual) triggering.
type WorkflowDispatchTrigger struct {
	// Inputs defines input parameters for manual dispatch (optional).
	Inputs map[string]interface{} `json:"inputs,omitempty"`
}

// PushTrigger configures push event matching.
type PushTrigger struct {
	// Branches is a list of branch/ref glob patterns that must match.
	// If empty, all branches match.
	Branches []string `json:"branches,omitempty"`
	// Bookmarks is an alias for branches used by JJ-native workflow definitions.
	Bookmarks []string `json:"bookmarks,omitempty"`
	// Tags is a list of tag glob patterns that must match.
	Tags []string `json:"tags,omitempty"`
	// BranchesIgnore is a list of glob patterns to exclude.
	BranchesIgnore []string `json:"branches-ignore,omitempty"`
}

// LandingRequestTrigger configures landing_request event matching.
type LandingRequestTrigger struct {
	// Types is a list of landing request action types (opened, closed, synchronize, etc.)
	// If empty, all types match.
	Types []string `json:"types,omitempty"`
}

// IssueTrigger configures issues event matching.
type IssueTrigger struct {
	// Types is a list of issue action types (opened, edited, closed, reopened, labeled, assigned, etc.)
	// If empty, all types match.
	Types []string `json:"types,omitempty"`
}

// IssueCommentTrigger configures issue_comment event matching.
type IssueCommentTrigger struct {
	// Types is a list of issue comment action types (created, edited, deleted).
	// If empty, all types match.
	Types []string `json:"types,omitempty"`
}

// ReleaseTrigger configures release event matching.
type ReleaseTrigger struct {
	// Types is a list of release action types (published, updated, deleted, etc.).
	// If empty, all release actions match.
	Types []string `json:"types,omitempty"`
	// Tags is a list of release tag glob patterns that must match.
	// If empty, all release tags match.
	Tags []string `json:"tags,omitempty"`
}

// ScheduleTrigger configures cron-based triggering.
type ScheduleTrigger struct {
	Cron string `json:"cron"`
}

// WorkflowRunTrigger configures workflow_run event matching.
type WorkflowRunTrigger struct {
	// Workflows is a list of workflow names to trigger on.
	Workflows []string `json:"workflows,omitempty"`
	// Types is a list of workflow run statuses to trigger on.
	Types []string `json:"types,omitempty"`
}

// WorkflowArtifactTrigger configures workflow_artifact event matching.
type WorkflowArtifactTrigger struct {
	// Workflows is a list of source workflow names to trigger on.
	// If empty, artifacts from any workflow match.
	Workflows []string `json:"workflows,omitempty"`
	// Names is a list of artifact name glob patterns that must match.
	// If empty, any artifact name matches.
	Names []string `json:"names,omitempty"`
}

// TriggerEvent represents an incoming event that may trigger workflow runs.
type TriggerEvent struct {
	// Type is the event type (push, issues, issue_comment, landing_request, release, schedule, workflow_run, workflow_artifact, workflow_dispatch).
	Type string
	// Ref is the git ref (branch or tag name, e.g. "main", "refs/heads/main").
	Ref string
	// CommitSHA is the commit sha associated with this event.
	CommitSHA string
	// ChangeID is the JJ change identifier when one is available for the event.
	ChangeID string
	// Action is the event action sub-type (e.g. "opened", "closed" for landing_request/issues, "created" for issue_comment, "published" for release).
	Action string
	// ArtifactName is the artifact name associated with workflow_artifact events.
	ArtifactName string
	// SourceWorkflow is the source workflow name associated with workflow_run and workflow_artifact events.
	SourceWorkflow string
	// Inputs holds user-provided input values for workflow_dispatch events.
	Inputs map[string]interface{}
}

// MatchTrigger reports whether the workflow trigger config matches the given event.
// Returns true if the event should trigger a workflow run.
func MatchTrigger(configJSON json.RawMessage, event TriggerEvent) (bool, error) {
	if len(configJSON) == 0 {
		return false, nil
	}

	var cfg WorkflowTriggerConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false, err
	}

	return matchesOn(cfg.On, normalizeTriggerEvent(event)), nil
}

func matchesOn(on WorkflowOnConfig, event TriggerEvent) bool {
	matched := false
	switch normalizeTriggerName(event.Type) {
	case "push":
		matched = on.Push != nil && matchesPush(*on.Push, event.Ref)
	case "pull_request":
		matched = on.PullRequest != nil && matchesActionTypes(on.PullRequest.Types, event.Action)
	case "pull_request_review":
		matched = on.PullRequestReview != nil && matchesActionTypes(on.PullRequestReview.Types, event.Action)
	case "check_suite":
		matched = on.CheckSuite != nil && matchesActionTypes(on.CheckSuite.Types, event.Action)
	case "check_run":
		matched = on.CheckRun != nil && matchesActionTypes(on.CheckRun.Types, event.Action)
	case "stack_submit":
		matched = on.StackSubmit != nil
	case "issue":
		matched = (on.Issue != nil && matchesIssue(*on.Issue, event.Action)) ||
			(on.Issues != nil && matchesIssue(*on.Issues, event.Action))
	case "issue_comment":
		matched = on.IssueComment != nil && matchesIssueComment(*on.IssueComment, event.Action)
	case "landing_request":
		matched = on.LandingRequest != nil && matchesLandingRequest(*on.LandingRequest, event.Action)
	case "release":
		matched = on.Release != nil && matchesRelease(*on.Release, event.Ref, event.Action)
	case "schedule":
		matched = len(on.Schedule) > 0
	case "workflow_run":
		matched = on.WorkflowRun != nil && matchesWorkflowRun(*on.WorkflowRun, event)
	case "workflow_artifact":
		matched = on.WorkflowArtifact != nil && matchesWorkflowArtifact(*on.WorkflowArtifact, event)
	case "manual":
		matched = on.Manual != nil || on.WorkflowDispatch != nil
	case "workflow_dispatch":
		matched = on.WorkflowDispatch != nil || on.Manual != nil
	default:
		matched = false
	}

	if matched {
		return true
	}
	if on.Webhook == nil {
		return false
	}
	eventType, eventAction := parseWebhookDescriptor(on.Webhook.Event)
	if eventType == "" || eventType != normalizeTriggerName(event.Type) {
		return false
	}
	return eventAction == "" || eventAction == strings.ToLower(strings.TrimSpace(event.Action))
}

// matchesPush returns true if the push event ref matches the trigger config.
func matchesPush(t PushTrigger, ref string) bool {
	// Normalize ref: strip "refs/heads/" or "refs/tags/" prefix
	branch := normalizeBranchRef(ref)
	tag := normalizeTagRef(ref)
	isTag := strings.HasPrefix(ref, "refs/tags/")
	branchPatterns := t.Branches
	if len(branchPatterns) == 0 {
		branchPatterns = t.Bookmarks
	}

	// If tags patterns are set and this is a tag push, match against tags.
	if isTag {
		if len(t.Tags) == 0 {
			// No tag patterns means tags aren't enabled for this trigger (push.branches)
			return false
		}
		return matchesGlobList(t.Tags, tag)
	}

	// Non-tag push: if only tag patterns are configured and no branch patterns,
	// this is a tags-only trigger and should not match branch pushes.
	if len(t.Tags) > 0 && len(branchPatterns) == 0 && len(t.BranchesIgnore) == 0 {
		return false
	}

	// Branch push
	if len(t.BranchesIgnore) > 0 && matchesGlobList(t.BranchesIgnore, branch) {
		return false
	}

	// Empty branches list means match all branches.
	if len(branchPatterns) == 0 {
		return true
	}

	return matchesGlobList(branchPatterns, branch)
}

// matchesLandingRequest returns true if the action matches the trigger types.
func matchesLandingRequest(t LandingRequestTrigger, action string) bool {
	return matchesActionTypes(t.Types, action)
}

// matchesIssue returns true if the action matches the trigger types.
func matchesIssue(t IssueTrigger, action string) bool {
	return matchesActionTypes(t.Types, action)
}

// matchesIssueComment returns true if the action matches the trigger types.
func matchesIssueComment(t IssueCommentTrigger, action string) bool {
	return matchesActionTypes(t.Types, action)
}

func matchesActionTypes(types []string, action string) bool {
	if len(types) == 0 {
		return true
	}
	return containsNormalizedTriggerType(types, action)
}

func matchesRelease(t ReleaseTrigger, ref, action string) bool {
	if len(t.Types) > 0 && !containsNormalizedTriggerType(t.Types, action) {
		return false
	}
	if len(t.Tags) == 0 {
		return true
	}
	return matchesGlobList(t.Tags, normalizeTagRef(ref))
}

func matchesWorkflowRun(t WorkflowRunTrigger, event TriggerEvent) bool {
	if len(t.Types) > 0 && !containsNormalizedTriggerType(t.Types, event.Action) {
		return false
	}
	return matchesWorkflowNames(t.Workflows, event.SourceWorkflow)
}

func matchesWorkflowArtifact(t WorkflowArtifactTrigger, event TriggerEvent) bool {
	if !matchesWorkflowNames(t.Workflows, event.SourceWorkflow) {
		return false
	}
	if len(t.Names) == 0 {
		return true
	}
	return matchesGlobList(t.Names, event.ArtifactName)
}

func matchesWorkflowNames(filters []string, sourceWorkflow string) bool {
	if len(filters) == 0 {
		return true
	}
	sourceWorkflow = strings.ToLower(strings.TrimSpace(sourceWorkflow))
	if sourceWorkflow == "" {
		return false
	}
	normalizedFilters := make([]string, 0, len(filters))
	for _, filter := range filters {
		normalizedFilters = append(normalizedFilters, strings.ToLower(filter))
	}
	return matchesGlobList(normalizedFilters, sourceWorkflow)
}

func containsNormalizedTriggerType(types []string, action string) bool {
	actionLower := strings.ToLower(action)
	for _, typ := range types {
		if strings.ToLower(typ) == actionLower {
			return true
		}
	}
	return false
}

// matchesGlobList returns true if name matches any pattern in the list.
// Supports simple glob patterns with '*' and '**'.
func matchesGlobList(patterns []string, name string) bool {
	for _, pattern := range patterns {
		if matchesGlob(pattern, name) {
			return true
		}
	}
	return false
}

// matchesGlob performs simple glob matching.
// '*' matches any sequence of non-slash characters.
// '**' matches any sequence including slashes.
func matchesGlob(pattern, name string) bool {
	return globMatch(pattern, name)
}

// globTokenKind classifies a compiled glob pattern element.
type globTokenKind byte

const (
	globTokenLiteral    globTokenKind = iota // a single literal byte
	globTokenStar                            // '*': any sequence of non-slash bytes
	globTokenDoubleStar                      // '**': any sequence including slashes
)

type globToken struct {
	kind globTokenKind
	ch   byte
}

// globMatch matches a glob pattern in O(len(pattern) * len(str)) time using
// dynamic programming. Both pattern and input can be attacker-controlled
// (workflow trigger configs vs pushed ref names), so the matcher must not
// backtrack: a recursive matcher is exponential on patterns with several
// '*'/'**' segments and would pin the shared dispatch worker.
func globMatch(pattern, str string) bool {
	tokens := make([]globToken, 0, len(pattern))
	for i := 0; i < len(pattern); i++ {
		if pattern[i] != '*' {
			tokens = append(tokens, globToken{kind: globTokenLiteral, ch: pattern[i]})
			continue
		}
		if i+1 < len(pattern) && pattern[i+1] == '*' {
			tokens = append(tokens, globToken{kind: globTokenDoubleStar})
			i++
			continue
		}
		tokens = append(tokens, globToken{kind: globTokenStar})
	}

	m := len(str)
	// next[j] reports whether the already-processed pattern suffix matches str[j:].
	next := make([]bool, m+1)
	cur := make([]bool, m+1)
	next[m] = true
	for i := len(tokens) - 1; i >= 0; i-- {
		switch tok := tokens[i]; tok.kind {
		case globTokenDoubleStar:
			// '**' consumes any (possibly empty) suffix prefix: cur[j] is true
			// when the rest of the pattern matches at any position >= j.
			reachable := false
			for j := m; j >= 0; j-- {
				if next[j] {
					reachable = true
				}
				cur[j] = reachable
			}
		case globTokenStar:
			// '*' consumes zero or more non-slash bytes.
			cur[m] = next[m]
			for j := m - 1; j >= 0; j-- {
				cur[j] = next[j] || (str[j] != '/' && cur[j+1])
			}
		default:
			cur[m] = false
			for j := 0; j < m; j++ {
				cur[j] = str[j] == tok.ch && next[j+1]
			}
		}
		next, cur = cur, next
	}
	return next[0]
}

// normalizeBranchRef strips "refs/heads/" prefix from a ref.
func normalizeBranchRef(ref string) string {
	if strings.HasPrefix(ref, "refs/heads/") {
		return strings.TrimPrefix(ref, "refs/heads/")
	}
	return ref
}

// normalizeTagRef strips "refs/tags/" prefix from a ref.
func normalizeTagRef(ref string) string {
	if strings.HasPrefix(ref, "refs/tags/") {
		return strings.TrimPrefix(ref, "refs/tags/")
	}
	return ref
}

// normalizeTriggerName lowercases and trims whitespace from a trigger name.
func normalizeTriggerName(name string) string {
	normalized := strings.ToLower(strings.TrimSpace(name))
	switch normalized {
	case "issues":
		return "issue"
	case "manual_dispatch":
		return "workflow_dispatch"
	default:
		return normalized
	}
}

func normalizeTriggerEvent(event TriggerEvent) TriggerEvent {
	normalized := event
	normalized.Type = strings.ToLower(strings.TrimSpace(event.Type))
	normalized.Action = strings.ToLower(strings.TrimSpace(event.Action))

	eventType, eventAction := splitDottedEventType(normalized.Type)
	if eventType != normalized.Type {
		normalized.Type = eventType
		if normalized.Action == "" {
			normalized.Action = eventAction
		}
	}

	return normalized
}

func splitDottedEventType(eventType string) (string, string) {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(eventType)), ".", 2)
	if len(parts) != 2 {
		return eventType, ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func parseWebhookDescriptor(descriptor string) (string, string) {
	eventType, eventAction := splitDottedEventType(descriptor)
	if eventType == descriptor {
		return normalizeTriggerName(eventType), ""
	}
	return normalizeTriggerName(eventType), strings.ToLower(strings.TrimSpace(eventAction))
}
