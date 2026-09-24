package smitherscli

import (
	"fmt"
	"strings"

	incur "github.com/smithersai/incur"
)

func statusCommand() *incur.Cli {
	return incur.New("status",
		incur.WithDescription("Show working copy status"),
		incur.WithRootCommand(&incur.CommandDef{
			Description: "Show working copy status",
			Handler: func(ctx *incur.CommandContext) (any, error) {
				status, err := GetLocalStatus(LocalReadOptions{})
				if err != nil {
					return nil, err
				}
				if ctx.FormatExplicit {
					if ctx.Format == string(incur.FormatTOON) {
						return formatStatusToon(status), nil
					}
					return status, nil
				}
				return formatStatus(status), nil
			},
		}),
	)
}

func bookmarkCommand() *incur.Cli {
	cmd := incur.New("bookmark", incur.WithDescription("Manage bookmarks (branches)"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List local bookmarks",
		Handler: func(ctx *incur.CommandContext) (any, error) {
			bookmarks, err := ListLocalBookmarks(nil, LocalReadOptions{})
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				if ctx.Format == string(incur.FormatTOON) {
					return formatBookmarkListToon(bookmarks), nil
				}
				return bookmarks, nil
			}
			if len(bookmarks) == 0 {
				return "No bookmarks", nil
			}
			lines := []string{}
			for _, bookmark := range bookmarks {
				if bookmark.TargetChangeID != nil {
					lines = append(lines, bookmark.Name+" "+*bookmark.TargetChangeID)
				} else {
					lines = append(lines, bookmark.Name)
				}
			}
			return strings.Join(lines, "\n"), nil
		},
	})
	cmd.Command("create", &incur.CommandDef{
		Description: "Create a bookmark",
		ArgsSchema: objectSchema([]string{"name"}, map[string]*incur.JSONSchema{
			"name": stringSchema("Bookmark name"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"change": stringSchema("Target change ID"),
			"repo":   stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			bookmark, err := CreateLocalBookmark(stringValue(ctx.Args["name"]), stringValue(ctx.Options["change"]))
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				if ctx.Format == string(incur.FormatTOON) {
					return formatBookmarkToon(bookmark), nil
				}
				return bookmark, nil
			}
			if bookmark.TargetChangeID != nil {
				return fmt.Sprintf("Created bookmark %s at %s", bookmark.Name, *bookmark.TargetChangeID), nil
			}
			return fmt.Sprintf("Created bookmark %s", bookmark.Name), nil
		},
	})
	cmd.Command("delete", &incur.CommandDef{
		Description: "Delete a bookmark",
		ArgsSchema: objectSchema([]string{"name"}, map[string]*incur.JSONSchema{
			"name": stringSchema("Bookmark name"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			name := stringValue(ctx.Args["name"])
			ok, err := HasLocalBookmark(name)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fmt.Errorf("Bookmark %s was not found", name)
			}
			if err := DeleteLocalBookmark(name); err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				return map[string]any{"status": "deleted", "name": name}, nil
			}
			return "Deleted bookmark " + name, nil
		},
	})
	return cmd
}

