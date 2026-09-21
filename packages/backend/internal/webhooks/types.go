package webhooks

import (
	"encoding/json"
	"time"
)

// EventType names match design spec section 6.1.
type EventType string

const (
	EventTypePush                  EventType = "push"
	EventTypeLandingRequest        EventType = "landing_request"
	EventTypeLandingRequestReview  EventType = "landing_request_review"
	EventTypeLandingRequestComment EventType = "landing_request_comment"
	EventTypeIssues                EventType = "issues"
	EventTypeIssueComment          EventType = "issue_comment"
	EventTypeCreate                EventType = "create"
	EventTypeDelete                EventType = "delete"
	EventTypeStar                  EventType = "star"
	EventTypeWatch                 EventType = "watch"
	EventTypeMember                EventType = "member"
	EventTypeTeam                  EventType = "team"
	EventTypeOrganization          EventType = "organization"
	EventTypeWorkflowRun           EventType = "workflow_run"
	EventTypeWorkflowArtifact      EventType = "workflow_artifact"
	EventTypeRelease               EventType = "release"
	EventTypeStatus                EventType = "status"
	EventTypePing                  EventType = "ping"
	EventTypeAgentSession          EventType = "agent.session"
	EventTypeAgentMessage          EventType = "agent.message"
	EventTypeLandingConflict       EventType = "landing.conflict"
	EventWiki                      EventType = "wiki"
)

type UserPayload struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type RepositoryPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	FullName string `json:"full_name,omitempty"`
}

type IssueLabelPayload struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type LabelPayload = IssueLabelPayload

type IssuePayload struct {
	ID                       int64               `json:"id"`
	Number                   int64               `json:"number"`
	Title                    string              `json:"title"`
	Body                     string              `json:"body"`
	State                    string              `json:"state"`
	Author                   UserPayload         `json:"author"`
	Assignees                []UserPayload       `json:"assignees,omitempty"`
	Labels                   []IssueLabelPayload `json:"labels,omitempty"`
	FixedBy                  *UserPayload        `json:"fixed_by,omitempty"`
	FixedByAgentSessionID    string              `json:"fixed_by_agent_session_id,omitempty"`
	FixedAt                  *time.Time          `json:"fixed_at,omitempty"`
	VerifiedBy               *UserPayload        `json:"verified_by,omitempty"`
	VerifiedByAgentSessionID string              `json:"verified_by_agent_session_id,omitempty"`
	VerifiedAt               *time.Time          `json:"verified_at,omitempty"`
	CreatedAt                time.Time           `json:"created_at"`
	UpdatedAt                time.Time           `json:"updated_at"`
}

