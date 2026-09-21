package smitherscli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type LocalBookmark struct {
	Name           string  `json:"name"`
	TargetChangeID *string `json:"target_change_id"`
	TargetCommitID *string `json:"target_commit_id,omitempty"`
}

type LocalChangeSummary struct {
	ChangeID    string `json:"change_id"`
	Description string `json:"description"`
}

type LocalStackChange struct {
	ChangeID    string `json:"change_id"`
	CommitID    string `json:"commit_id"`
	Description string `json:"description"`
}

type LocalRevisionSummary struct {
	ChangeID    string `json:"change_id"`
	CommitID    string `json:"commit_id"`
	Description string `json:"description"`
}

type StatusFileSummary struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type LocalStatusSummary struct {
	Files       []StatusFileSummary  `json:"files"`
	Parent      LocalRevisionSummary `json:"parent"`
	WorkingCopy LocalRevisionSummary `json:"working_copy"`
}

type LocalReadOptions struct {
	IgnoreWorkingCopy bool
}

func runJj(args []string) (string, error) {
	return runJjWithEnv(args, nil)
}

func runJjWithEnv(args []string, env []string) (string, error) {
	if err := RequireJj(); err != nil {
		return "", err
	}
	cmd := exec.Command("jj", args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr := strings.TrimSpace(string(exitErr.Stderr))
			if stderr != "" {
				return "", fmt.Errorf("%s", stderr)
			}
		}
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

func escapeJjStringLiteral(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`)
}

func escapeTomlString(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`)
}

func applyLocalReadOptions(args []string, options LocalReadOptions) []string {
	if options.IgnoreWorkingCopy {
		out := append([]string{"--ignore-working-copy"}, args...)
		return out
	}
	return args
}

func parseBookmarkLine(line string) LocalBookmark {
	separator := strings.Index(line, ":")
	if separator == -1 {
		return LocalBookmark{Name: strings.TrimSpace(line)}
	}
	name := strings.TrimSpace(line[:separator])
	rest := strings.TrimSpace(line[separator+1:])
	if rest == "" {
		return LocalBookmark{Name: name}
	}
	tokens := strings.Fields(rest)
	var targetChangeID, targetCommitID *string
	if len(tokens) > 0 {
		value := tokens[0]
		targetChangeID = &value
	}
	if len(tokens) > 1 {
		value := tokens[1]
		targetCommitID = &value
	}
	return LocalBookmark{Name: name, TargetChangeID: targetChangeID, TargetCommitID: targetCommitID}
}

func ListLocalBookmarks(names []string, options LocalReadOptions) ([]LocalBookmark, error) {
	args := append([]string{"bookmark", "list"}, names...)
	output, err := runJj(applyLocalReadOptions(args, options))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(output) == "" || strings.Contains(strings.ToLower(output), "no bookmarks") {
		return []LocalBookmark{}, nil
	}
	lines := strings.Split(output, "\n")
	bookmarks := []LocalBookmark{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		bookmarks = append(bookmarks, parseBookmarkLine(trimmed))
	}
	return bookmarks, nil
}

func CreateLocalBookmark(name, changeID string) (LocalBookmark, error) {
	args := []string{"bookmark", "create", name}
	if changeID != "" {
		args = append(args, "-r", changeID)
	}
	if _, err := runJj(args); err != nil {
		return LocalBookmark{}, err
	}
	bookmarks, err := ListLocalBookmarks([]string{name}, LocalReadOptions{})
	if err != nil {
		return LocalBookmark{}, err
	}
	if len(bookmarks) > 0 {
		return bookmarks[0], nil
	}
	var target *string
	if changeID != "" {
		target = &changeID
	}
	return LocalBookmark{Name: name, TargetChangeID: target}, nil
}

func DeleteLocalBookmark(name string) error {
	_, err := runJj([]string{"bookmark", "delete", name})
	return err
}

func HasLocalBookmark(name string) (bool, error) {
	bookmarks, err := ListLocalBookmarks([]string{name}, LocalReadOptions{})
	if err != nil {
		return false, err
	}
	for _, bookmark := range bookmarks {
		if bookmark.Name == name {
			return true, nil
		}
	}
	return false, nil
}