func changeCommand() *incur.Cli {
	cmd := incur.New("change", incur.WithDescription("View changes"))
	cmd.Command("list", &incur.CommandDef{
		Description: "List changes",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"limit": numberSchema("Number of changes to show", 10),
			"repo":  stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			limit := intValue(ctx.Options["limit"], 10)
			changes, err := ListLocalChanges(limit)
			if err != nil {
				return nil, err
			}
			if ctx.FormatExplicit {
				if ctx.Format == string(incur.FormatTOON) {
					return formatChangeListToon(changes), nil
				}
				return changes, nil
			}
			lines := []string{}
			for _, change := range changes {
				if change.Description != "" {
					lines = append(lines, change.ChangeID+" "+change.Description)
				} else {
					lines = append(lines, change.ChangeID)
				}
			}
			return strings.Join(lines, "\n"), nil
		},
	})
	cmd.Command("show", &incur.CommandDef{
		Description: "Show a specific change",
		ArgsSchema: objectSchema([]string{"id"}, map[string]*incur.JSONSchema{
			"id": stringSchema("Change ID"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := stringValue(ctx.Args["id"])
			if ctx.FormatExplicit {
				return GetLocalChangeDetails(id)
			}
			return GetLocalChange(id)
		},
	})
	cmd.Command("diff", &incur.CommandDef{
		Description: "Show diff for a change",
		ArgsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"id": stringSchema("Change ID (defaults to working copy)"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := stringValue(ctx.Args["id"])
			if id == "" {
				id = "@"
			}
			diff, err := GetLocalDiff(id)
			if err != nil {
				return nil, err
			}
			return map[string]any{"change_id": id, "diff": diff}, nil
		},
	})
	cmd.Command("files", &incur.CommandDef{
		Description: "List files in a change",
		ArgsSchema: objectSchema([]string{"id"}, map[string]*incur.JSONSchema{
			"id": stringSchema("Change ID"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := stringValue(ctx.Args["id"])
			files, err := ListLocalChangeFiles(id)
			if err != nil {
				return nil, err
			}
			return map[string]any{"change_id": id, "files": files}, nil
		},
	})
	cmd.Command("conflicts", &incur.CommandDef{
		Description: "List conflicts in a change",
		ArgsSchema: objectSchema([]string{"id"}, map[string]*incur.JSONSchema{
			"id": stringSchema("Change ID"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := stringValue(ctx.Args["id"])
			conflicts, err := ListLocalChangeConflicts(id)
			if err != nil {
				return nil, err
			}
			return map[string]any{"change_id": id, "conflicts": conflicts}, nil
		},
	})
	return cmd
}

func formatStatus(status LocalStatusSummary) string {
	lines := []string{
		"Working copy: " + status.WorkingCopy.ChangeID + optionalSuffix(status.WorkingCopy.Description),
		"Parent: " + status.Parent.ChangeID + optionalSuffix(status.Parent.Description),
	}
	if len(status.Files) > 0 {
		lines = append(lines, "", "Modified files:")
		for _, file := range status.Files {
			lines = append(lines, file.Status+" "+file.Path)
		}
	}
	return strings.Join(lines, "\n")
}

func formatStatusToon(status LocalStatusSummary) string {
	lines := []string{
		"working_copy:",
		"  change_id: " + toonScalar(status.WorkingCopy.ChangeID, false),
		"  commit_id: " + toonScalar(status.WorkingCopy.CommitID, false),
		"  description: " + toonScalar(status.WorkingCopy.Description, true),
		"parent:",
		"  change_id: " + toonScalar(status.Parent.ChangeID, false),
		"  commit_id: " + toonScalar(status.Parent.CommitID, true),
		"  description: " + toonScalar(status.Parent.Description, true),
	}
	if len(status.Files) == 0 {
		lines = append(lines, "files[0]:")
		return strings.Join(lines, "\n")
	}
	lines = append(lines, fmt.Sprintf("files[%d]{path,status}:", len(status.Files)))
	for _, file := range status.Files {
		lines = append(lines, "  "+toonScalar(file.Path, false)+","+toonScalar(file.Status, false))
	}
	return strings.Join(lines, "\n")
}

func formatChangeListToon(changes []LocalChangeSummary) string {
	lines := []string{fmt.Sprintf("[%d]{change_id,description}:", len(changes))}
	for _, change := range changes {
		lines = append(lines, "  "+toonScalar(change.ChangeID, false)+","+toonEmptyQuoted(change.Description))
	}
	return strings.Join(lines, "\n")
}

func formatBookmarkListToon(bookmarks []LocalBookmark) string {
	lines := []string{fmt.Sprintf("[%d]{name,target_change_id,target_commit_id}:", len(bookmarks))}
	for _, bookmark := range bookmarks {
		lines = append(lines, "  "+toonScalar(bookmark.Name, false)+","+toonStringPtr(bookmark.TargetChangeID)+","+toonStringPtr(bookmark.TargetCommitID))
	}
	return strings.Join(lines, "\n")
}

func formatBookmarkToon(bookmark LocalBookmark) string {
	return strings.Join([]string{
		"name: " + toonScalar(bookmark.Name, false),
		"target_change_id: " + toonStringPtr(bookmark.TargetChangeID),
		"target_commit_id: " + toonStringPtr(bookmark.TargetCommitID),
	}, "\n")
}

func toonEmptyQuoted(value string) string {
	if value == "" {
		return `""`
	}
	return toonScalar(value, false)
}

func toonStringPtr(value *string) string {
	if value == nil {
		return "null"
	}
	return toonScalar(*value, false)
}

func optionalSuffix(value string) string {
	if value == "" {
		return ""
	}
	return " " + value
}

func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	default:
		return fallback
	}
}