type IssueCommentPayload struct {
	ID        int64       `json:"id"`
	IssueID   int64       `json:"issue_id"`
	Body      string      `json:"body"`
	Commenter string      `json:"commenter"`
	User      UserPayload `json:"user"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}

type LandingRequestPayload struct {
	Number         int64       `json:"number"`
	Title          string      `json:"title"`
	Body           string      `json:"body,omitempty"`
	State          string      `json:"state"`
	Author         UserPayload `json:"author"`
	ChangeIDs      []string    `json:"change_ids"`
	TargetBookmark string      `json:"target_bookmark"`
	ConflictStatus string      `json:"conflict_status"`
	StackSize      int64       `json:"stack_size"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

type LandingReviewPayload struct {
	ID               int64       `json:"id"`
	LandingRequestID int64       `json:"landing_request_id"`
	ReviewerKind     string      `json:"reviewer_kind"`
	Type             string      `json:"type"`
	Verdict          string      `json:"verdict,omitempty"`
	ConfidenceBucket string      `json:"confidence_bucket,omitempty"`
	Summary          string      `json:"summary,omitempty"`
	CommitID         string      `json:"commit_id"`
	Body             string      `json:"body"`
	State            string      `json:"state"`
	Reviewer         UserPayload `json:"reviewer"`
}

type LandingCommentPayload struct {
	ID                 int64           `json:"id"`
	LandingRequestID   int64           `json:"landing_request_id"`
	Path               string          `json:"path"`
	Line               int64           `json:"line"`
	Side               string          `json:"side"`
	Body               string          `json:"body"`
	CommitID           string          `json:"commit_id"`
	AnchorHash         string          `json:"anchor_hash"`
	State              string          `json:"state"`
	ResolvedInRevision json.RawMessage `json:"resolved_in_revision"`
	User               UserPayload     `json:"user"`
}

type IssueEventPayload struct {
	Action     string            `json:"action"`
	Issue      IssuePayload      `json:"issue"`
	Repository RepositoryPayload `json:"repository"`
	Sender     UserPayload       `json:"sender"`
}

type IssueCommentEventPayload struct {
	Action     string              `json:"action"`
	Issue      IssuePayload        `json:"issue"`
	Comment    IssueCommentPayload `json:"comment"`
	Repository RepositoryPayload   `json:"repository"`
	Sender     UserPayload         `json:"sender"`
}

type LandingRequestEventPayload struct {
	Action         string                `json:"action"`
	LandingRequest LandingRequestPayload `json:"landing_request"`
	Repository     RepositoryPayload     `json:"repository"`
	Sender         UserPayload           `json:"sender"`
}

type ConflictDetail struct {
	FilePath     string `json:"file_path"`
	ConflictType string `json:"conflict_type"`
}

type LandingConflictEventPayload struct {
	Action            string                      `json:"action"`
	PreviousStatus    string                      `json:"previous_status"`
	LandingRequest    LandingRequestPayload       `json:"landing_request"`
	ConflictsByChange map[string][]ConflictDetail `json:"conflicts_by_change,omitempty"`
	Repository        RepositoryPayload           `json:"repository"`
	Sender            UserPayload                 `json:"sender"`
}

type LandingRequestReviewEventPayload struct {
	Action         string                `json:"action"`
	Review         LandingReviewPayload  `json:"review"`
	LandingRequest LandingRequestPayload `json:"landing_request"`
	Repository     RepositoryPayload     `json:"repository"`
	Sender         UserPayload           `json:"sender"`
}

type LandingRequestCommentEventPayload struct {
	Action         string                `json:"action"`
	Comment        LandingCommentPayload `json:"comment"`
	LandingRequest LandingRequestPayload `json:"landing_request"`
	Repository     RepositoryPayload     `json:"repository"`
	Sender         UserPayload           `json:"sender"`
}

// PushEventPayload represents a push event webhook payload.
type PushEventPayload struct {
	Ref        string            `json:"ref"`
	Repository RepositoryPayload `json:"repository"`
	Sender     UserPayload       `json:"sender"`
}

type RepositoryEventPayload struct {
	Action     string            `json:"action"`
	Repository RepositoryPayload `json:"repository"`
	Sender     UserPayload       `json:"sender"`
}

// CommitStatusPayload represents a commit status in a webhook event.
type CommitStatusPayload struct {
	ID          int64  `json:"id"`
	SHA         string `json:"sha"`
	ChangeID    string `json:"change_id,omitempty"`
	Context     string `json:"context"`
	Status      string `json:"status"`
	Description string `json:"description"`
	TargetURL   string `json:"target_url,omitempty"`
}

// CommitStatusEventPayload is the payload for commit status webhook events.
type CommitStatusEventPayload struct {
	CommitStatus CommitStatusPayload `json:"commit_status"`
	Repository   RepositoryPayload   `json:"repository"`
	Sender       UserPayload         `json:"sender"`
}

// WorkflowRunPayload represents a workflow run in a webhook event.
type WorkflowRunPayload struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Status       string    `json:"status"`
	TriggerEvent string    `json:"trigger_event"`
	TriggerRef   string    `json:"trigger_ref,omitempty"`
	CommitSHA    string    `json:"commit_sha,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// WorkflowRunEventPayload is the payload for workflow_run webhook events.
type WorkflowRunEventPayload struct {
	Action      string             `json:"action"`
	WorkflowRun WorkflowRunPayload `json:"workflow_run"`
	Repository  RepositoryPayload  `json:"repository"`
	Sender      UserPayload        `json:"sender"`
}

// WorkflowArtifactPayload represents a workflow artifact in a webhook event.
type WorkflowArtifactPayload struct {
	ID             int64      `json:"id"`
	WorkflowRunID  int64      `json:"workflow_run_id"`
	Name           string     `json:"name"`
	Size           int64      `json:"size"`
	ContentType    string     `json:"content_type"`
	Status         string     `json:"status"`
	SourceWorkflow string     `json:"source_workflow,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ConfirmedAt    *time.Time `json:"confirmed_at,omitempty"`
}

