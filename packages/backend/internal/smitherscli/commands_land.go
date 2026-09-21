package smitherscli

import (
	"fmt"
	"net/url"
	"strconv"

	incur "github.com/smithersai/incur"
)

func landCommand() *incur.Cli {
	cmd := incur.New("land", incur.WithDescription("Manage landing requests"))
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a landing request",
		OptionsSchema: objectSchema([]string{"title"}, map[string]*incur.JSONSchema{
			"title":     stringSchema("Landing request title"),
			"body":      {Type: "string", Description: "Landing request body", Default: ""},
			"target":    {Type: "string", Description: "Target bookmark", Default: "main"},
			"change":    stringSchema("Change ID(s) to land"),
			"change-id": stringSchema("Change ID(s) to land"),
			"repo":      stringSchema("Repository (OWNER/REPO)"),
			"stack":     booleanSchema("Include the full stack up to the target", false),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			explicitChange := stringValue(ctx.Options["change-id"])
			if explicitChange == "" {
				explicitChange = stringValue(ctx.Options["change"])
			}
			var changeIDs []string
			var err error
			if explicitChange != "" {
				changeIDs = []string{explicitChange}
			} else if ctx.Options["stack"] == true {
				changeIDs, err = ListLocalStackChangeIDs(stringValue(ctx.Options["target"]))
				if err != nil {
					return nil, err
				}
			} else {
				changeID, err := CurrentLocalChangeID()
				if err != nil {
					return nil, err
				}
				changeIDs = []string{changeID}
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			landing, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/landings", owner, repo), map[string]any{
				"title":           stringValue(ctx.Options["title"]),
				"body":            stringValue(ctx.Options["body"]),
				"target_bookmark": stringValue(ctx.Options["target"]),
				"change_ids":      changeIDs,
			}, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return landing, nil
			}
			return formatLandingCreate(owner+"/"+repo, landing), nil
		},
	})
	cmd.Command("list", &incur.CommandDef{
		Description: "List landing requests",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"state":  enumSchema("Filter by state", []string{"open", "closed", "merged", "landed", "all"}, "open"),
			"limit":  numberSchema("Results per page", 30),
			"cursor": stringSchema("Pagination cursor (from previous response)"),
			"all":    booleanSchema("Fetch all pages automatically", false),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			buildPath := func(cursor string) string {
				query := url.Values{}
				query.Set("limit", strconv.Itoa(intValue(ctx.Options["limit"], 30)))
				if state := normalizeLandingListState(stringValue(ctx.Options["state"])); state != "" && state != "all" {
					query.Set("state", state)
				}
				if cursor != "" {
					query.Set("cursor", cursor)
				}
				return fmt.Sprintf("/api/repos/%s/%s/landings?%s", owner, repo, query.Encode())
			}
			if ctx.Options["all"] == true {
				landings, err := APIListAll(buildPath, nil)
				if err != nil {
					return nil, cleanAPIError(err)
				}
				if ctx.FormatExplicit {
					if ctx.Format == string(incur.FormatTOON) {
						return formatLandingListToon(landings), nil
					}
					return landings, nil
				}
				return formatLandingList(landings), nil
			}
			landings, nextCursor, err := APIList(buildPath(stringValue(ctx.Options["cursor"])), nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				if nextCursor != "" {
					return map[string]any{"landings": landings, "next_cursor": nextCursor}, nil
				}
				if ctx.Format == string(incur.FormatTOON) {
					return formatLandingListToon(arrayValue(landings)), nil
				}
				return landings, nil
			}
			formatted := formatLandingList(arrayValue(landings))
			if nextCursor != "" {
				return formatted + "\n\nMore results available. Use --cursor " + nextCursor + " for the next page, or --all to fetch everything.", nil
			}
			return formatted, nil
		},
	})
	cmd.Command("view", landNumberCommand("View a landing request", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		details, err := landingDetails(owner, repo, number)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return details, nil
		}
		return formatLandingView(details), nil
	}))
	cmd.Command("review", landNumberCommandWithOptions("Submit a review on a landing request", map[string]*incur.JSONSchema{
		"approve": booleanSchema("Approve the landing request", false),
		"body":    {Type: "string", Description: "Review comment", Default: ""},
		"commit":  stringSchema("Commit ID of the revision being reviewed"),
	}, []string{"commit"}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		reviewType := "comment"
		if ctx.Options["approve"] == true {
			reviewType = "approve"
		}
		review, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/landings/%d/reviews", owner, repo, number), map[string]any{
			"type":      reviewType,
			"body":      stringValue(ctx.Options["body"]),
			"commit_id": stringValue(ctx.Options["commit"]),
		}, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return review, nil
		}
		label := "review"
		if reviewType == "approve" {
			label = "approval"
		}
		return fmt.Sprintf("Submitted %s for landing request #%d", label, number), nil
	}))
	cmd.Command("checks", landNumberCommand("View landing request checks", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		landing, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d", owner, repo, number), nil, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		statuses := []any{}
		for _, changeIDValue := range arrayValue(objectValue(landing)["change_ids"]) {
			changeID := stringValue(changeIDValue)
			items, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/commits/%s/statuses", owner, repo, url.PathEscape(changeID)), nil, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			for _, item := range arrayValue(items) {
				record := objectValue(item)
				record["change_id"] = changeID
				statuses = append(statuses, record)
			}
		}
		payload := map[string]any{"landing": landing, "statuses": statuses}
		if ctx.FormatExplicit {
			return payload, nil
		}
		return formatLandingChecks(statuses), nil
	}))
	cmd.Command("conflicts", landNumberCommand("View landing request conflicts", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		conflicts, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d/conflicts", owner, repo, number), nil, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return conflicts, nil
		}
		status := stringValue(objectValue(conflicts)["conflict_status"])
		if status == "" {
			status = "unknown"
		}
		return "Conflicts: " + status, nil
	}))
	cmd.Command("edit", landNumberCommandWithOptions("Edit a landing request", map[string]*incur.JSONSchema{
		"title":  stringSchema("New title"),
		"body":   stringSchema("New body"),
		"target": stringSchema("New target bookmark"),
	}, nil, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		body := map[string]any{}
		if _, ok := ctx.Options["title"]; ok {
			body["title"] = stringValue(ctx.Options["title"])
		}
		if _, ok := ctx.Options["body"]; ok {
			body["body"] = stringValue(ctx.Options["body"])
		}
		if _, ok := ctx.Options["target"]; ok {
			body["target_bookmark"] = stringValue(ctx.Options["target"])
		}
		landing, err := APIRequest("PATCH", fmt.Sprintf("/api/repos/%s/%s/landings/%d", owner, repo, number), body, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return landing, nil
		}
		return formatLandingMutation("Updated", landing), nil
	}))
	cmd.Command("comment", landNumberCommandWithOptions("Add a comment to a landing request", map[string]*incur.JSONSchema{
		"body":   stringSchema("Comment body"),
		"commit": stringSchema("Commit ID of the revision being commented on"),
	}, []string{"body", "commit"}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		comment, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/landings/%d/comments", owner, repo, number), map[string]any{
			"body":      stringValue(ctx.Options["body"]),
			"commit_id": stringValue(ctx.Options["commit"]),
		}, nil)
		if err != nil {
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return comment, nil
		}
		return fmt.Sprintf("Added a comment to landing request #%d", number), nil
	}))
	cmd.Command("land", landNumberCommandWithOptions("Land (merge) a landing request", map[string]*incur.JSONSchema{
		"commit": stringSchema("Expected current commit ID"),
	}, []string{"commit"}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		landing, err := APIRequest("PUT", fmt.Sprintf("/api/repos/%s/%s/landings/%d/land", owner, repo, number), map[string]any{
			"commit_id": stringValue(ctx.Options["commit"]),
		}, nil)
		if err != nil {
			if apiErr, ok := err.(*APIError); ok {
				if apiErr.Status == 404 {
					return nil, fmt.Errorf("landing request #%d was not found", number)
				}
				if apiErr.Status == 409 {
					return nil, fmt.Errorf("landing request #%d cannot be landed right now: %s", number, apiErr.Detail)
				}
			}
			return nil, cleanAPIError(err)
		}
		if ctx.FormatExplicit {
			return landing, nil
		}
		return formatLandingMutation("Landed", landing), nil
	}))
	return cmd
}

