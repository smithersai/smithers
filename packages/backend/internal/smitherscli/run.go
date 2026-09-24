package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	incur "github.com/smithersai/incur"
	"golang.org/x/term"
)

var cliVersion = "0.1.0"

func Run(argv []string) int {
	rewritten := rewriteCLIArgv(argv)
	if firstCommandIndex := findFirstCommandIndex(rewritten); firstCommandIndex != nil && rewritten[*firstCommandIndex] == "_internal" {
		return serveCLI(internalCommand(), rewritten[*firstCommandIndex+1:])
	}
	return serveCLI(newCLIWithFeatureFlags(loadFeatureFlagsForRootHelp(rewritten)), rewritten)
}

func serveCLI(cli *incur.Cli, argv []string) int {
	var stdout bytes.Buffer
	human := term.IsTerminal(int(os.Stdout.Fd()))
	err := cli.ServeWithOptions(argv, incur.ServeOptions{
		Stdin:  os.Stdin,
		Stdout: &stdout,
		Stderr: os.Stderr,
		Human:  &human,
	})
	if err == nil {
		_, _ = os.Stdout.Write(stdout.Bytes())
		return 0
	}
	_, _ = os.Stderr.Write(stdout.Bytes())
	var incurErr *incur.IncurError
	if errors.As(err, &incurErr) && incurErr.ExitCode != 0 {
		return incurErr.ExitCode
	}
	return 1
}

type featureFlags map[string]bool

type commandRegistration struct {
	command     func() *incur.Cli
	featureFlag string
	name        string
}

var commandRegistrations = []commandRegistration{
	{name: "agent", command: agentCommand, featureFlag: "agents"},
	{name: "api", command: apiCommand},
	{name: "admin", command: adminCommand},
	{name: "artifact", command: artifactCommand, featureFlag: "workflows"},
	{name: "auth", command: authCommand},
	{name: "beta", command: betaCommand},
	{name: "bookmark", command: bookmarkCommand},
	{name: "cache", command: cacheCommand, featureFlag: "workflows"},
	{name: "change", command: changeCommand},
	{name: "changeset", command: changesetCommand, featureFlag: "changesets"},
	{name: "completion", command: completionCommand},
	{name: "config", command: configCommand},
	{name: "extension", command: extensionCommand},
	{name: "issue", command: issueCommand, featureFlag: "issues"},
	{name: "label", command: labelCommand, featureFlag: "labels"},
	{name: "land", command: landCommand, featureFlag: "stacked_prs"},
	{name: "notification", command: notificationCommand, featureFlag: "notifications"},
	{name: "org", command: orgCommand},
	{name: "repo", command: repoCommand},
	{name: "run", command: workflowRunCommand, featureFlag: "workflows"},
	{name: "search", command: searchCommand, featureFlag: "search"},
	{name: "secret", command: secretCommand, featureFlag: "secrets"},
	{name: "ssh-key", command: sshKeyCommand},
	{name: "stack", command: stackCommand, featureFlag: "stacked_prs"},
	{name: "status", command: statusCommand},
	{name: "variable", command: variableCommand},
	{name: "webhook", command: webhookCommand, featureFlag: "webhooks_user"},
	{name: "wiki", command: wikiCommand, featureFlag: "wiki"},
	{name: "workflow", command: workflowCommand, featureFlag: "workflows"},
	{name: "workspace", command: workspaceCommand, featureFlag: "workspaces"},
}

// resolvedCLIVersion is the version the CLI reports in --version and in its
// User-Agent.
func resolvedCLIVersion() string {
	if version := strings.TrimSpace(os.Getenv("SMITHERS_CLI_VERSION")); version != "" {
		return version
	}
	return cliVersion
}

func newCLIWithFeatureFlags(flags featureFlags) *incur.Cli {
	cli := incur.New("smithers",
		incur.WithDescription("Smithers CLI - jj-native code hosting"),
		incur.WithVersion(resolvedCLIVersion()),
	)
	for _, registration := range commandRegistrations {
		if registration.featureFlag != "" && flags != nil {
			if enabled, ok := flags[registration.featureFlag]; ok && !enabled {
				continue
			}
		}
		cli.Group(registration.name, registration.command())
	}
	return cli
}

func shouldLoadFeatureFlagsForRootHelp(argv []string) bool {
	if os.Getenv("SMITHERS_CLI_DISABLE_FEATURE_FLAG_HELP") == "1" {
		return false
	}
	hasHelp := false
	for _, token := range argv {
		if token == "--help" || token == "-h" {
			hasHelp = true
			break
		}
	}
	return hasHelp && findFirstCommandIndex(argv) == nil
}

func loadFeatureFlagsForRootHelp(argv []string) featureFlags {
	if !shouldLoadFeatureFlagsForRootHelp(argv) {
		return nil
	}
	cfg, err := LoadConfig()
	if err != nil {
		return nil
	}
	baseURL := strings.TrimRight(cfg.APIURL, "/")
	ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/feature-flags", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", cliUserAgent())
	resp, err := apiHTTPClient.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	var parsed struct {
		Flags map[string]any `json:"flags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil || parsed.Flags == nil {
		return nil
	}
	flags := featureFlags{}
	for name, value := range parsed.Flags {
		if enabled, ok := value.(bool); ok {
			flags[name] = enabled
		}
	}
	return flags
}
