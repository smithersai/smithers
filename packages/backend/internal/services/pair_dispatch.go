package services

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// PairResult is the parsed result of one shared-model run: the short reply
// shown in chat, the full tool output, the new shared.md doc (if the model
// rewrote it), and the list of repo files the model changed.
type PairResult struct {
	Reply               string
	Output              string
	NewDoc              string
	ChangedFiles        []string
	ChangedFileContents map[string]string
	ExitCode            int
}

type pairAgentSnapshot struct {
	Doc   string
	Files map[string]string
}

// PairDispatcher runs the shared coding agent for one prompt and returns the
// parsed result. Two implementations differ only in WHERE the command runs and
// whether it uses the VM's /root environment (sandbox provider) or the host's
// inherited environment (local subscription CLIs).
type PairDispatcher interface {
	Run(ctx context.Context, prompt string, snapshot pairAgentSnapshot) (PairResult, error)
}

// execDispatcher runs the agent via a PairSandbox (Execute). For the
// sandbox provider path the sandbox is the sandbox provider client and vmID is the VM id;
// for the local path the sandbox is localExec and vmID is "".
type execDispatcher struct {
	sandbox  PairSandbox
	vmID     string
	workdir  string
	local    bool
	provider string
}

// pairAgentTimeoutMS is the per-run command timeout (preserved from runCodex).
const pairAgentTimeoutMS = int64(240_000)

func (d execDispatcher) Run(ctx context.Context, prompt string, snapshot pairAgentSnapshot) (PairResult, error) {
	// Behavior-preserved guard from the original runCodex: the sandbox provider path
	// requires both a sandbox and a vmID. The local path supplies a sandbox
	// (localExec) and an empty vmID, so it only requires the sandbox.
	if d.sandbox == nil {
		return PairResult{}, errors.New("shared model not configured")
	}
	if !d.local && d.vmID == "" {
		return PairResult{}, errors.New("shared model not configured")
	}

	cmd := buildPairAgentCommand(d.provider, d.workdir, prompt, snapshot, d.local)

	timeout := pairAgentTimeoutMS
	res, err := d.sandbox.Execute(ctx, d.vmID, sandbox.ExecRequest{Command: cmd, TimeoutMS: &timeout})
	if err != nil {
		return PairResult{}, err
	}
	result := parsePairAgentOutput(res.Stdout, res.Stderr)
	if res.StatusCode != nil {
		result.ExitCode = int(*res.StatusCode)
	}
	if result.ExitCode != 0 {
		return result, fmt.Errorf("shared model exited with status %d", result.ExitCode)
	}
	return result, nil
}

// pairShellQuote single-quotes a string for safe embedding in a /bin/sh
// command (preserved verbatim from runCodex's local `q` helper).
func pairShellQuote(in string) string {
	return "'" + strings.ReplaceAll(in, "'", "'\\''") + "'"
}

