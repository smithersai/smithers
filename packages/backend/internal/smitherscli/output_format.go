package smitherscli

import (
	"fmt"
	"strings"
)

func objectValue(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func arrayValue(value any) []any {
	if typed, ok := value.([]any); ok {
		return typed
	}
	return nil
}

func joinAnyValues(values []any, separator string) string {
	parts := []string{}
	for _, value := range values {
		text := stringValue(value)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, separator)
}

func formatTable(headers []string, rows [][]string) string {
	widths := make([]int, len(headers))
	for i, header := range headers {
		widths[i] = len(header)
	}
	for _, row := range rows {
		for i := range headers {
			if i < len(row) && len(row[i]) > widths[i] {
				widths[i] = len(row[i])
			}
		}
	}
	lines := []string{formatTableRow(headers, widths)}
	separators := make([]string, len(headers))
	for i, width := range widths {
		separators[i] = strings.Repeat("-", width)
	}
	lines = append(lines, formatTableRow(separators, widths))
	for _, row := range rows {
		lines = append(lines, formatTableRow(row, widths))
	}
	return strings.Join(lines, "\n")
}

func formatTableRow(row []string, widths []int) string {
	cells := make([]string, len(widths))
	for i, width := range widths {
		cell := ""
		if i < len(row) {
			cell = row[i]
		}
		cells[i] = cell + strings.Repeat(" ", width-len(cell))
	}
	return strings.Join(cells, "  ")
}

func issueAuthor(issue map[string]any) string {
	if author := objectValue(issue["author"]); author != nil {
		if login := stringValue(author["login"]); login != "" {
			return login
		}
	}
	return "unknown"
}

func issueAssignees(issue map[string]any) string {
	parts := []string{}
	for _, assignee := range arrayValue(issue["assignees"]) {
		if login := stringValue(objectValue(assignee)["login"]); login != "" {
			parts = append(parts, login)
		}
	}
	return strings.Join(parts, ", ")
}

func formatIssueCreate(issue any) string {
	record := objectValue(issue)
	return fmt.Sprintf("Created issue #%s: %s", stringValue(record["number"]), stringValue(record["title"]))
}

func formatIssueCreateToon(issue any) string {
	record := objectValue(issue)
	lines := []string{}
	appendToonField(&lines, record, "id", false)
	appendToonField(&lines, record, "number", false)
	appendToonField(&lines, record, "title", false)
	appendToonField(&lines, record, "body", false)
	appendToonField(&lines, record, "state", false)
	if author := objectValue(record["author"]); author != nil {
		lines = append(lines, "author:")
		appendNestedToonField(&lines, author, "id", false)
		appendNestedToonField(&lines, author, "login", false)
	}
	if assignees, ok := record["assignees"].([]any); ok {
		lines = append(lines, fmt.Sprintf("assignees[%d]{id,login}:", len(assignees)))
		for _, raw := range assignees {
			assignee := objectValue(raw)
			lines = append(lines, fmt.Sprintf("  %s,%s", toonScalar(assignee["id"], false), toonScalar(assignee["login"], false)))
		}
	}
	appendToonField(&lines, record, "milestone_id", false)
	appendToonField(&lines, record, "comment_count", false)
	appendToonField(&lines, record, "created_at", true)
	appendToonField(&lines, record, "updated_at", true)
	return strings.Join(lines, "\n")
}

func formatIssueList(issues []any) string {
	if len(issues) == 0 {
		return "No issues found"
	}
	rows := make([][]string, 0, len(issues))
	for _, issue := range issues {
		record := objectValue(issue)
		rows = append(rows, []string{
			"#" + stringValue(record["number"]),
			stringValue(record["state"]),
			stringValue(record["title"]),
			issueAuthor(record),
		})
	}
	return formatTable([]string{"Number", "State", "Title", "Author"}, rows)
}

func formatIssueView(issue any) string {
	record := objectValue(issue)
	lines := []string{
		strings.TrimSpace("#" + stringValue(record["number"]) + " " + stringValue(record["title"])),
		"State: " + stringValue(record["state"]),
		"Author: " + issueAuthor(record),
	}
	if assignees := issueAssignees(record); assignees != "" {
		lines = append(lines, "Assignees: "+assignees)
	}
	if body := stringValue(record["body"]); body != "" {
		lines = append(lines, "", body)
	}
	return strings.Join(lines, "\n")
}

func formatIssueMutation(action string, issue any) string {
	record := objectValue(issue)
	return fmt.Sprintf("%s issue #%s: %s", action, stringValue(record["number"]), stringValue(record["title"]))
}

func wikiAuthor(page map[string]any) string {
	if author := objectValue(page["author"]); author != nil {
		if login := stringValue(author["login"]); login != "" {
			return login
		}
	}
	return "unknown"
}

func formatWikiCreate(page any) string {
	record := objectValue(page)
	return fmt.Sprintf("Created wiki page %s (%s)", stringValue(record["title"]), stringValue(record["slug"]))
}

func formatWikiList(pages []any) string {
	if len(pages) == 0 {
		return "No wiki pages found"
	}
	rows := make([][]string, 0, len(pages))
	for _, page := range pages {
		record := objectValue(page)
		rows = append(rows, []string{
			stringValue(record["title"]),
			stringValue(record["slug"]),
			wikiAuthor(record),
			stringValue(record["updated_at"]),
		})
	}
	return formatTable([]string{"Title", "Slug", "Author", "Updated"}, rows)
}

func formatWikiView(page any) string {
	record := objectValue(page)
	lines := []string{
		stringValue(record["title"]),
		"Slug: " + stringValue(record["slug"]),
		"Author: " + wikiAuthor(record),
	}
	if updatedAt := stringValue(record["updated_at"]); updatedAt != "" {
		lines = append(lines, "Updated: "+updatedAt)
	}
	if body := stringValue(record["body"]); body != "" {
		lines = append(lines, "", body)
	}
	return strings.Join(lines, "\n")
}

func formatWikiMutation(action string, page any) string {
	record := objectValue(page)
	return fmt.Sprintf("%s wiki page %s (%s)", action, stringValue(record["title"]), stringValue(record["slug"]))
}

func formatWikiRevisionList(revisions []any) string {
	if len(revisions) == 0 {
		return "No revisions found"
	}
	rows := make([][]string, 0, len(revisions))
	for _, revision := range revisions {
		record := objectValue(revision)
		rows = append(rows, []string{
			stringValue(record["id"]),
			stringValue(record["title"]),
			stringValue(objectValue(record["author"])["login"]),
			stringValue(record["updated_at"]),
		})
		if rows[len(rows)-1][2] == "" {
			rows[len(rows)-1][2] = "unknown"
		}
	}
	return formatTable([]string{"ID", "Title", "Author", "Updated"}, rows)
}

func cleanAPIError(err error) error {
	if apiErr, ok := err.(*APIError); ok {
		return fmt.Errorf("%s", apiErr.Detail)
	}
	return err
}

func repoFullName(repo map[string]any) string {
	if fullName := stringValue(repo["full_name"]); fullName != "" {
		return fullName
	}
	owner := stringValue(repo["owner"])
	name := stringValue(repo["name"])
	if owner != "" && name != "" {
		return owner + "/" + name
	}
	return name
}

func repoVisibility(repo map[string]any) string {
	if value, ok := repo["is_public"].(bool); ok {
		if value {
			return "public"
		}
		return "private"
	}
	return ""
}

func formatRepoCreate(repo any) string {
	record := objectValue(repo)
	lines := []string{"Created repository " + repoFullName(record)}
	if cloneURL := stringValue(record["clone_url"]); cloneURL != "" {
		lines = append(lines, "Clone URL: "+cloneURL)
	}
	return strings.Join(lines, "\n")
}

func formatRepoCreateToon(repo any) string {
	record := objectValue(repo)
	lines := []string{}
	for _, key := range []string{"id", "owner", "name", "full_name", "description", "is_public", "default_branch", "default_bookmark"} {
		appendToonField(&lines, record, key, false)
	}
	appendToonField(&lines, record, "clone_url", true)
	appendToonField(&lines, record, "created_at", true)
	appendToonField(&lines, record, "updated_at", true)
	return strings.Join(lines, "\n")
}

func formatRepoList(repos []any) string {
	if len(repos) == 0 {
		return "No repositories found"
	}
	rows := make([][]string, 0, len(repos))
	for _, repo := range repos {
		record := objectValue(repo)
		rows = append(rows, []string{
			stringValue(record["name"]),
			repoVisibility(record),
			stringValue(firstNonEmptyAny(record["default_bookmark"], record["default_branch"])),
			stringValue(record["updated_at"]),
		})
	}
	return formatTable([]string{"Name", "Visibility", "Default", "Updated"}, rows)
}

func formatRepoView(repo any) string {
	record := objectValue(repo)
	visibility := repoVisibility(record)
	if visibility == "" {
		visibility = "unknown"
	}
	lines := []string{repoFullName(record), "Visibility: " + visibility}
	if description := stringValue(record["description"]); description != "" {
		lines = append(lines, "Description: "+description)
	}
	if defaultBookmark := stringValue(firstNonEmptyAny(record["default_bookmark"], record["default_branch"])); defaultBookmark != "" {
		lines = append(lines, "Default bookmark: "+defaultBookmark)
	}
	if cloneURL := stringValue(record["clone_url"]); cloneURL != "" {
		lines = append(lines, "Clone URL: "+cloneURL)
	}
	if stars := stringValue(record["num_stars"]); stars != "" {
		lines = append(lines, "Stars: "+stars)
	}
	return strings.Join(lines, "\n")
}

func formatRepoMutation(action, repoRef string) string {
	return action + " repository " + repoRef
}

func firstNonEmptyAny(values ...any) any {
	for _, value := range values {
		if stringValue(value) != "" {
			return value
		}
	}
	return nil
}

func landingAuthor(landing map[string]any) string {
	if author := objectValue(landing["author"]); author != nil {
		if login := stringValue(author["login"]); login != "" {
			return login
		}
	}
	return "unknown"
}

func formatLandingCreate(repoRef string, landing any) string {
	record := objectValue(landing)
	number := stringValue(record["number"])
	return strings.Join([]string{
		"Created landing request #" + number + ": " + stringValue(record["title"]),
		"URL: /" + repoRef + "/landings/" + number,
	}, "\n")
}

func formatLandingList(landings []any) string {
	if len(landings) == 0 {
		return "No landing requests found"
	}
	rows := make([][]string, 0, len(landings))
	for _, landing := range landings {
		record := objectValue(landing)
		rows = append(rows, []string{
			"#" + stringValue(record["number"]),
			stringValue(record["state"]),
			stringValue(record["title"]),
			joinAnyValues(arrayValue(record["change_ids"]), ", "),
		})
	}
	return formatTable([]string{"Number", "State", "Title", "change_ids"}, rows)
}

func formatLandingListToon(landings []any) string {
	lines := []string{fmt.Sprintf("[%d]:", len(landings))}
	for _, raw := range landings {
		landing := objectValue(raw)
		appendListToonField(&lines, landing, "number", false, true)
		appendListToonField(&lines, landing, "title", false, false)
		appendListToonField(&lines, landing, "body", false, false)
		appendListToonField(&lines, landing, "state", false, false)
		if author := objectValue(landing["author"]); author != nil {
			lines = append(lines, "    author:")
			appendDoubleNestedToonField(&lines, author, "id", false)
			appendDoubleNestedToonField(&lines, author, "login", false)
		}
		if changeIDs, ok := landing["change_ids"].([]any); ok {
			values := make([]string, 0, len(changeIDs))
			for _, value := range changeIDs {
				values = append(values, toonScalar(value, false))
			}
			lines = append(lines, fmt.Sprintf("    change_ids[%d]: %s", len(changeIDs), strings.Join(values, ",")))
		}
		appendListToonField(&lines, landing, "target_bookmark", false, false)
		appendListToonField(&lines, landing, "conflict_status", false, false)
		appendListToonField(&lines, landing, "stack_size", false, false)
		appendListToonField(&lines, landing, "created_at", true, false)
		appendListToonField(&lines, landing, "updated_at", true, false)
	}
	return strings.Join(lines, "\n")
}

func formatLandingView(details map[string]any) string {
	landing := objectValue(details["landing"])
	changes := arrayValue(details["changes"])
	reviews := arrayValue(details["reviews"])
	conflicts := objectValue(details["conflicts"])
	lines := []string{
		strings.TrimSpace("#" + stringValue(landing["number"]) + " " + stringValue(landing["title"])),
		"State: " + stringValue(landing["state"]),
		"Author: " + landingAuthor(landing),
		"Target: " + stringValue(landing["target_bookmark"]),
		"Change IDs: " + joinAnyValues(arrayValue(landing["change_ids"]), ", "),
	}
	if len(changes) > 0 {
		lines = append(lines, "", "Changes:")
		for _, change := range changes {
			lines = append(lines, "- "+stringValue(objectValue(change)["change_id"]))
		}
	}
	if len(reviews) > 0 {
		lines = append(lines, "", "Reviews:")
		for _, review := range reviews {
			record := objectValue(review)
			body := stringValue(record["body"])
			if body == "" {
				body = "(no body)"
			}
			lines = append(lines, "- "+stringValue(record["type"])+": "+body)
		}
	}
	if conflictStatus := stringValue(conflicts["conflict_status"]); conflictStatus != "" {
		lines = append(lines, "", "Conflicts: "+conflictStatus)
	}
	return strings.Join(lines, "\n")
}

func formatLandingChecks(statuses []any) string {
	if len(statuses) == 0 {
		return "No checks found"
	}
	rows := make([][]string, 0, len(statuses))
	for _, status := range statuses {
		record := objectValue(status)
		rows = append(rows, []string{
			stringValue(record["change_id"]),
			stringValue(record["context"]),
			stringValue(record["status"]),
			stringValue(record["description"]),
		})
	}
	return formatTable([]string{"Change ID", "Context", "Status", "Description"}, rows)
}

func formatLandingMutation(action string, landing any) string {
	record := objectValue(landing)
	return fmt.Sprintf("%s landing request #%s: %s", action, stringValue(record["number"]), stringValue(record["title"]))
}

func appendToonField(lines *[]string, record map[string]any, key string, quote bool) {
	value, ok := record[key]
	if !ok {
		return
	}
	*lines = append(*lines, fmt.Sprintf("%s: %s", key, toonScalar(value, quote)))
}

func appendNestedToonField(lines *[]string, record map[string]any, key string, quote bool) {
	value, ok := record[key]
	if !ok {
		return
	}
	*lines = append(*lines, fmt.Sprintf("  %s: %s", key, toonScalar(value, quote)))
}

func appendDoubleNestedToonField(lines *[]string, record map[string]any, key string, quote bool) {
	value, ok := record[key]
	if !ok {
		return
	}
	*lines = append(*lines, fmt.Sprintf("      %s: %s", key, toonScalar(value, quote)))
}

func appendListToonField(lines *[]string, record map[string]any, key string, quote bool, first bool) {
	value, ok := record[key]
	if !ok {
		return
	}
	prefix := "    "
	if first {
		prefix = "  - "
	}
	*lines = append(*lines, fmt.Sprintf("%s%s: %s", prefix, key, toonScalar(value, quote)))
}

func toonScalar(value any, quote bool) string {
	if value == nil {
		return "null"
	}
	text := stringValue(value)
	if quote {
		return fmt.Sprintf("%q", text)
	}
	return text
}