func ListLocalChanges(limit int) ([]LocalChangeSummary, error) {
	if limit == 0 {
		limit = 10
	}
	output, err := runJj([]string{"log", "-n", strconv.Itoa(limit), "--no-graph", "-T", `change_id ++ "\t" ++ description.first_line() ++ "\n"`})
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(output) == "" {
		return []LocalChangeSummary{}, nil
	}
	changes := []LocalChangeSummary{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		changeID := ""
		if len(parts) > 0 {
			changeID = parts[0]
		}
		description := ""
		if len(parts) > 1 {
			description = strings.Join(parts[1:], "\t")
		}
		changes = append(changes, LocalChangeSummary{ChangeID: changeID, Description: description})
	}
	return changes, nil
}

func parseRevisionLine(line string) LocalRevisionSummary {
	parts := strings.Split(line, "\t")
	summary := LocalRevisionSummary{}
	if len(parts) > 0 {
		summary.ChangeID = parts[0]
	}
	if len(parts) > 1 {
		summary.CommitID = parts[1]
	}
	if len(parts) > 2 {
		summary.Description = strings.Join(parts[2:], "\t")
	}
	return summary
}

func GetLocalRevision(revset string, options LocalReadOptions) (LocalRevisionSummary, error) {
	output, err := runJj(applyLocalReadOptions([]string{
		"log", "-r", revset, "--no-graph", "-T",
		`change_id ++ "\t" ++ commit_id ++ "\t" ++ description.first_line() ++ "\n"`,
	}, options))
	if err != nil {
		return LocalRevisionSummary{}, err
	}
	for _, line := range strings.Split(output, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return parseRevisionLine(trimmed), nil
		}
	}
	return LocalRevisionSummary{}, fmt.Errorf("Unable to resolve revision %s", revset)
}

func CurrentLocalChangeID() (string, error) {
	revision, err := GetLocalRevision("@", LocalReadOptions{})
	if err != nil {
		return "", err
	}
	return revision.ChangeID, nil
}

func ListLocalStackChangeIDs(targetBookmark string) ([]string, error) {
	targetRevset := `present(bookmarks(exact:"` + escapeJjStringLiteral(targetBookmark) + `"))`
	revset := `(::@ ~ ::` + targetRevset + `) ~ empty()`
	output, err := runJj([]string{"--ignore-working-copy", "log", "-r", revset, "--no-graph", "-T", `change_id ++ "\n"`})
	if err != nil {
		return nil, err
	}
	return nonEmptyLines(output), nil
}

func ListLocalStackChanges(targetBookmark string) ([]LocalStackChange, error) {
	targetRevset := `present(bookmarks(exact:"` + escapeJjStringLiteral(targetBookmark) + `"))`
	revset := `(::@ ~ ::` + targetRevset + `) ~ empty()`
	output, err := runJj([]string{"--ignore-working-copy", "log", "-r", revset, "--no-graph", "-T", `change_id ++ "\t" ++ commit_id ++ "\n"`})
	if err != nil {
		return nil, err
	}
	changes := []LocalStackChange{}
	for _, line := range nonEmptyLines(output) {
		parts := strings.Split(line, "\t")
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		description, err := runJj([]string{"--ignore-working-copy", "log", "-r", parts[0], "--no-graph", "-T", `description ++ "\n"`})
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(description) == "" {
			continue
		}
		changes = append(changes, LocalStackChange{ChangeID: parts[0], CommitID: parts[1], Description: strings.TrimRight(description, "\n")})
	}
	return changes, nil
}

func SetLocalBookmark(name, changeID string) error {
	_, err := runJj([]string{"--ignore-working-copy", "bookmark", "set", "-B", name, "-r", changeID})
	return err
}

