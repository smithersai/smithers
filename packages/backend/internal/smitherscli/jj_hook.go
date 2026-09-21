package smitherscli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const jjPostOperationHook = "smithers _internal push-to-smithers"

type sectionRange struct {
	start int
	end   int
}

type assignmentRange struct {
	start  int
	end    int
	values []string
}

func splitConfigLines(text string) []string {
	return regexp.MustCompile(`\r?\n`).Split(text, -1)
}

func stripInlineComment(line string) string {
	escaped := false
	inDouble := false
	inSingle := false
	for index, char := range line {
		if char == '\\' && inDouble && !escaped {
			escaped = true
			continue
		}
		if !escaped && !inSingle && char == '"' {
			inDouble = !inDouble
		} else if !escaped && !inDouble && char == '\'' {
			inSingle = !inSingle
		} else if !escaped && !inDouble && !inSingle && char == '#' {
			return line[:index]
		}
		escaped = false
	}
	return line
}

func parseTomlStringArray(value string) []string {
	values := []string{}
	matcher := regexp.MustCompile(`"((?:[^"\\]|\\.)*)"|'([^']*)'`)
	for _, match := range matcher.FindAllStringSubmatch(value, -1) {
		if len(match) > 1 && match[1] != "" {
			var decoded string
			if err := json.Unmarshal([]byte(`"`+match[1]+`"`), &decoded); err == nil {
				values = append(values, decoded)
			}
			continue
		}
		if len(match) > 2 {
			values = append(values, match[2])
		}
	}
	return values
}

func renderTomlStringArray(values []string) string {
	deduped := []string{}
	seen := map[string]struct{}{}
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		deduped = append(deduped, value)
	}
	encoded := make([]string, len(deduped))
	for i, value := range deduped {
		raw, _ := json.Marshal(value)
		encoded[i] = string(raw)
	}
	return "[" + strings.Join(encoded, ", ") + "]"
}

func findHooksSection(lines []string) *sectionRange {
	for index, line := range lines {
		if strings.TrimSpace(line) != "[hooks]" {
			continue
		}
		end := len(lines)
		for cursor := index + 1; cursor < len(lines); cursor++ {
			candidate := strings.TrimSpace(lines[cursor])
			if regexp.MustCompile(`^\[[^\]]+\]$`).MatchString(candidate) {
				end = cursor
				break
			}
		}
		return &sectionRange{start: index, end: end}
	}
	return nil
}

func findPostOperationAssignment(lines []string, section *sectionRange) *assignmentRange {
	for index := section.start + 1; index < section.end; index++ {
		withoutComment := stripInlineComment(lines[index])
		trimmed := strings.TrimSpace(withoutComment)
		if !strings.HasPrefix(trimmed, "post-operation") {
			continue
		}
		equalIndex := strings.Index(withoutComment, "=")
		if equalIndex == -1 {
			continue
		}
		combined := withoutComment[equalIndex+1:]
		depth := bracketDepth(combined)
		end := index + 1
		for depth > 0 && end < section.end {
			nextLine := stripInlineComment(lines[end])
			combined += "\n" + nextLine
			depth += bracketDepth(nextLine)
			end++
		}
		return &assignmentRange{start: index, end: end, values: parseTomlStringArray(combined)}
	}
	return nil
}

func bracketDepth(text string) int {
	depth := 0
	for _, char := range text {
		if char == '[' {
			depth++
		} else if char == ']' {
			depth--
		}
	}
	return depth
}

func resolveRepoConfigPath(cwd string) string {
	cmd := exec.Command("jj", "config", "path", "--repo")
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	resolved := strings.TrimSpace(string(out))
	if resolved == "" {
		return ""
	}
	if filepath.IsAbs(resolved) {
		return resolved
	}
	return filepath.Join(cwd, resolved)
}

func targetJJConfigPaths(cwd string) []string {
	seen := map[string]struct{}{}
	paths := []string{}
	for _, path := range []string{filepath.Join(cwd, ".jj", "config.toml"), resolveRepoConfigPath(cwd)} {
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	return paths
}

func readJJConfig(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

func writeJJConfig(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return os.WriteFile(path, []byte(text), 0o644)
}

func installPushHook(cwd string) error {
	for _, path := range targetJJConfigPaths(cwd) {
		if err := installPushHookAtPath(path); err != nil {
			return err
		}
	}
	return nil
}

func removePushHook(cwd string) error {
	for _, path := range targetJJConfigPaths(cwd) {
		if err := removePushHookAtPath(path); err != nil {
			return err
		}
	}
	return nil
}

func installPushHookAtPath(path string) error {
	original := readJJConfig(path)
	lines := splitConfigLines(original)
	section := findHooksSection(lines)
	if section == nil {
		nextLines := []string{}
		for index, line := range lines {
			if index == len(lines)-1 && line == "" {
				continue
			}
			nextLines = append(nextLines, line)
		}
		if len(nextLines) > 0 {
			nextLines = append(nextLines, "")
		}
		nextLines = append(nextLines, "[hooks]", "post-operation = "+renderTomlStringArray([]string{jjPostOperationHook}))
		updated := strings.Join(nextLines, "\n")
		// A freshly added [hooks] section always differs from the original.
		return writeJJConfig(path, updated)
	}
	assignment := findPostOperationAssignment(lines, section)
	if assignment == nil {
		lines = append(lines[:section.end], append([]string{"post-operation = " + renderTomlStringArray([]string{jjPostOperationHook})}, lines[section.end:]...)...)
		updated := strings.Join(lines, "\n")
		// Inserting the post-operation line always changes the content.
		return writeJJConfig(path, updated)
	}
	nextValues := append([]string{}, assignment.values...)
	hasHook := false
	for _, value := range nextValues {
		if value == jjPostOperationHook {
			hasHook = true
			break
		}
	}
	if !hasHook {
		nextValues = append(nextValues, jjPostOperationHook)
	}
	replacement := "post-operation = " + renderTomlStringArray(nextValues)
	lines = append(lines[:assignment.start], append([]string{replacement}, lines[assignment.end:]...)...)
	updated := strings.Join(lines, "\n")
	if updated != original {
		return writeJJConfig(path, updated)
	}
	return nil
}

func removePushHookAtPath(path string) error {
	original := readJJConfig(path)
	if original == "" {
		return nil
	}
	lines := splitConfigLines(original)
	section := findHooksSection(lines)
	if section == nil {
		return nil
	}
	assignment := findPostOperationAssignment(lines, section)
	if assignment == nil {
		return nil
	}
	nextValues := []string{}
	for _, value := range assignment.values {
		if value != jjPostOperationHook {
			nextValues = append(nextValues, value)
		}
	}
	if len(nextValues) == len(assignment.values) {
		return nil
	}
	if len(nextValues) == 0 {
		lines = append(lines[:assignment.start], lines[assignment.end:]...)
	} else {
		replacement := "post-operation = " + renderTomlStringArray(nextValues)
		lines = append(lines[:assignment.start], append([]string{replacement}, lines[assignment.end:]...)...)
	}
	updated := strings.Join(lines, "\n")
	// Removing our hook (the only way to reach here) always changes the content.
	return writeJJConfig(path, updated)
}
