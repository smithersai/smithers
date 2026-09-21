package smitherscli

import (
	"fmt"
	"os"
	"strings"

	incur "github.com/smithersai/incur"
)

func completionCommand() *incur.Cli {
	cmd := incur.New("completion", incur.WithDescription("Generate shell completions"))
	cmd.Command("", &incur.CommandDef{
		Description: "Generate shell completions",
		ArgsSchema: objectSchema([]string{"shell"}, map[string]*incur.JSONSchema{
			"shell": enumSchema("Shell type", []string{"bash", "zsh", "fish"}, ""),
		}),
		Handler: completionHandler,
	})
	return cmd
}

func completionHandler(ctx *incur.CommandContext) (any, error) {
	shell := incur.Shell(stringValue(ctx.Args["shell"]))
	switch shell {
	case incur.ShellBash, incur.ShellZsh, incur.ShellFish:
		_, _ = fmt.Fprintln(os.Stdout, incur.Register(shell, "smithers"))
		_, _ = fmt.Fprint(os.Stdout, completionCommandMetadata())
		return nil, nil
	default:
		return nil, fmt.Errorf("Unknown shell '%s'. Supported: bash, fish, zsh", shell)
	}
}

func completionCommandMetadata() string {
	names := []string{
		"admin", "agent", "api", "artifact", "auth", "beta", "bookmark", "cache",
		"change", "completion", "config", "extension", "issue", "label", "land",
		"notification", "org", "repo", "run", "search", "secret",
		"ssh-key", "stack", "status", "variable", "webhook", "wiki", "workflow",
		"workspace",
	}
	return "\n# smithers commands: " + strings.Join(names, " ") + "\n# agent) session list view run chat\n"
}