// buildPairAgentCommand builds the shell command that runs the shared coding
// agent for `provider`, edits the repo at `workdir`, and emits the
// ===REPLY===/===OUTPUT===/===FILES===/===FILE_CONTENTS===/===STATUS===/===DOC===
// protocol that parsePairAgentOutput consumes.
//
// The `local` flag is the ONLY place the sandbox provider/VM path and the local path
// differ: the sandbox provider path prepends `export HOME=/root PATH=…;` (the VM's
// root environment) while the local path runs in the host's inherited
// environment with no such prefix.
func buildPairAgentCommand(provider, workdir, prompt string, snapshot pairAgentSnapshot, local bool) string {
	instruction := "Two developers are pair-programming in this repository. " +
		"Apply their request by editing the real repo files directly. " +
		"End with ONE short sentence describing the change.\n\nRequest: " + prompt

	captureBefore := "pair_before=$(mktemp /tmp/pair-before.XXXXXX); pair_after=$(mktemp /tmp/pair-after.XXXXXX); pair_changed=$(mktemp /tmp/pair-changed.XXXXXX); " +
		"trap 'rm -f \"$pair_before\" \"$pair_after\" \"$pair_changed\"' EXIT; " +
		pairAgentHashManifestCommand("$pair_before")
	captureAfter := pairAgentHashManifestCommand("$pair_after") +
		"awk -F '\\t' 'NR==FNR { before[$1]=$2; next } !($1 in before) || before[$1] != $2 { print $1 }' \"$pair_before\" \"$pair_after\" > \"$pair_changed\"; "

	// The trailer captures the agent's stdout/stderr, then emits the protocol
	// markers used by parsePairAgentOutput. The before/after manifests ensure
	// files materialized only as room-state context are not re-attributed as
	// agent edits unless the agent actually changed them.
	trailer := " > /tmp/cx.out 2>/tmp/cx.err; cx_status=$?; " + captureAfter +
		"echo '===REPLY==='; tail -2 /tmp/cx.out | tr -cd '[:print:]\\n'; echo; " +
		"echo '===OUTPUT==='; tail -c 9000 /tmp/cx.out | tr -cd '[:print:]\\n'; echo; echo '===FILES==='; cat \"$pair_changed\"; " +
		"echo '===FILE_CONTENTS==='; while IFS= read -r f; do [ -f \"$f\" ] || continue; size=$(wc -c < \"$f\" 2>/dev/null | tr -d ' '); [ -n \"$size\" ] && [ \"$size\" -le 524288 ] || continue; printf '%s\\t' \"$f\"; base64 -w0 \"$f\"; printf '\\n'; done < \"$pair_changed\"; " +
		"echo '===STATUS==='; printf '%s\\n' \"$cx_status\"; echo '===DOC==='; test -f shared.md && base64 -w0 shared.md || true; exit \"$cx_status\""

	agent := pairAgentInvocation(provider, workdir, instruction)

	prefix := ""
	if !local {
		// sandbox provider/VM path ONLY: the VM runs as root and the agent CLIs live
		// under /root. The local path inherits the host's HOME/PATH instead.
		prefix = "export HOME=/root PATH=/usr/local/bin:/root/.bun/bin:/usr/bin:/bin; "
	}

	return prefix + "cd " + pairShellQuote(workdir) + "; " + buildPairSnapshotMaterializer(snapshot) + captureBefore + agent + trailer
}

func pairAgentHashManifestCommand(outFile string) string {
	return "git ls-files -m -d -o --exclude-standard | while IFS= read -r f; do " +
		"if [ -f \"$f\" ]; then hash=$(sha256sum \"$f\" 2>/dev/null | awk '{print $1}'); [ -n \"$hash\" ] || continue; else hash='__deleted__'; fi; " +
		"printf '%s\\t%s\\n' \"$f\" \"$hash\"; done > " + outFile + "; "
}

func buildPairSnapshotMaterializer(snapshot pairAgentSnapshot) string {
	var b strings.Builder
	writeFile := func(rel, content string) {
		rel, ok := cleanPairMaterializedPath(rel)
		if !ok || len(content) > pairMaxFileBytes {
			return
		}
		if dir := filepath.ToSlash(filepath.Dir(rel)); dir != "." {
			b.WriteString("mkdir -p ")
			b.WriteString(pairShellQuote(dir))
			b.WriteString("; ")
		}
		b.WriteString("printf '%s' ")
		b.WriteString(pairShellQuote(base64.StdEncoding.EncodeToString([]byte(content))))
		b.WriteString(" | base64 -d > ")
		b.WriteString(pairShellQuote(rel))
		b.WriteString("; ")
	}

	writeFile("shared.md", snapshot.Doc)
	paths := make([]string, 0, len(snapshot.Files))
	for rel := range snapshot.Files {
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	for _, rel := range paths {
		writeFile(rel, snapshot.Files[rel])
	}
	return b.String()
}

func cleanPairMaterializedPath(rel string) (string, bool) {
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\x00") || shouldSkipPairPath(rel) {
		return "", false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel)))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

// pairAgentInvocation returns the provider-specific CLI invocation (everything
// before the protocol trailer). Pair room prompts are untrusted, so the live path
// only permits Codex in workspace-write mode; unsupported providers are
// normalized before this helper and defensively fall back to Codex here.
func pairAgentInvocation(provider, workdir, instruction string) string {
	q := pairShellQuote
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "", "codex":
		// The room key is shareable, so prompts are untrusted. Keep Codex in a
		// workspace-write sandbox instead of bypassing approvals and sandboxing.
		return "codex exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check -C " + q(workdir) + " " + q(instruction)
	default:
		return "codex exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check -C " + q(workdir) + " " + q(instruction)
	}
}

