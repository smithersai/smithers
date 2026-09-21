package smitherscli

import "strings"

var rootFlagsWithValues = map[string]struct{}{
	"--filter-output": {},
	"--format":        {},
	"--token-limit":   {},
	"--token-offset":  {},
}

var rootTerminalFlags = map[string]struct{}{
	"--help":      {},
	"--llms":      {},
	"--llms-full": {},
	"--mcp":       {},
	"--schema":    {},
	"--version":   {},
}

func findFirstCommandIndex(argv []string) *int {
	for i := 0; i < len(argv); i++ {
		token := argv[i]
		if token == "--" {
			return nil
		}
		if _, ok := rootFlagsWithValues[token]; ok {
			i++
			continue
		}
		if strings.HasPrefix(token, "--filter-output=") ||
			strings.HasPrefix(token, "--format=") ||
			strings.HasPrefix(token, "--token-limit=") ||
			strings.HasPrefix(token, "--token-offset=") {
			continue
		}
		if strings.HasPrefix(token, "-") {
			continue
		}
		idx := i
		return &idx
	}
	return nil
}

func shouldDefaultToAgent(argv []string) bool {
	if len(argv) == 0 {
		return true
	}
	for _, token := range argv {
		if _, ok := rootTerminalFlags[token]; ok {
			return false
		}
	}
	return findFirstCommandIndex(argv) == nil
}

func rewriteAgentArgv(argv []string) []string {
	agentIndex := -1
	for i, token := range argv {
		if token == "agent" {
			agentIndex = i
			break
		}
	}
	if agentIndex == -1 {
		return argv
	}

	reserved := map[string]struct{}{
		"ask": {}, "session": {}, "list": {}, "view": {}, "run": {}, "chat": {},
	}
	flagsWithValues := map[string]struct{}{
		"--filter-output": {}, "--format": {}, "--repo": {}, "--token-limit": {}, "--token-offset": {}, "-R": {},
	}
	firstNonOption := ""
	for i := agentIndex + 1; i < len(argv); i++ {
		token := argv[i]
		if token == "--" {
			break
		}
		if _, ok := flagsWithValues[token]; ok {
			i++
			continue
		}
		if strings.HasPrefix(token, "--filter-output=") ||
			strings.HasPrefix(token, "--format=") ||
			strings.HasPrefix(token, "--repo=") ||
			strings.HasPrefix(token, "--token-limit=") ||
			strings.HasPrefix(token, "--token-offset=") ||
			token == "--sandbox" {
			continue
		}
		if !strings.HasPrefix(token, "-") {
			firstNonOption = token
			break
		}
	}
	if firstNonOption != "" {
		if _, ok := reserved[firstNonOption]; ok {
			return argv
		}
	}

	rewritten := make([]string, 0, len(argv)+1)
	rewritten = append(rewritten, argv[:agentIndex+1]...)
	rewritten = append(rewritten, "ask")
	rewritten = append(rewritten, argv[agentIndex+1:]...)
	return rewritten
}

func rewriteKnownAliases(argv []string) []string {
	rewritten := make([]string, len(argv))
	for i, token := range argv {
		switch {
		case token == "-R":
			rewritten[i] = "--repo"
		case token == "--change-id":
			rewritten[i] = "--change"
		case strings.HasPrefix(token, "--change-id="):
			rewritten[i] = "--change=" + strings.TrimPrefix(token, "--change-id=")
		default:
			rewritten[i] = token
		}
	}
	return rewritten
}

func rewriteExplicitToonFlag(argv []string) []string {
	rewritten := make([]string, 0, len(argv)+1)
	for _, token := range argv {
		if token == "--toon" {
			rewritten = append(rewritten, "--format", "toon")
			continue
		}
		rewritten = append(rewritten, token)
	}
	return rewritten
}

func isJSONFieldSelectionToken(token string) bool {
	return strings.Contains(token, ",") || strings.Contains(token, ".") || strings.Contains(token, "[")
}

