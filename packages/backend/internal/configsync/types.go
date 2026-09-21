package configsync

const (
	configFilePath             = ".smithers/config.yml"
	protectedBookmarksFilePath = ".smithers/protected-bookmarks.yml"
	labelsFilePath             = ".smithers/labels.yml"
	webhooksFilePath           = ".smithers/webhooks.yml"
)

type SyncInput struct {
	RepositoryID int64
	CommitSHA    string
	Trigger      string
	DryRun       bool
	ActorID      *int64
	ActorName    string
	IPAddress    string
}

type SyncResult struct {
	DryRun         bool          `json:"dry_run"`
	FilesProcessed []string      `json:"files_processed"`
	Changes        []Change      `json:"changes"`
	Warnings       []SyncWarning `json:"warnings,omitempty"`
}

type Change struct {
	ConfigType string `json:"config_type"`
	Identifier string `json:"identifier"`
	Action     string `json:"action"`
	Before     any    `json:"before,omitempty"`
	After      any    `json:"after,omitempty"`
}

type SyncWarning struct {
	ConfigType string `json:"config_type"`
	Identifier string `json:"identifier"`
	Message    string `json:"message"`
}

type ParsedConfig struct {
	ConfigFilePresent             bool
	Config                        ConfigFile
	ProtectedBookmarksFilePresent bool
	ProtectedBookmarks            []ProtectedBookmarkRule
	LabelsFilePresent             bool
	Labels                        []LabelDefinition
	WebhooksFilePresent           bool
	Webhooks                      []WebhookDefinition
}

type ConfigFile struct {
	Repository   *RepositorySettings   `yaml:"repository,omitempty"`
	Workspace    *WorkspaceSettings    `yaml:"workspace,omitempty"`
	LandingQueue *LandingQueueSettings `yaml:"landing_queue,omitempty"`
}

type RepositorySettings struct {
	Description *string         `yaml:"description,omitempty"`
	Topics      []string        `yaml:"topics,omitempty"`
	Visibility  *string         `yaml:"visibility,omitempty"`
	Mirror      *MirrorSettings `yaml:"mirror,omitempty"`
}

type MirrorSettings struct {
	Enabled     *bool   `yaml:"enabled,omitempty"`
	Destination *string `yaml:"destination,omitempty"`
}

type WorkspaceSettings struct {
	IdleTimeoutSeconds *int     `yaml:"idle_timeout_seconds,omitempty"`
	Persistence        *string  `yaml:"persistence,omitempty"`
	Dependencies       []string `yaml:"dependencies,omitempty"`
}

type LandingQueueSettings struct {
	Mode           *string  `yaml:"mode,omitempty"`
	RequiredChecks []string `yaml:"required_checks,omitempty"`
}

type ProtectedBookmarkRule struct {
	Pattern               string   `yaml:"pattern"`
	RequireReview         bool     `yaml:"require_review"`
	RequireHumanApprovals int64    `yaml:"require_human_approvals"`
	RequireAgentLGTM      bool     `yaml:"require_agent_lgtm"`
	RequiredChecks        []string `yaml:"required_checks,omitempty"`
	DismissStaleReviews   bool     `yaml:"dismiss_stale_reviews"`
	RestrictPushTeams     []string `yaml:"-"`
}

type LabelDefinition struct {
	Name        string `yaml:"name"`
	Color       string `yaml:"color"`
	Description string `yaml:"description,omitempty"`
}

type WebhookDefinition struct {
	URL       string   `yaml:"url"`
	Events    []string `yaml:"events"`
	SecretRef string   `yaml:"secret,omitempty"`
	Active    bool     `yaml:"active"`
}

type repoConfigSnapshot struct {
	Description                string
	IsPublic                   bool
	Topics                     []string
	IsMirror                   bool
	MirrorDestination          string
	WorkspaceIdleTimeoutSecs   int32
	WorkspacePersistence       string
	WorkspaceDependencies      []string
	LandingQueueMode           string
	LandingQueueRequiredChecks []string
}
