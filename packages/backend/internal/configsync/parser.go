package configsync

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/smithersai/smithers/packages/backend/internal/githubrepo"
	webhookevents "github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

var (
	configRepoTopicRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,34}$`)
	secretRefPattern     = regexp.MustCompile(`^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$`)
)

type rawProtectedBookmarksFile struct {
	ProtectedBookmarks []rawProtectedBookmarkRule `yaml:"protected_bookmarks"`
}

type rawProtectedBookmarkRule struct {
	Pattern               string `yaml:"pattern"`
	RequireReview         *bool  `yaml:"require_review,omitempty"`
	RequireHumanApprovals *int64 `yaml:"require_human_approvals,omitempty"`
	RequireAgentLGTM      *bool  `yaml:"require_agent_lgtm,omitempty"`
	// RequiredApprovals is the pre-#462 spelling. It remains readable so an
	// existing config commit does not silently reset policy during rollout.
	RequiredApprovals   *int64           `yaml:"required_approvals,omitempty"`
	RequiredChecks      []string         `yaml:"required_checks,omitempty"`
	DismissStaleReviews *bool            `yaml:"dismiss_stale_reviews,omitempty"`
	RestrictPush        *rawRestrictPush `yaml:"restrict_push,omitempty"`
}

type rawRestrictPush struct {
	Teams []string `yaml:"teams,omitempty"`
}

type rawLabelsFile struct {
	Labels []LabelDefinition `yaml:"labels"`
}

type rawWebhooksFile struct {
	Webhooks []rawWebhookDefinition `yaml:"webhooks"`
}

type rawWebhookDefinition struct {
	URL    string   `yaml:"url"`
	Events []string `yaml:"events"`
	Secret *string  `yaml:"secret,omitempty"`
	Active *bool    `yaml:"active,omitempty"`
}

func ParseConfigFiles(files map[string][]byte) (ParsedConfig, error) {
	var parsed ParsedConfig

	if content, ok := files[configFilePath]; ok {
		cfg, err := parseConfigFile(content)
		if err != nil {
			return ParsedConfig{}, err
		}
		parsed.ConfigFilePresent = true
		parsed.Config = cfg
	}

	if content, ok := files[protectedBookmarksFilePath]; ok {
		rules, err := parseProtectedBookmarksFile(content)
		if err != nil {
			return ParsedConfig{}, err
		}
		parsed.ProtectedBookmarksFilePresent = true
		parsed.ProtectedBookmarks = rules
	}

	if content, ok := files[labelsFilePath]; ok {
		labels, err := parseLabelsFile(content)
		if err != nil {
			return ParsedConfig{}, err
		}
		parsed.LabelsFilePresent = true
		parsed.Labels = labels
	}

	if content, ok := files[webhooksFilePath]; ok {
		hooks, err := parseWebhooksFile(content)
		if err != nil {
			return ParsedConfig{}, err
		}
		parsed.WebhooksFilePresent = true
		parsed.Webhooks = hooks
	}

	return parsed, nil
}

func parseConfigFile(content []byte) (ConfigFile, error) {
	var cfg ConfigFile
	if err := decodeYAMLStrict(configFilePath, content, &cfg); err != nil {
		return ConfigFile{}, err
	}

	if cfg.Repository != nil {
		if cfg.Repository.Visibility != nil {
			visibility := strings.ToLower(strings.TrimSpace(*cfg.Repository.Visibility))
			if visibility != "public" && visibility != "private" {
				return ConfigFile{}, fmt.Errorf("%s: repository.visibility must be public or private", configFilePath)
			}
			cfg.Repository.Visibility = &visibility
		}

		topics, err := normalizeOptionalTopics(cfg.Repository.Topics)
		if err != nil {
			return ConfigFile{}, fmt.Errorf("%s: %w", configFilePath, err)
		}
		cfg.Repository.Topics = topics

		if cfg.Repository.Mirror != nil {
			if cfg.Repository.Mirror.Enabled == nil {
				return ConfigFile{}, fmt.Errorf("%s: repository.mirror.enabled is required when repository.mirror is present", configFilePath)
			}

			if !*cfg.Repository.Mirror.Enabled {
				if cfg.Repository.Mirror.Destination != nil && strings.TrimSpace(*cfg.Repository.Mirror.Destination) != "" {
					return ConfigFile{}, fmt.Errorf("%s: repository.mirror.destination must be omitted when repository.mirror.enabled is false", configFilePath)
				}
			} else {
				if cfg.Repository.Mirror.Destination == nil || strings.TrimSpace(*cfg.Repository.Mirror.Destination) == "" {
					return ConfigFile{}, fmt.Errorf("%s: repository.mirror.destination is required when repository.mirror.enabled is true", configFilePath)
				}
				destination := strings.TrimSpace(*cfg.Repository.Mirror.Destination)
				if _, _, err := githubrepo.ParseMirrorDestination(destination); err != nil {
					return ConfigFile{}, fmt.Errorf("%s: repository.mirror.destination: %w", configFilePath, err)
				}
				cfg.Repository.Mirror.Destination = &destination
			}
		}
	}

	if cfg.Workspace != nil {
		if cfg.Workspace.IdleTimeoutSeconds != nil && *cfg.Workspace.IdleTimeoutSeconds <= 0 {
			return ConfigFile{}, fmt.Errorf("%s: workspace.idle_timeout_seconds must be positive", configFilePath)
		}
		if cfg.Workspace.IdleTimeoutSeconds != nil && *cfg.Workspace.IdleTimeoutSeconds > math.MaxInt32 {
			return ConfigFile{}, fmt.Errorf("%s: workspace.idle_timeout_seconds must be at most %d", configFilePath, math.MaxInt32)
		}
		if cfg.Workspace.Persistence != nil {
			persistence := strings.ToLower(strings.TrimSpace(*cfg.Workspace.Persistence))
			if persistence != "persistent" && persistence != "ephemeral" {
				return ConfigFile{}, fmt.Errorf("%s: workspace.persistence must be persistent or ephemeral", configFilePath)
			}
			cfg.Workspace.Persistence = &persistence
		}
		deps, err := normalizeOptionalTrimmedList(cfg.Workspace.Dependencies, false)
		if err != nil {
			return ConfigFile{}, fmt.Errorf("%s: workspace.dependencies: %w", configFilePath, err)
		}
		cfg.Workspace.Dependencies = deps
	}

	if cfg.LandingQueue != nil {
		if cfg.LandingQueue.Mode != nil {
			mode := strings.ToLower(strings.TrimSpace(*cfg.LandingQueue.Mode))
			if mode != "serialized" && mode != "parallel" {
				return ConfigFile{}, fmt.Errorf("%s: landing_queue.mode must be serialized or parallel", configFilePath)
			}
			cfg.LandingQueue.Mode = &mode
		}
		checks, err := normalizeOptionalTrimmedList(cfg.LandingQueue.RequiredChecks, false)
		if err != nil {
			return ConfigFile{}, fmt.Errorf("%s: landing_queue.required_checks: %w", configFilePath, err)
		}
		cfg.LandingQueue.RequiredChecks = checks
	}

	return cfg, nil
}

func parseProtectedBookmarksFile(content []byte) ([]ProtectedBookmarkRule, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return []ProtectedBookmarkRule{}, nil
	}

	var raw rawProtectedBookmarksFile
	if err := decodeYAMLStrict(protectedBookmarksFilePath, content, &raw); err != nil {
		return nil, err
	}
	if raw.ProtectedBookmarks == nil {
		return nil, fmt.Errorf("%s: protected_bookmarks is required", protectedBookmarksFilePath)
	}

	rules := make([]ProtectedBookmarkRule, 0, len(raw.ProtectedBookmarks))
	seen := make(map[string]struct{}, len(raw.ProtectedBookmarks))
	for _, candidate := range raw.ProtectedBookmarks {
		pattern := strings.TrimSpace(candidate.Pattern)
		if pattern == "" {
			return nil, fmt.Errorf("%s: protected_bookmarks.pattern is required", protectedBookmarksFilePath)
		}
		if _, err := path.Match(pattern, "validation"); err != nil {
			return nil, fmt.Errorf("%s: protected_bookmarks.pattern %q is invalid", protectedBookmarksFilePath, pattern)
		}
		if _, exists := seen[pattern]; exists {
			return nil, fmt.Errorf("%s: duplicate protected bookmark pattern %q", protectedBookmarksFilePath, pattern)
		}
		seen[pattern] = struct{}{}

		requireReview := true
		if candidate.RequireReview != nil {
			requireReview = *candidate.RequireReview
		}
		if candidate.RequireHumanApprovals != nil && candidate.RequiredApprovals != nil {
			return nil, fmt.Errorf("%s: protected_bookmarks.require_human_approvals and required_approvals cannot both be set", protectedBookmarksFilePath)
		}
		requireHumanApprovals := int64(1)
		if candidate.RequireHumanApprovals != nil {
			requireHumanApprovals = *candidate.RequireHumanApprovals
		} else if candidate.RequiredApprovals != nil {
			requireHumanApprovals = *candidate.RequiredApprovals
		}
		if requireHumanApprovals < 0 {
			return nil, fmt.Errorf("%s: protected_bookmarks.require_human_approvals must be >= 0", protectedBookmarksFilePath)
		}
		requireAgentLGTM := false
		if candidate.RequireAgentLGTM != nil {
			requireAgentLGTM = *candidate.RequireAgentLGTM
		}

		requiredChecks, err := normalizeRequiredChecks(candidate.RequiredChecks)
		if err != nil {
			return nil, fmt.Errorf("%s: protected_bookmarks.required_checks: %w", protectedBookmarksFilePath, err)
		}

		dismissStaleReviews := false
		if candidate.DismissStaleReviews != nil {
			dismissStaleReviews = *candidate.DismissStaleReviews
		}

		restrictPushTeams := []string{}
		if candidate.RestrictPush != nil {
			restrictPushTeams, err = normalizeOptionalTrimmedList(candidate.RestrictPush.Teams, false)
			if err != nil {
				return nil, fmt.Errorf("%s: protected_bookmarks.restrict_push.teams: %w", protectedBookmarksFilePath, err)
			}
			if restrictPushTeams == nil {
				restrictPushTeams = []string{}
			}
		}

		rules = append(rules, ProtectedBookmarkRule{
			Pattern:               pattern,
			RequireReview:         requireReview,
			RequireHumanApprovals: requireHumanApprovals,
			RequireAgentLGTM:      requireAgentLGTM,
			RequiredChecks:        requiredChecksOrEmpty(requiredChecks),
			DismissStaleReviews:   dismissStaleReviews,
			RestrictPushTeams:     restrictPushTeams,
		})
	}

	slices.SortFunc(rules, func(a, b ProtectedBookmarkRule) int {
		return strings.Compare(a.Pattern, b.Pattern)
	})
	return rules, nil
}

func parseLabelsFile(content []byte) ([]LabelDefinition, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return []LabelDefinition{}, nil
	}

	var raw rawLabelsFile
	if err := decodeYAMLStrict(labelsFilePath, content, &raw); err != nil {
		return nil, err
	}
	if raw.Labels == nil {
		return nil, fmt.Errorf("%s: labels is required", labelsFilePath)
	}

	labels := make([]LabelDefinition, 0, len(raw.Labels))
	seen := make(map[string]struct{}, len(raw.Labels))
	for _, label := range raw.Labels {
		name := strings.TrimSpace(label.Name)
		if name == "" {
			return nil, fmt.Errorf("%s: labels.name is required", labelsFilePath)
		}
		if len(name) > 255 {
			return nil, fmt.Errorf("%s: labels.name is invalid", labelsFilePath)
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("%s: duplicate label %q", labelsFilePath, name)
		}
		seen[name] = struct{}{}

		color, err := normalizeLabelColor(label.Color)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", labelsFilePath, err)
		}
		labels = append(labels, LabelDefinition{
			Name:        name,
			Color:       color,
			Description: label.Description,
		})
	}

	slices.SortFunc(labels, func(a, b LabelDefinition) int {
		return strings.Compare(a.Name, b.Name)
	})
	return labels, nil
}

func parseWebhooksFile(content []byte) ([]WebhookDefinition, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return []WebhookDefinition{}, nil
	}

	var raw rawWebhooksFile
	if err := decodeYAMLStrict(webhooksFilePath, content, &raw); err != nil {
		return nil, err
	}
	if raw.Webhooks == nil {
		return nil, fmt.Errorf("%s: webhooks is required", webhooksFilePath)
	}

	webhooks := make([]WebhookDefinition, 0, len(raw.Webhooks))
	seen := make(map[string]struct{}, len(raw.Webhooks))
	for _, hook := range raw.Webhooks {
		urlValue := strings.TrimSpace(hook.URL)
		if urlValue == "" {
			return nil, fmt.Errorf("%s: webhooks.url is required", webhooksFilePath)
		}
		if !strings.HasPrefix(strings.ToLower(urlValue), "https://") {
			return nil, fmt.Errorf("%s: webhooks.url must use https", webhooksFilePath)
		}
		if _, err := url.ParseRequestURI(urlValue); err != nil {
			return nil, fmt.Errorf("%s: webhooks.url must be a valid URL", webhooksFilePath)
		}
		if _, exists := seen[urlValue]; exists {
			return nil, fmt.Errorf("%s: duplicate webhook url %q", webhooksFilePath, urlValue)
		}
		seen[urlValue] = struct{}{}

		events, err := normalizeWebhookEvents(hook.Events)
		if err != nil {
			return nil, fmt.Errorf("%s: webhooks.events: %w", webhooksFilePath, err)
		}
		if err := webhookevents.ValidateSubscribedEvents(events); err != nil {
			return nil, fmt.Errorf("%s: webhooks.events: %w", webhooksFilePath, err)
		}
		if len(events) == 0 {
			return nil, fmt.Errorf("%s: webhooks.events must contain at least one event", webhooksFilePath)
		}

		secretRef := ""
		if hook.Secret != nil {
			secretRef = strings.TrimSpace(*hook.Secret)
			if secretRef != "" && !secretRefPattern.MatchString(secretRef) {
				return nil, fmt.Errorf("%s: webhooks.secret must use ${{ secrets.NAME }} syntax", webhooksFilePath)
			}
		}

		active := true
		if hook.Active != nil {
			active = *hook.Active
		}

		webhooks = append(webhooks, WebhookDefinition{
			URL:       urlValue,
			Events:    events,
			SecretRef: secretRef,
			Active:    active,
		})
	}

	slices.SortFunc(webhooks, func(a, b WebhookDefinition) int {
		return strings.Compare(a.URL, b.URL)
	})
	return webhooks, nil
}

func decodeYAMLStrict(path string, content []byte, target any) error {
	if len(bytes.TrimSpace(content)) == 0 {
		return nil
	}

	decoder := yaml.NewDecoder(bytes.NewReader(content))
	decoder.KnownFields(true)
	if err := decoder.Decode(target); err != nil {
		if err == io.EOF {
			return nil
		}
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func normalizeOptionalTopics(topics []string) ([]string, error) {
	if topics == nil {
		return nil, nil
	}
	if len(topics) == 0 {
		return []string{}, nil
	}

	normalized := make([]string, 0, len(topics))
	seen := make(map[string]struct{}, len(topics))
	for _, topic := range topics {
		candidate := strings.ToLower(strings.TrimSpace(topic))
		if !configRepoTopicRegex.MatchString(candidate) {
			return nil, fmt.Errorf("repository.topics contains invalid topic %q", topic)
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	slices.Sort(normalized)
	return normalized, nil
}

func normalizeOptionalTrimmedList(values []string, lower bool) ([]string, error) {
	if values == nil {
		return nil, nil
	}
	if len(values) == 0 {
		return []string{}, nil
	}

	normalized := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		candidate := strings.TrimSpace(value)
		if lower {
			candidate = strings.ToLower(candidate)
		}
		if candidate == "" {
			return nil, fmt.Errorf("values must not contain blanks")
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	slices.Sort(normalized)
	return normalized, nil
}

func normalizeRequiredChecks(values []string) ([]string, error) {
	return normalizeOptionalTrimmedList(values, false)
}

func normalizeWebhookEvents(values []string) ([]string, error) {
	return normalizeOptionalTrimmedList(values, true)
}

func requiredChecksOrEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func normalizeLabelColor(raw string) (string, error) {
	color := strings.ToLower(strings.TrimSpace(raw))
	if color == "" {
		return "", fmt.Errorf("labels.color is required")
	}
	color = strings.TrimPrefix(color, "#")
	if len(color) != 6 {
		return "", fmt.Errorf("labels.color is invalid")
	}
	for _, ch := range color {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return "", fmt.Errorf("labels.color is invalid")
		}
	}
	return "#" + color, nil
}