func isTerminalJSONFieldSelectionToken(token string) bool {
	if token == "" {
		return false
	}
	for i, r := range token {
		if i == 0 {
			if r != '_' && (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') {
				return false
			}
			continue
		}
		if r != '_' && (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func isLikelyPositionalArgumentToken(token string) bool {
	if token == "" {
		return false
	}
	allDigits := true
	for _, r := range token {
		if r < '0' || r > '9' {
			allDigits = false
			break
		}
	}
	return allDigits || strings.Contains(token, "/") || strings.Contains(token, ":")
}

func rewriteJSONFieldSelection(argv []string) []string {
	rewritten := make([]string, 0, len(argv))
	for i := 0; i < len(argv); i++ {
		token := argv[i]
		rewritten = append(rewritten, token)
		if token != "--json" {
			continue
		}
		if i+1 >= len(argv) {
			continue
		}
		next := argv[i+1]
		following := ""
		if i+2 < len(argv) {
			following = argv[i+2]
		}
		if next == "" || strings.HasPrefix(next, "-") {
			continue
		}
		if isJSONFieldSelectionToken(next) ||
			(isTerminalJSONFieldSelectionToken(next) &&
				(following == "" || strings.HasPrefix(following, "-") || isLikelyPositionalArgumentToken(following))) {
			rewritten = append(rewritten, "--filter-output", next)
			i++
		}
	}
	return rewritten
}

func rewriteRepoCloneArgv(argv []string) []string {
	firstCommandIndex := findFirstCommandIndex(argv)
	if firstCommandIndex == nil || *firstCommandIndex+1 >= len(argv) ||
		argv[*firstCommandIndex] != "repo" || argv[*firstCommandIndex+1] != "clone" {
		return argv
	}

	before := append([]string{}, argv[:*firstCommandIndex+2]...)
	after := argv[*firstCommandIndex+2:]
	separator := -1
	for i, token := range after {
		if token == "--" {
			separator = i
			break
		}
	}
	core := after
	passthrough := []string{}
	if separator != -1 {
		core = after[:separator]
		passthrough = after[separator+1:]
	}

	flagsWithValues := map[string]struct{}{"--clone-arg": {}, "--directory": {}, "--protocol": {}}
	rewritten := make([]string, 0, len(after)+len(passthrough))
	repoSeen := false
	directorySeen := false
	for i := 0; i < len(core); i++ {
		token := core[i]
		if _, ok := flagsWithValues[token]; ok ||
			strings.HasPrefix(token, "--clone-arg=") ||
			strings.HasPrefix(token, "--directory=") ||
			strings.HasPrefix(token, "--protocol=") {
			rewritten = append(rewritten, token)
			if _, ok := flagsWithValues[token]; ok && i+1 < len(core) {
				rewritten = append(rewritten, core[i+1])
				i++
			}
			continue
		}
		if strings.HasPrefix(token, "-") {
			rewritten = append(rewritten, token)
			continue
		}
		if !repoSeen {
			repoSeen = true
			rewritten = append(rewritten, token)
			continue
		}
		if !directorySeen {
			directorySeen = true
			rewritten = append(rewritten, "--directory", token)
			continue
		}
		rewritten = append(rewritten, token)
	}
	for _, token := range passthrough {
		rewritten = append(rewritten, "--clone-arg", token)
	}
	return append(before, rewritten...)
}

func rewriteCLIArgv(argv []string) []string {
	withAliases := rewriteKnownAliases(argv)
	withToon := rewriteExplicitToonFlag(withAliases)
	withJSONFieldSelection := rewriteJSONFieldSelection(withToon)
	withRepoCloneRewrite := rewriteRepoCloneArgv(withJSONFieldSelection)
	if shouldDefaultToAgent(withRepoCloneRewrite) {
		withRepoCloneRewrite = append(withRepoCloneRewrite, "agent", "ask")
	}
	return rewriteAgentArgv(withRepoCloneRewrite)
}
