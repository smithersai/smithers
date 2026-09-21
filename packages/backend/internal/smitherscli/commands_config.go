package smitherscli

import (
	"fmt"
	"os"

	incur "github.com/smithersai/incur"
)

var validConfigKeys = map[string]struct{}{
	"agent_issue_repo": {},
	"api_url":          {},
	"observe_url":      {},
	"git_protocol":     {},
}

func validateConfigKey(key string) error {
	if _, ok := validConfigKeys[key]; !ok {
		return fmt.Errorf("Unknown config key: %s (valid keys: api_url, git_protocol)", key)
	}
	return nil
}

func configCommand() *incur.Cli {
	cmd := incur.New("config", incur.WithDescription("Get and set configuration"))
	cmd.Command("get", &incur.CommandDef{
		Description: "Get a config value by key",
		ArgsSchema: objectSchema([]string{"key"}, map[string]*incur.JSONSchema{
			"key": stringSchema("Config key (agent_issue_repo, api_url, observe_url, git_protocol)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			key := stringValue(ctx.Args["key"])
			if err := validateConfigKey(key); err != nil {
				return nil, err
			}
			cfg := LoadRawConfig()
			switch key {
			case "api_url":
				return map[string]any{key: cfg.APIURL}, nil
			case "observe_url":
				return map[string]any{key: cfg.ObserveURL}, nil
			case "git_protocol":
				return map[string]any{key: string(cfg.GitProtocol)}, nil
			default: // agent_issue_repo — the only remaining key allowed by validateConfigKey
				return map[string]any{key: nullableString(cfg.AgentIssueRepo)}, nil
			}
		},
	})
	cmd.Command("set", &incur.CommandDef{
		Description: "Set a config value by key",
		ArgsSchema: objectSchema([]string{"key", "value"}, map[string]*incur.JSONSchema{
			"key":   stringSchema("Config key (agent_issue_repo, api_url, observe_url, git_protocol)"),
			"value": stringSchema("Value to set"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			key := stringValue(ctx.Args["key"])
			value := stringValue(ctx.Args["value"])
			if err := validateConfigKey(key); err != nil {
				return nil, err
			}
			if key == "git_protocol" && value != "ssh" && value != "https" {
				return nil, fmt.Errorf("Invalid value for git_protocol: must be 'ssh' or 'https'")
			}
			if err := SaveConfig(map[string]string{key: value}); err != nil {
				return nil, err
			}
			return map[string]any{"set": key, "value": value}, nil
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List all config values",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			cfg := LoadRawConfig()
			return map[string]any{
				"api_url":          cfg.APIURL,
				"observe_url":      cfg.ObserveURL,
				"git_protocol":     string(cfg.GitProtocol),
				"agent_issue_repo": nullableString(cfg.AgentIssueRepo),
			}, nil
		},
	})
	cmd.Command("show", &incur.CommandDef{
		Description: "Show effective configuration with env var overrides and source information",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			raw := LoadRawConfig()
			effective := LoadConfig()
			tokenStatus := "(not set)"
			if os.Getenv("SMITHERS_TOKEN") != "" {
				tokenStatus = "(set)"
			}
			agentIssueRepo := os.Getenv("SMITHERS_AGENT_ISSUE_REPO")
			if agentIssueRepo == "" {
				agentIssueRepo = "(not set)"
			}
			result := map[string]any{
				"effective": map[string]any{
					"api_url":          effective.APIURL,
					"observe_url":      effective.ObserveURL,
					"git_protocol":     string(effective.GitProtocol),
					"agent_issue_repo": nullableString(effective.AgentIssueRepo),
				},
				"config_file": map[string]any{
					"path":             ConfigPath(),
					"api_url":          raw.APIURL,
					"observe_url":      raw.ObserveURL,
					"git_protocol":     string(raw.GitProtocol),
					"agent_issue_repo": nullableString(raw.AgentIssueRepo),
				},
				"env_overrides": map[string]any{
					"SMITHERS_TOKEN":            tokenStatus,
					"SMITHERS_AGENT_ISSUE_REPO": agentIssueRepo,
				},
				"precedence": []string{
					"SMITHERS_TOKEN (authentication token, highest priority for auth)",
					"SMITHERS_AGENT_ISSUE_REPO (overrides agent_issue_repo in config file)",
					"Config file: api_url, git_protocol, agent_issue_repo",
					"Built-in defaults: api_url=https://api.jjhub.tech, git_protocol=ssh",
				},
			}
			if ctx.FormatExplicit {
				return result, nil
			}
			eff := result["effective"].(map[string]any)
			env := result["env_overrides"].(map[string]any)
			lines := []string{
				"Config file: " + ConfigPath(),
				"",
				"Effective configuration:",
				fmt.Sprintf("  api_url:          %s", eff["api_url"]),
				fmt.Sprintf("  observe_url:      %s", eff["observe_url"]),
				fmt.Sprintf("  git_protocol:     %s", eff["git_protocol"]),
				fmt.Sprintf("  agent_issue_repo: %s", displayNullable(eff["agent_issue_repo"])),
				"",
				"Environment variable overrides:",
				fmt.Sprintf("  SMITHERS_TOKEN:           %s", env["SMITHERS_TOKEN"]),
				fmt.Sprintf("  SMITHERS_AGENT_ISSUE_REPO: %s", env["SMITHERS_AGENT_ISSUE_REPO"]),
				"",
				"Precedence (highest to lowest):",
				"  SMITHERS_TOKEN (authentication token, highest priority for auth)",
				"  SMITHERS_AGENT_ISSUE_REPO (overrides agent_issue_repo in config file)",
				"  Config file: api_url, git_protocol, agent_issue_repo",
				"  Built-in defaults: api_url=https://api.jjhub.tech, git_protocol=ssh",
			}
			return joinLines(lines), nil
		},
	})
	return cmd
}