func PushLocalBookmark(name string) error {
	args := []string{"--ignore-working-copy", "git", "push", "--bookmark", name}
	if strings.TrimSpace(os.Getenv("GITHUB_TOKEN")) != "" {
		_, err := runJj(args)
		return err
	}
	token, err := RequireAuthToken(nil)
	if err != nil {
		return err
	}
	// Scope the header to the Smithers https origin (the host BuildCloneURL
	// uses). An unscoped http.extraHeader would send the PAT to whatever
	// remote jj pushes to, including github.com or a mistyped host.
	_, err = runJjWithEnv(args, []string{
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.https://" + token.Host + "/.extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Bearer " + strings.TrimSpace(token.Token),
	})
	return err
}

func FetchGitRemote() error {
	_, err := runJj([]string{"--ignore-working-copy", "git", "fetch"})
	return err
}

func RebaseLocalChange(changeID, destination string) error {
	authorLine, err := runJj([]string{"--ignore-working-copy", "log", "-r", changeID, "--no-graph", "-T", `author.name() ++ "\t" ++ author.email() ++ "\n"`})
	if err != nil {
		return err
	}
	parts := strings.Split(strings.TrimSpace(authorLine), "\t")
	args := []string{"--ignore-working-copy"}
	if len(parts) > 0 && strings.TrimSpace(parts[0]) != "" {
		args = append(args, "--config", `user.name="`+escapeTomlString(strings.TrimSpace(parts[0]))+`"`)
	}
	if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
		args = append(args, "--config", `user.email="`+escapeTomlString(strings.TrimSpace(parts[1]))+`"`)
	}
	args = append(args, "rebase", "--revisions", changeID, "--onto", destination)
	_, err = runJj(args)
	return err
}

func GetLocalChange(changeID string) (string, error) {
	return runJj([]string{"log", "-r", changeID, "--no-graph"})
}

func GetLocalChangeDetails(changeID string) (LocalRevisionSummary, error) {
	return GetLocalRevision(changeID, LocalReadOptions{})
}

func GetLocalDiff(changeID string) (string, error) {
	return runJj([]string{"diff", "-r", changeID})
}

func ListLocalChangeFiles(changeID string) ([]string, error) {
	entries, err := listDiffSummaryEntriesForRevision(changeID)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		files = append(files, entry.Path)
	}
	return files, nil
}

func ListLocalChangeConflicts(changeID string) ([]string, error) {
	entries, err := listDiffSummaryEntriesForRevision(changeID)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		if strings.Contains(strings.ToUpper(entry.Status), "C") {
			files = append(files, entry.Path)
		}
	}
	return files, nil
}

func listDiffSummaryEntriesForRevision(changeID string) ([]StatusFileSummary, error) {
	output, err := runJj([]string{"diff", "--summary", "-r", changeID})
	if err != nil {
		return nil, err
	}
	return listDiffSummaryEntries(output), nil
}

func GetLocalStatus(options LocalReadOptions) (LocalStatusSummary, error) {
	workingCopy, err := GetLocalRevision("@", options)
	if err != nil {
		return LocalStatusSummary{}, err
	}
	parent, err := GetLocalRevision("@-", options)
	if err != nil {
		return LocalStatusSummary{}, err
	}
	output, err := runJj(applyLocalReadOptions([]string{"diff", "--summary"}, options))
	if err != nil {
		return LocalStatusSummary{}, err
	}
	return LocalStatusSummary{
		WorkingCopy: workingCopy,
		Parent:      parent,
		Files:       listDiffSummaryEntries(output),
	}, nil
}

var diffSummaryLinePattern = regexp.MustCompile(`^([A-Z!?~]+)\s+(.*)$`)

func parseDiffSummaryLine(line string) *StatusFileSummary {
	matches := diffSummaryLinePattern.FindStringSubmatch(line)
	if len(matches) != 3 {
		return nil
	}
	return &StatusFileSummary{Status: matches[1], Path: strings.TrimSpace(matches[2])}
}

func listDiffSummaryEntries(output string) []StatusFileSummary {
	entries := []StatusFileSummary{}
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if entry := parseDiffSummaryLine(trimmed); entry != nil {
			entries = append(entries, *entry)
		}
	}
	return entries
}

func nonEmptyLines(output string) []string {
	if strings.TrimSpace(output) == "" {
		return []string{}
	}
	lines := []string{}
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}