func normalizeLandingListState(state string) string {
	if state == "landed" {
		return "merged"
	}
	return state
}

func parseLandingNumber(value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("invalid landing request number")
	}
	return parsed, nil
}

func landNumberCommand(description string, handler func(owner, repo string, number int, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	return landNumberCommandWithOptions(description, nil, nil, handler)
}

func landNumberCommandWithOptions(description string, extra map[string]*incur.JSONSchema, required []string, handler func(owner, repo string, number int, ctx *incur.CommandContext) (any, error)) *incur.CommandDef {
	properties := map[string]*incur.JSONSchema{"repo": stringSchema("Repository (OWNER/REPO)")}
	for key, schema := range extra {
		properties[key] = schema
	}
	return &incur.CommandDef{
		Description:   description,
		ArgsSchema:    objectSchema([]string{"number"}, map[string]*incur.JSONSchema{"number": stringSchema("Landing request number")}),
		OptionsSchema: objectSchema(required, properties),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			number, err := parseLandingNumber(stringValue(ctx.Args["number"]))
			if err != nil {
				return nil, err
			}
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			return handler(owner, repo, number, ctx)
		},
	}
}

func landingDetails(owner, repo string, number int) (map[string]any, error) {
	landing, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d", owner, repo, number), nil, nil)
	if err != nil {
		return nil, err
	}
	changes, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d/changes?page=1&per_page=100", owner, repo, number), nil, nil)
	if err != nil {
		return nil, err
	}
	reviews, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d/reviews?page=1&per_page=100", owner, repo, number), nil, nil)
	if err != nil {
		return nil, err
	}
	conflicts, err := APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/landings/%d/conflicts", owner, repo, number), nil, nil)
	if err != nil {
		return nil, err
	}
	return map[string]any{"landing": landing, "changes": changes, "reviews": reviews, "conflicts": conflicts}, nil
}