// WorkflowArtifactEventPayload is the payload for workflow_artifact webhook events.
type WorkflowArtifactEventPayload struct {
	Action     string                  `json:"action"`
	Artifact   WorkflowArtifactPayload `json:"artifact"`
	Repository RepositoryPayload       `json:"repository"`
	Sender     UserPayload             `json:"sender"`
}

type ReleaseAssetPayload struct {
	ID            int64      `json:"id"`
	Name          string     `json:"name"`
	Size          int64      `json:"size"`
	DownloadCount int64      `json:"download_count"`
	ContentType   string     `json:"content_type"`
	Status        string     `json:"status"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	ConfirmedAt   *time.Time `json:"confirmed_at,omitempty"`
}

type ReleasePayload struct {
	ID              int64                 `json:"id"`
	TagName         string                `json:"tag_name"`
	TargetCommitish string                `json:"target_commitish,omitempty"`
	CommitSHA       string                `json:"commit_sha,omitempty"`
	Title           string                `json:"title"`
	Body            string                `json:"body"`
	IsDraft         bool                  `json:"draft"`
	IsPrerelease    bool                  `json:"prerelease"`
	Author          UserPayload           `json:"author"`
	Assets          []ReleaseAssetPayload `json:"assets,omitempty"`
	CreatedAt       time.Time             `json:"created_at"`
	UpdatedAt       time.Time             `json:"updated_at"`
	PublishedAt     *time.Time            `json:"published_at,omitempty"`
}

type ReleaseEventPayload struct {
	Action     string            `json:"action"`
	Release    ReleasePayload    `json:"release"`
	Repository RepositoryPayload `json:"repository"`
	Sender     UserPayload       `json:"sender"`
}

// OrganizationEventPayload is the payload for organization webhook events.
type OrganizationEventPayload struct {
	Action string      `json:"action"`
	Sender UserPayload `json:"sender"`
}

// TeamEventPayload is the payload for team webhook events (lifecycle/member).
type TeamEventPayload struct {
	Action     string            `json:"action"`
	Repository RepositoryPayload `json:"repository,omitempty"`
	Sender     UserPayload       `json:"sender"`
}

// AgentSessionPayload represents an agent session in a webhook event.
type AgentSessionPayload struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AgentSessionEventPayload is the payload for agent.session webhook events.
type AgentSessionEventPayload struct {
	Action       string              `json:"action"`
	AgentSession AgentSessionPayload `json:"agent_session"`
	Repository   RepositoryPayload   `json:"repository"`
	Sender       UserPayload         `json:"sender"`
}

// AgentMessagePayload represents an agent message in a webhook event.
type AgentMessagePayload struct {
	ID        int64     `json:"id"`
	SessionID string    `json:"session_id"`
	Role      string    `json:"role"`
	Sequence  int64     `json:"sequence"`
	CreatedAt time.Time `json:"created_at"`
}

// AgentMessageEventPayload is the payload for agent.message webhook events.
type AgentMessageEventPayload struct {
	Action     string              `json:"action"`
	Message    AgentMessagePayload `json:"message"`
	Repository RepositoryPayload   `json:"repository"`
	Sender     UserPayload         `json:"sender"`
}

// WikiPayload represents a wiki page in a webhook event.
type WikiPayload struct {
	Slug      string    `json:"slug"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// WikiEventPayload is the payload for wiki webhook events.
type WikiEventPayload struct {
	Action     string            `json:"action"`
	Page       WikiPayload       `json:"page"`
	Repository RepositoryPayload `json:"repository"`
	Sender     UserPayload       `json:"sender"`
}
