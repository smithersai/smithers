package smitherscli

import (
	"fmt"
	"strconv"
	"strings"

	incur "github.com/smithersai/incur"
)

// changesetCommand manages cross-repository changesets: one organization
// superproject commit that pins a change in each member repository and lands
// them as a transaction.
func changesetCommand() *incur.Cli {
	cmd := incur.New("changeset", incur.WithDescription("Manage cross-repository changesets (organization superproject)"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a changeset that pins one change per member repository",
		OptionsSchema: objectSchema([]string{"org", "member"}, map[string]*incur.JSONSchema{
			"org":         stringSchema("Organization name"),
			"member":      stringSchema("Member as REPO=CHANGE_ID (repeat or comma-separate for several)"),
			"description": {Type: "string", Description: "Changeset description", Default: ""},
			"target":      {Type: "string", Description: "Target bookmark for every member and the superproject", Default: "main"},
			"parent":      {Type: "string", Description: "Parent changeset change id (stacking)", Default: ""},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org := strings.TrimSpace(stringValue(ctx.Options["org"]))
			if org == "" {
				return nil, fmt.Errorf("organization is required")
			}
			members, err := parseChangesetMembers(ctx.Options["member"])
			if err != nil {
				return nil, err
			}
			body := map[string]any{
				"description":     stringValue(ctx.Options["description"]),
				"target_bookmark": stringValue(ctx.Options["target"]),
				"members":         members,
			}
			if parent := strings.TrimSpace(stringValue(ctx.Options["parent"])); parent != "" {
				body["parent_change_id"] = parent
			}
			created, err := APIRequest("POST", fmt.Sprintf("/api/orgs/%s/changesets", org), body, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return created, nil
			}
			return formatChangeset("Created", created), nil
		},
	})
	cmd.Command("get", &incur.CommandDef{
		Description: "Show a changeset",
		OptionsSchema: objectSchema([]string{"org", "id"}, map[string]*incur.JSONSchema{
			"org": stringSchema("Organization name"),
			"id":  numberSchema("Changeset id", 0),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org, id, err := changesetTarget(ctx)
			if err != nil {
				return nil, err
			}
			cs, err := APIRequest("GET", fmt.Sprintf("/api/orgs/%s/changesets/%d", org, id), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return cs, nil
			}
			return formatChangeset("Changeset", cs), nil
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List an organization's changesets",
		OptionsSchema: objectSchema([]string{"org"}, map[string]*incur.JSONSchema{
			"org":   stringSchema("Organization name"),
			"limit": numberSchema("Results per page", 30),
			"page":  numberSchema("Page number", 1),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org := strings.TrimSpace(stringValue(ctx.Options["org"]))
			if org == "" {
				return nil, fmt.Errorf("organization is required")
			}
			path := fmt.Sprintf("/api/orgs/%s/changesets?page=%d&per_page=%d", org, intValue(ctx.Options["page"], 1), intValue(ctx.Options["limit"], 30))
			items, err := APIRequest("GET", path, nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return items, nil
			}
			list, _ := items.([]any)
			rows := make([][]string, 0, len(list))
			for _, item := range list {
				m, _ := item.(map[string]any)
				rows = append(rows, []string{
					formatNumber(m["id"]),
					stringValue(m["state"]),
					shortID(stringValue(m["change_id"])),
					stringValue(m["target_bookmark"]),
					fmt.Sprintf("%d", len(anySlice(m["members"]))),
					stringValue(m["description"]),
				})
			}
			return formatTable([]string{"ID", "STATE", "CHANGE", "TARGET", "MEMBERS", "DESCRIPTION"}, rows), nil
		},
	})
	cmd.Command("land", &incur.CommandDef{
		Description: "Land a changeset: every member change, then the superproject commit, as one transaction",
		OptionsSchema: objectSchema([]string{"org", "id"}, map[string]*incur.JSONSchema{
			"org": stringSchema("Organization name"),
			"id":  numberSchema("Changeset id", 0),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			org, id, err := changesetTarget(ctx)
			if err != nil {
				return nil, err
			}
			landed, err := APIRequest("POST", fmt.Sprintf("/api/orgs/%s/changesets/%d/land", org, id), nil, nil)
			if err != nil {
				if apiErr, ok := err.(*APIError); ok && apiErr.Status == 409 {
					return nil, fmt.Errorf("changeset %d cannot be landed: %s", id, apiErr.Detail)
				}
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return landed, nil
			}
			return formatChangeset("Landed", landed), nil
		},
	})
	return cmd
}

func changesetTarget(ctx *incur.CommandContext) (string, int, error) {
	org := strings.TrimSpace(stringValue(ctx.Options["org"]))
	if org == "" {
		return "", 0, fmt.Errorf("organization is required")
	}
	id := intValue(ctx.Options["id"], 0)
	if id <= 0 {
		return "", 0, fmt.Errorf("changeset id is required")
	}
	return org, id, nil
}

// parseChangesetMembers accepts a string, a comma-separated string, or a list
// of REPO=CHANGE_ID entries.
func parseChangesetMembers(raw any) ([]map[string]any, error) {
	var entries []string
	switch v := raw.(type) {
	case string:
		entries = strings.Split(v, ",")
	case []any:
		for _, item := range v {
			entries = append(entries, strings.Split(stringValue(item), ",")...)
		}
	case []string:
		for _, item := range v {
			entries = append(entries, strings.Split(item, ",")...)
		}
	default:
		if raw != nil {
			entries = strings.Split(stringValue(raw), ",")
		}
	}
	members := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		repo, changeID, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(repo) == "" || strings.TrimSpace(changeID) == "" {
			return nil, fmt.Errorf("member %q must be REPO=CHANGE_ID", entry)
		}
		members = append(members, map[string]any{
			"repo":      strings.TrimSpace(repo),
			"change_id": strings.TrimSpace(changeID),
		})
	}
	if len(members) == 0 {
		return nil, fmt.Errorf("at least one --member REPO=CHANGE_ID is required")
	}
	return members, nil
}

func formatChangeset(verb string, payload any) string {
	m, _ := payload.(map[string]any)
	var b strings.Builder
	fmt.Fprintf(&b, "%s changeset #%s (%s) on %s\n", verb, formatNumber(m["id"]), stringValue(m["state"]), stringValue(m["superproject"]))
	fmt.Fprintf(&b, "  change:  %s\n", stringValue(m["change_id"]))
	fmt.Fprintf(&b, "  commit:  %s\n", stringValue(m["commit_id"]))
	if landed := stringValue(m["landed_commit_id"]); landed != "" {
		fmt.Fprintf(&b, "  landed:  %s\n", landed)
	}
	fmt.Fprintf(&b, "  target:  %s\n", stringValue(m["target_bookmark"]))
	if reason := stringValue(m["failure_reason"]); reason != "" {
		fmt.Fprintf(&b, "  failure: %s\n", reason)
	}
	for _, item := range anySlice(m["members"]) {
		member, _ := item.(map[string]any)
		line := fmt.Sprintf("  - %s @ %s (%s)", stringValue(member["repository"]), shortID(stringValue(member["change_id"])), stringValue(member["target_bookmark"]))
		if landed := stringValue(member["landed_commit_id"]); landed != "" {
			line += " landed " + shortID(landed)
		}
		b.WriteString(line + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func anySlice(v any) []any {
	list, _ := v.([]any)
	return list
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func formatNumber(v any) string {
	switch n := v.(type) {
	case float64:
		return strconv.FormatInt(int64(n), 10)
	case int64:
		return strconv.FormatInt(n, 10)
	case int:
		return strconv.Itoa(n)
	default:
		return stringValue(v)
	}
}