// parsePairAgentOutput parses the
// ===REPLY===/===OUTPUT===/===FILES===/===FILE_CONTENTS===/===STATUS===/===DOC=== protocol
// emitted by buildPairAgentCommand.
func parsePairAgentOutput(stdout, stderr string) PairResult {
	var (
		reply               string
		output              string
		newDoc              string
		changedFiles        []string
		changedFileContents = map[string]string{}
		exitCode            int
	)
	out := stdout
	parts := strings.SplitN(out, "===DOC===", 2)
	if len(parts) == 2 {
		if decoded, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(parts[1])); derr == nil {
			newDoc = string(decoded)
		}
	}
	head := parts[0]
	if i, j := strings.Index(head, "===OUTPUT==="), len("===OUTPUT==="); i >= 0 {
		output = strings.TrimSpace(head[i+j:])
		head = head[:i]
	}
	if i := strings.Index(output, "===FILES==="); i >= 0 {
		filesBlock := strings.TrimSpace(output[i+len("===FILES==="):])
		if j := strings.Index(filesBlock, "===FILE_CONTENTS==="); j >= 0 {
			contentsBlock := strings.TrimSpace(filesBlock[j+len("===FILE_CONTENTS==="):])
			filesBlock = strings.TrimSpace(filesBlock[:j])
			if k := strings.Index(contentsBlock, "===STATUS==="); k >= 0 {
				statusBlock := strings.TrimSpace(contentsBlock[k+len("===STATUS==="):])
				contentsBlock = strings.TrimSpace(contentsBlock[:k])
				exitCode = parsePairExitCode(statusBlock)
			}
			changedFileContents = parsePairChangedFileContents(contentsBlock)
		} else if j := strings.Index(filesBlock, "===STATUS==="); j >= 0 {
			statusBlock := strings.TrimSpace(filesBlock[j+len("===STATUS==="):])
			filesBlock = strings.TrimSpace(filesBlock[:j])
			exitCode = parsePairExitCode(statusBlock)
		}
		for _, rel := range strings.Split(filesBlock, "\n") {
			rel, ok := cleanPairMaterializedPath(rel)
			if ok {
				changedFiles = append(changedFiles, rel)
			}
		}
		output = strings.TrimSpace(output[:i])
	}
	if idx := strings.Index(head, "===REPLY==="); idx >= 0 {
		reply = strings.TrimSpace(head[idx+len("===REPLY==="):])
	}
	if reply == "" {
		reply = "Updated the repo."
	}
	if output == "" {
		output = stderr
	}
	return PairResult{
		Reply:               truncate(redactSecrets(reply), 400),
		Output:              redactSecrets(output),
		NewDoc:              newDoc,
		ChangedFiles:        changedFiles,
		ChangedFileContents: changedFileContents,
		ExitCode:            exitCode,
	}
}

func parsePairExitCode(block string) int {
	line, _, _ := strings.Cut(strings.TrimSpace(block), "\n")
	var code int
	if _, err := fmt.Sscanf(line, "%d", &code); err != nil {
		return 0
	}
	return code
}

func parsePairChangedFileContents(block string) map[string]string {
	contents := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		rel, encoded, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		rel, ok = cleanPairMaterializedPath(rel)
		if !ok {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if err != nil || len(decoded) > pairMaxFileBytes {
			continue
		}
		contents[rel] = string(decoded)
	}
	return contents
}

// pairSecretRes match common credential shapes an agent CLI might echo to
// stdout/stderr (a verbose auth error, --debug, a tool printing env). The agent
// output is streamed into the SHARED Pair transcript, so scrub it first.
var pairSecretRes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)sk-[A-Za-z0-9_-]{12,}`),                                  // OpenAI / Anthropic
	regexp.MustCompile(`AIza[0-9A-Za-z_-]{20,}`),                                     // Google
	regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}`), // JWT
	regexp.MustCompile(`(?i)(bearer|api[_-]?key|token)["':=\s]+[A-Za-z0-9._-]{16,}`),
}

// redactSecrets masks credential-shaped substrings before they reach the shared
// transcript / room state.
func redactSecrets(s string) string {
	for _, re := range pairSecretRes {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}
