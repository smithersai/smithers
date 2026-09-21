package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
)

// moreHTTPAbs is a seam so the defensive filepath.Abs error branch in the
// artifact download handler can be exercised (Abs only fails when os.Getwd does).
var moreHTTPAbs = filepath.Abs

func adminCommand() *incur.Cli {
	cmd := incur.New("admin", incur.WithDescription("Admin commands"), incur.WithFormat(incur.FormatJSON))
	cmd.Command("user list", &incur.CommandDef{
		Description:   "List all users",
		OptionsSchema: pageLimitOptions(),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("limit", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
			return APIRequest("GET", "/api/admin/users?"+query.Encode(), nil, nil)
		},
	})
	cmd.Command("user create", &incur.CommandDef{
		Description: "Create a user",
		OptionsSchema: objectSchema([]string{"username", "email"}, map[string]*incur.JSONSchema{
			"username": stringSchema("Username"),
			"email":    stringSchema("Email address"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", "/api/admin/users", map[string]any{
				"username": stringValue(ctx.Options["username"]),
				"email":    stringValue(ctx.Options["email"]),
			}, nil)
		},
	})
	cmd.Command("user disable", &incur.CommandDef{
		Description: "Disable a user",
		ArgsSchema:  objectSchema([]string{"username"}, map[string]*incur.JSONSchema{"username": stringSchema("Username to disable")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("PATCH", "/api/admin/users/"+url.PathEscape(stringValue(ctx.Args["username"])), map[string]any{"active": false}, nil)
		},
	})
	cmd.Command("user delete", &incur.CommandDef{
		Description: "Delete a user",
		ArgsSchema:  objectSchema([]string{"username"}, map[string]*incur.JSONSchema{"username": stringSchema("Username to delete")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			username := stringValue(ctx.Args["username"])
			if _, err := APIRequest("DELETE", "/api/admin/users/"+url.PathEscape(username), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "username": username}, nil
		},
	})
	cmd.Command("runner list", &incur.CommandDef{
		Description: "List runners and pool status",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/admin/runners", nil, nil)
		},
	})
	cmd.Command("runs list", &incur.CommandDef{
		Format:      incur.FormatJSON,
		Description: "List workflow runs in a repository",
		OptionsSchema: objectSchema([]string{"repo"}, map[string]*incur.JSONSchema{
			"repo":  stringSchema("Repository (OWNER/REPO)"),
			"page":  numberSchema("Page number", 1),
			"limit": numberSchema("Results per page", 30),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("limit", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
			result, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/workflows/runs?%s", url.PathEscape(owner), url.PathEscape(repo), query.Encode()), nil, nil)
			token, _ := ResolveAuthToken(nil)
			if err != nil {
				return nil, adminLoginError(err, token)
			}
			if !ctx.FormatExplicit && adminIsTerminal(int(os.Stdout.Fd())) {
				return formatAdminResult(result), nil
			}
			return result, nil
		},
	})
	cmd.Command("health", &incur.CommandDef{
		Description: "System health status",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/admin/system/health", nil, nil)
		},
	})
	registerAdminOperations(cmd)
	return cmd
}

func betaCommand() *incur.Cli {
	cmd := incur.New("beta", incur.WithDescription("Manage closed alpha whitelist and waitlist"))
	cmd.Command("waitlist join", &incur.CommandDef{
		Description: "Join the closed alpha waitlist",
		OptionsSchema: objectSchema([]string{"email"}, map[string]*incur.JSONSchema{
			"email":  stringSchema("Email to submit"),
			"note":   {Type: "string", Description: "Optional note for admins", Default: ""},
			"source": {Type: "string", Description: "Source tag", Default: "cli"},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return unauthenticatedJSONRequest("POST", "/api/alpha/waitlist", map[string]any{
				"email":  strings.TrimSpace(stringValue(ctx.Options["email"])),
				"note":   stringValue(ctx.Options["note"]),
				"source": strings.TrimSpace(stringValue(ctx.Options["source"])),
			})
		},
	})
	cmd.Command("waitlist list", &incur.CommandDef{
		Description: "List waitlist entries (admin)",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"status":   stringSchema("Filter by status (pending, approved, rejected)"),
			"page":     numberSchema("Page number", 1),
			"per-page": numberSchema("Results per page", 50),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			query := url.Values{}
			query.Set("page", strconv.Itoa(intValue(ctx.Options["page"], 1)))
			query.Set("per_page", strconv.Itoa(intValue(ctx.Options["per-page"], 50)))
			if status := stringValue(ctx.Options["status"]); status != "" {
				query.Set("status", status)
			}
			return APIRequest("GET", "/api/admin/alpha/waitlist?"+query.Encode(), nil, nil)
		},
	})
	cmd.Command("waitlist approve", &incur.CommandDef{
		Description: "Approve a waitlist entry by email (admin)",
		OptionsSchema: objectSchema([]string{"email"}, map[string]*incur.JSONSchema{
			"email": stringSchema("Email to approve"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", "/api/admin/alpha/waitlist/approve", map[string]any{
				"email": strings.TrimSpace(stringValue(ctx.Options["email"])),
			}, nil)
		},
	})
	cmd.Command("whitelist add", &incur.CommandDef{
		Description: "Add or update a whitelist entry (admin)",
		OptionsSchema: objectSchema([]string{"type", "value"}, map[string]*incur.JSONSchema{
			"type":  stringSchema("Identity type: email, wallet, username"),
			"value": stringSchema("Identity value"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", "/api/admin/alpha/whitelist", map[string]any{
				"identity_type":  stringValue(ctx.Options["type"]),
				"identity_value": strings.TrimSpace(stringValue(ctx.Options["value"])),
			}, nil)
		},
	})
	cmd.Command("whitelist list", &incur.CommandDef{
		Description: "List whitelist entries (admin)",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/admin/alpha/whitelist", nil, nil)
		},
	})
	cmd.Command("whitelist remove", &incur.CommandDef{
		Description: "Remove a whitelist entry (admin)",
		OptionsSchema: objectSchema([]string{"type", "value"}, map[string]*incur.JSONSchema{
			"type":  stringSchema("Identity type: email, wallet, username"),
			"value": stringSchema("Identity value"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			identityType := stringValue(ctx.Options["type"])
			identityValue := strings.TrimSpace(stringValue(ctx.Options["value"]))
			if _, err := APIRequest("DELETE", "/api/admin/alpha/whitelist/"+escapePathSegment(identityType)+"/"+escapePathSegment(identityValue), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"removed": true, "identity_type": identityType, "identity_value": identityValue}, nil
		},
	})
	return cmd
}

func orgCommand() *incur.Cli {
	cmd := incur.New("org", incur.WithDescription("Organization and team management"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create an organization",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Organization name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"description": {Type: "string", Description: "Organization description", Default: ""},
			"visibility":  enumSchema("Organization visibility", []string{"public", "limited", "private"}, "public"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", "/api/orgs", map[string]any{
				"username":    stringValue(ctx.Args["name"]),
				"description": stringValue(ctx.Options["description"]),
				"visibility":  stringValue(ctx.Options["visibility"]),
			}, nil)
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List organizations for the authenticated user",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/user/orgs", nil, nil)
		},
	})
	cmd.Command("view", &incur.CommandDef{
		Description: "View organization details",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Organization name")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/orgs/"+url.PathEscape(stringValue(ctx.Args["name"])), nil, nil)
		},
	})
	cmd.Command("edit", &incur.CommandDef{
		Description: "Update organization settings",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Organization name")}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"description": stringSchema("New organization description"),
			"visibility":  enumSchema("Organization visibility", []string{"public", "limited", "private"}, ""),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			body := map[string]any{}
			if _, ok := ctx.Options["description"]; ok {
				body["description"] = stringValue(ctx.Options["description"])
			}
			if visibility := stringValue(ctx.Options["visibility"]); visibility != "" {
				body["visibility"] = visibility
			}
			return APIRequest("PATCH", "/api/orgs/"+url.PathEscape(stringValue(ctx.Args["name"])), body, nil)
		},
	})
	cmd.Command("delete", &incur.CommandDef{
		Description: "Delete an organization",
		ArgsSchema:  objectSchema([]string{"name"}, map[string]*incur.JSONSchema{"name": stringSchema("Organization name")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			name := stringValue(ctx.Args["name"])
			if _, err := APIRequest("DELETE", "/api/orgs/"+url.PathEscape(name), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "name": name}, nil
		},
	})
	cmd.Command("member list", &incur.CommandDef{
		Description: "List members in an organization",
		ArgsSchema:  objectSchema([]string{"org"}, map[string]*incur.JSONSchema{"org": stringSchema("Organization name")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", fmt.Sprintf("/api/orgs/%s/members", url.PathEscape(stringValue(ctx.Args["org"]))), nil, nil)
		},
	})
	cmd.Command("member add", &incur.CommandDef{
		Description: "Add a member to an organization",
		ArgsSchema: objectSchema([]string{"org", "username"}, map[string]*incur.JSONSchema{
			"org":      stringSchema("Organization name"),
			"username": stringSchema("Username to add"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", fmt.Sprintf("/api/orgs/%s/members", url.PathEscape(stringValue(ctx.Args["org"]))), map[string]any{
				"username": stringValue(ctx.Args["username"]),
			}, nil)
		},
	})
	cmd.Command("member remove", &incur.CommandDef{
		Description: "Remove a member from an organization",
		ArgsSchema: objectSchema([]string{"org", "username"}, map[string]*incur.JSONSchema{
			"org":      stringSchema("Organization name"),
			"username": stringSchema("Username to remove"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org := stringValue(ctx.Args["org"])
			username := stringValue(ctx.Args["username"])
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/orgs/%s/members/%s", url.PathEscape(org), url.PathEscape(username)), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "removed", "org": org, "username": username}, nil
		},
	})
	registerOrgTeamCommands(cmd)
	return cmd
}

func registerOrgTeamCommands(cmd *incur.Cli) {
	cmd.Command("team list", &incur.CommandDef{
		Description: "List teams in an organization",
		ArgsSchema:  objectSchema([]string{"org"}, map[string]*incur.JSONSchema{"org": stringSchema("Organization name")}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", fmt.Sprintf("/api/orgs/%s/teams", url.PathEscape(stringValue(ctx.Args["org"]))), nil, nil)
		},
	})
	cmd.Command("team create", &incur.CommandDef{
		Description: "Create a team",
		ArgsSchema: objectSchema([]string{"org", "name"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"name": stringSchema("Team name"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"description": {Type: "string", Description: "Team description", Default: ""},
			"permission":  enumSchema("Default permission level", []string{"read", "write", "admin"}, "read"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", fmt.Sprintf("/api/orgs/%s/teams", url.PathEscape(stringValue(ctx.Args["org"]))), map[string]any{
				"name":        stringValue(ctx.Args["name"]),
				"description": stringValue(ctx.Options["description"]),
				"permission":  stringValue(ctx.Options["permission"]),
			}, nil)
		},
	})
	cmd.Command("team view", &incur.CommandDef{
		Description: "View team details",
		ArgsSchema: objectSchema([]string{"org", "team"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"])), nil, nil)
		},
	})
	cmd.Command("team edit", &incur.CommandDef{
		Description: "Update a team",
		ArgsSchema: objectSchema([]string{"org", "team"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"name":        stringSchema("New team name"),
			"description": stringSchema("New description"),
			"permission":  enumSchema("Default permission level", []string{"read", "write", "admin"}, ""),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			body := map[string]any{}
			if name := stringValue(ctx.Options["name"]); name != "" {
				body["name"] = name
			}
			if _, ok := ctx.Options["description"]; ok {
				body["description"] = stringValue(ctx.Options["description"])
			}
			if permission := stringValue(ctx.Options["permission"]); permission != "" {
				body["permission"] = permission
			}
			return APIRequest("PATCH", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"])), body, nil)
		},
	})
	cmd.Command("team delete", &incur.CommandDef{
		Description: "Delete a team",
		ArgsSchema: objectSchema([]string{"org", "team"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org := stringValue(ctx.Args["org"])
			team := stringValue(ctx.Args["team"])
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(team)), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "org": org, "team": team}, nil
		},
	})
	registerOrgTeamMemberCommands(cmd)
	registerOrgTeamRepoCommands(cmd)
}

func registerOrgTeamMemberCommands(cmd *incur.Cli) {
	cmd.Command("team member list", &incur.CommandDef{
		Description: "List members in a team",
		ArgsSchema: objectSchema([]string{"org", "team"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"]))+"/members", nil, nil)
		},
	})
	cmd.Command("team member add", &incur.CommandDef{
		Description: "Add a user to a team",
		ArgsSchema: objectSchema([]string{"org", "team", "username"}, map[string]*incur.JSONSchema{
			"org":      stringSchema("Organization name"),
			"team":     stringSchema("Team slug"),
			"username": stringSchema("Username to add"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("PUT", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"]))+"/members/"+url.PathEscape(stringValue(ctx.Args["username"])), nil, nil)
		},
	})
	cmd.Command("team member remove", &incur.CommandDef{
		Description: "Remove a user from a team",
		ArgsSchema: objectSchema([]string{"org", "team", "username"}, map[string]*incur.JSONSchema{
			"org":      stringSchema("Organization name"),
			"team":     stringSchema("Team slug"),
			"username": stringSchema("Username to remove"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org := stringValue(ctx.Args["org"])
			team := stringValue(ctx.Args["team"])
			username := stringValue(ctx.Args["username"])
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/orgs/%s/teams/%s/members/%s", url.PathEscape(org), url.PathEscape(team), url.PathEscape(username)), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "removed", "org": org, "team": team, "username": username}, nil
		},
	})
}

func registerOrgTeamRepoCommands(cmd *incur.Cli) {
	cmd.Command("team repo list", &incur.CommandDef{
		Description: "List repositories assigned to a team",
		ArgsSchema: objectSchema([]string{"org", "team"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"]))+"/repos", nil, nil)
		},
	})
	cmd.Command("team repo add", &incur.CommandDef{
		Description: "Grant a team access to a repository",
		ArgsSchema: objectSchema([]string{"org", "team", "repo"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
			"repo": stringSchema("Repository in OWNER/REPO format"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("PUT", orgTeamPath(ctx)+"/"+url.PathEscape(stringValue(ctx.Args["team"]))+"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(repo), nil, nil)
		},
	})
	cmd.Command("team repo remove", &incur.CommandDef{
		Description: "Remove a repository from a team",
		ArgsSchema: objectSchema([]string{"org", "team", "repo"}, map[string]*incur.JSONSchema{
			"org":  stringSchema("Organization name"),
			"team": stringSchema("Team slug"),
			"repo": stringSchema("Repository in OWNER/REPO format"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Args["repo"]))
			if err != nil {
				return nil, err
			}
			org := stringValue(ctx.Args["org"])
			team := stringValue(ctx.Args["team"])
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/orgs/%s/teams/%s/repos/%s/%s", url.PathEscape(org), url.PathEscape(team), url.PathEscape(owner), url.PathEscape(repo)), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "removed", "org": org, "team": team, "repo": owner + "/" + repo}, nil
		},
	})
}

func orgTeamPath(ctx *incur.CommandContext) string {
	return "/api/orgs/" + url.PathEscape(stringValue(ctx.Args["org"])) + "/teams"
}

func webhookCommand() *incur.Cli {
	cmd := incur.New("webhook", incur.WithDescription("Manage webhooks"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a webhook",
		OptionsSchema: objectSchema([]string{"url"}, map[string]*incur.JSONSchema{
			"url":          stringSchema("Webhook payload URL"),
			"events":       arraySchema("Events to trigger on"),
			"secret-stdin": booleanSchema("Read the webhook secret from stdin", false),
			"active":       booleanSchema("Whether the webhook is active", true),
			"repo":         stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			events := stringSliceValue(ctx.Options["events"])
			if len(events) == 0 {
				events = []string{"push"}
			}
			body := map[string]any{
				"url":       stringValue(ctx.Options["url"]),
				"events":    events,
				"is_active": ctx.Options["active"] == true,
			}
			if ctx.Options["secret-stdin"] == true {
				secret, err := readStdinText("webhook secret", true)
				if err != nil {
					return nil, err
				}
				body["secret"] = secret
			}
			return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/hooks", owner, repo), body, nil)
		},
	})
	cmd.Command("list", repoOnlyCommand("List webhooks", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/hooks", owner, repo), nil, nil)
	}))
	cmd.Command("view", &incur.CommandDef{
		Description: "View webhook details and recent deliveries",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Webhook ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			id := intValue(ctx.Args["id"], 0)
			hook, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/hooks/%d", owner, repo, id), nil, nil)
			if err != nil {
				return nil, err
			}
			deliveries, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/hooks/%d/deliveries", owner, repo, id), nil, nil)
			if err != nil {
				return nil, err
			}
			return map[string]any{"hook": hook, "deliveries": deliveries}, nil
		},
	})
	cmd.Command("update", &incur.CommandDef{
		Description: "Update a webhook",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Webhook ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"url":          stringSchema("Webhook payload URL"),
			"events":       arraySchema("Events to trigger on"),
			"secret-stdin": booleanSchema("Read the webhook secret from stdin", false),
			"active":       {Type: "boolean", Description: "Whether the webhook is active"},
			"repo":         stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			body := map[string]any{}
			if value := stringValue(ctx.Options["url"]); value != "" {
				body["url"] = value
			}
			if _, ok := ctx.Options["events"]; ok {
				body["events"] = stringSliceValue(ctx.Options["events"])
			}
			if _, ok := ctx.Options["active"]; ok {
				body["is_active"] = ctx.Options["active"] == true
			}
			if ctx.Options["secret-stdin"] == true {
				secret, err := readStdinText("webhook secret", true)
				if err != nil {
					return nil, err
				}
				body["secret"] = secret
			}
			id := intValue(ctx.Args["id"], 0)
			return APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s/hooks/%d", owner, repo, id), body, nil)
		},
	})
	cmd.Command("delete", &incur.CommandDef{
		Description: "Delete a webhook",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Webhook ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			id := intValue(ctx.Args["id"], 0)
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/hooks/%d", owner, repo, id), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "deleted", "id": id}, nil
		},
	})
	cmd.Command("deliveries", &incur.CommandDef{
		Description: "View delivery history for a webhook",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Webhook ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"replay": stringSchema("Delivery ID to replay"),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			id := intValue(ctx.Args["id"], 0)
			if replay := stringValue(ctx.Options["replay"]); replay != "" {
				return APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/hooks/%d/deliveries/%s/replay", owner, repo, id, url.PathEscape(replay)), nil, nil)
			}
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/hooks/%d/deliveries", owner, repo, id), nil, nil)
		},
	})
	return cmd
}

func extensionCommand() *incur.Cli {
	cmd := incur.New("extension", incur.WithDescription("Configure built-in integrations from the CLI"))
	cmd.Command("linear install", &incur.CommandDef{
		Description: "Configure a Linear team for a Smithers repository",
		OptionsSchema: objectSchema([]string{"team-id", "repo-owner", "repo-name", "repo-id"}, map[string]*incur.JSONSchema{
			"team-id":           stringSchema("Linear team ID"),
			"team-name":         stringSchema("Linear team display name"),
			"team-key":          stringSchema("Linear team key (e.g. JJH)"),
			"repo-owner":        stringSchema("Smithers repo owner"),
			"repo-name":         stringSchema("Smithers repo name"),
			"repo-id":           numberSchema("Smithers repo ID", nil),
			"credentials-stdin": booleanSchema("Read Linear OAuth credentials from stdin as JSON", false),
			"expires-at":        stringSchema("Token expiry (ISO-8601)"),
			"actor-id":          stringSchema("Linear actor ID for loop guard"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			if ctx.Options["credentials-stdin"] != true {
				return nil, fmt.Errorf("Linear OAuth credentials must be provided via stdin with --credentials-stdin")
			}
			raw, err := readStdinText("Linear OAuth credentials", false)
			if err != nil {
				return nil, err
			}
			var credentials struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
			}
			if err := json.Unmarshal([]byte(raw), &credentials); err != nil || credentials.AccessToken == "" {
				return nil, fmt.Errorf("invalid Linear OAuth credentials on stdin; expected JSON with access_token and optional refresh_token")
			}
			return APIRequest("POST", "/api/integrations/linear", map[string]any{
				"linear_team_id":   stringValue(ctx.Options["team-id"]),
				"linear_team_name": stringValue(ctx.Options["team-name"]),
				"linear_team_key":  stringValue(ctx.Options["team-key"]),
				"repo_owner":       stringValue(ctx.Options["repo-owner"]),
				"repo_name":        stringValue(ctx.Options["repo-name"]),
				"repo_id":          intValue(ctx.Options["repo-id"], 0),
				"access_token":     credentials.AccessToken,
				"refresh_token":    credentials.RefreshToken,
				"expires_at":       stringValue(ctx.Options["expires-at"]),
				"linear_actor_id":  stringValue(ctx.Options["actor-id"]),
			}, nil)
		},
	})
	cmd.Command("linear list", &incur.CommandDef{
		Description: "List Linear integrations",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("GET", "/api/integrations/linear", nil, nil)
		},
	})
	cmd.Command("linear remove", &incur.CommandDef{
		Description: "Remove a Linear integration",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Integration ID", nil)}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := intValue(ctx.Args["id"], 0)
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/integrations/linear/%d", id), nil, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "removed", "id": id}, nil
		},
	})
	cmd.Command("linear sync", &incur.CommandDef{
		Description: "Trigger initial sync for a Linear integration",
		ArgsSchema:  objectSchema([]string{"id"}, map[string]*incur.JSONSchema{"id": numberSchema("Integration ID", nil)}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return APIRequest("POST", fmt.Sprintf("/api/integrations/linear/%d/sync", intValue(ctx.Args["id"], 0)), nil, nil)
		},
	})
	return cmd
}

func artifactCommand() *incur.Cli {
	cmd := incur.New("artifact", incur.WithDescription("List and download workflow artifacts"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List artifacts for a workflow run",
		ArgsSchema:  objectSchema([]string{"runId"}, map[string]*incur.JSONSchema{"runId": numberSchema("Run ID", nil)}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/actions/runs/%d/artifacts", owner, repo, intValue(ctx.Args["runId"], 0)), nil, nil)
		},
	})
	cmd.Command("download", &incur.CommandDef{
		Description: "Download an artifact from a workflow run",
		ArgsSchema: objectSchema([]string{"runId", "name"}, map[string]*incur.JSONSchema{
			"runId": numberSchema("Run ID", nil),
			"name":  stringSchema("Artifact name"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":   stringSchema("Repository (OWNER/REPO)"),
			"output": stringSchema("Output path (defaults to artifact name)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			artifact, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/actions/runs/%d/artifacts/%s/download", owner, repo, intValue(ctx.Args["runId"], 0), url.PathEscape(stringValue(ctx.Args["name"]))), nil, nil)
			if err != nil {
				return nil, err
			}
			record, ok := artifact.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("unexpected artifact download response")
			}
			downloadURL := stringValue(record["download_url"])
			if downloadURL == "" {
				return nil, fmt.Errorf("artifact response did not include download_url")
			}
			name := stringValue(record["name"])
			if name == "" {
				name = stringValue(ctx.Args["name"])
			}
			output := stringValue(ctx.Options["output"])
			if output == "" {
				output, err = artifactOutputName(name)
				if err != nil {
					return nil, err
				}
			}
			abs, err := moreHTTPAbs(output)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return nil, err
			}
			if err := downloadFile(downloadURL, abs); err != nil {
				return nil, err
			}
			return map[string]any{
				"name":         name,
				"path":         abs,
				"size":         record["size"],
				"content_type": record["content_type"],
			}, nil
		},
	})
	return cmd
}

func artifactOutputName(name string) (string, error) {
	normalized := strings.NewReplacer("/", string(os.PathSeparator), `\`, string(os.PathSeparator)).Replace(name)
	base := filepath.Base(normalized)
	if base == "" || base == "." || base == ".." || base == "/" || base == `\` {
		return "", fmt.Errorf("artifact response did not include a safe name")
	}
	return base, nil
}

func unauthenticatedJSONRequest(method, path string, body any) (any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	baseURL := strings.TrimRight(LoadConfig().APIURL, "/")
	req, err := http.NewRequestWithContext(context.Background(), method, baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := resp.Status
		var parsed struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &parsed) == nil && parsed.Message != "" {
			detail = parsed.Message
		} else if strings.TrimSpace(string(raw)) != "" {
			detail = strings.TrimSpace(string(raw))
		}
		return nil, fmt.Errorf("%s", detail)
	}
	if len(raw) == 0 {
		return nil, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

// maxArtifactBytes caps the size of a file downloaded via downloadFile to
// guard against unbounded reads (DoS / disk exhaustion) from a malicious or
// misbehaving server.
const maxArtifactBytes = 2 << 30 // 2 GiB

func downloadFile(downloadURL, path string) error {
	return downloadFileLimit(downloadURL, path, maxArtifactBytes)
}

// downloadFileLimit downloads downloadURL to path, bounding the response body
// to maxBytes. It returns an error if the body exceeds maxBytes.
func downloadFileLimit(downloadURL, path string, maxBytes int64) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	downloadReq, err := http.NewRequestWithContext(context.Background(), http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(downloadReq)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.Body == nil {
		return fmt.Errorf("failed to download artifact: %d %s", resp.StatusCode, resp.Status)
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	// Read at most maxBytes+1 so we can detect when the body exceeds the limit
	// (the extra byte means the limit was hit, not just reached).
	n, err := io.Copy(file, io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return err
	}
	if n > maxBytes {
		return fmt.Errorf("failed to download artifact: file exceeds maximum allowed size of %d bytes", maxBytes)
	}
	return nil
}
