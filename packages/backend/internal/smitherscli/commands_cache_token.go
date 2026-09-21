package smitherscli

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	incur "github.com/smithersai/incur"
)

// registerBuildCacheCommands adds the smithers build cache commands to the
// `cache` group: public read tokens, and `connect`, which mints one and writes
// the declaration into the workspace's root BUILD.ts the way `nx connect` does.
func registerBuildCacheCommands(cmd *incur.Cli) {
	token := incur.New("token", incur.WithDescription("Manage public read tokens for the repository build cache"))
	token.Command("create", &incur.CommandDef{
		Description: "Mint a public read token: it can only read this repository's build cache and is safe to commit",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
			"name": {Type: "string", Description: "A label for the token", Default: ""},
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			created, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/build-cache/tokens", owner, repo), map[string]any{"name": stringValue(ctx.Options["name"])}, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			if ctx.FormatExplicit {
				return created, nil
			}
			return formatBuildCacheTokenCreated(created), nil
		},
	})
	token.Command("list", repoOnlyCommand("List the repository's active public read tokens", func(owner, repo string, ctx *incur.CommandContext) (any, error) {
		return APIRequest("GET", fmt.Sprintf("/api/repos/%s/%s/build-cache/tokens", owner, repo), nil, nil)
	}))
	token.Command("revoke", &incur.CommandDef{
		Description: "Revoke a public read token by id",
		OptionsSchema: objectSchema([]string{"id"}, map[string]*incur.JSONSchema{
			"repo": stringSchema("Repository (OWNER/REPO)"),
			"id":   numberSchema("Token id", 0),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			id := intValue(ctx.Options["id"], 0)
			if id <= 0 {
				return nil, fmt.Errorf("token id is required")
			}
			if _, err := APIRequest("DELETE", fmt.Sprintf("/api/repos/%s/%s/build-cache/tokens/%d", owner, repo, id), nil, nil); err != nil {
				return nil, cleanAPIError(err)
			}
			return map[string]any{"revoked": id}, nil
		},
	})
	cmd.Group("token", token)

	cmd.Command("connect", &incur.CommandDef{
		Description: "Connect this workspace to the jjhub build cache: mint a public read token and declare it in the root BUILD.ts",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo":      stringSchema("Repository (OWNER/REPO); detected from the jj or git remote when omitted"),
			"workspace": {Type: "string", Description: "Workspace root holding BUILD.ts", Default: "."},
			"write":     booleanSchema("Write the declaration into BUILD.ts (false prints it)", true),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			owner, repo, err := ResolveRepoRef(stringValue(ctx.Options["repo"]))
			if err != nil {
				return nil, err
			}
			workspace := stringValue(ctx.Options["workspace"])
			if strings.TrimSpace(workspace) == "" {
				workspace = "."
			}
			buildFile := filepath.Join(workspace, "BUILD.ts")
			existing, _ := os.ReadFile(buildFile)
			if declared := existingJjhubCacheDeclaration(string(existing)); declared != "" {
				return map[string]any{
					"build_file":  buildFile,
					"declaration": declared,
					"changed":     false,
					"message":     "BUILD.ts already declares the jjhub build cache",
				}, nil
			}
			created, err := APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/build-cache/tokens", owner, repo), map[string]any{"name": "smithers cache connect"}, nil)
			if err != nil {
				return nil, cleanAPIError(err)
			}
			record, _ := created.(map[string]any)
			tokenValue := stringValue(record["token"])
			if tokenValue == "" {
				return nil, fmt.Errorf("the API did not return a public read token")
			}
			declaration := jjhubCacheDeclaration(owner+"/"+repo, tokenValue)
			write, _ := ctx.Options["write"].(bool)
			if !write {
				return map[string]any{"build_file": buildFile, "declaration": declaration, "changed": false}, nil
			}
			updated, err := insertJjhubCacheDeclaration(string(existing), declaration)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Dir(buildFile), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(buildFile, []byte(updated), 0o644); err != nil {
				return nil, err
			}
			return map[string]any{
				"build_file":  buildFile,
				"declaration": declaration,
				"changed":     true,
				"endpoint":    stringValue(record["endpoint"]),
				"message":     "Commit BUILD.ts; the token only reads this repository's cache. Publishing needs SMITHERS_CACHE_TOKEN (a write:repository token) in the environment.",
			}, nil
		},
	})
}

func formatBuildCacheTokenCreated(created any) string {
	record, _ := created.(map[string]any)
	var b strings.Builder
	fmt.Fprintf(&b, "Created public read token for %s\n", stringValue(record["repository"]))
	fmt.Fprintf(&b, "  token:    %s\n", stringValue(record["token"]))
	fmt.Fprintf(&b, "  endpoint: %s\n", stringValue(record["endpoint"]))
	b.WriteString("  This token can only read this repository's build cache; it is safe to commit.\n")
	b.WriteString("  Declare it in BUILD.ts:\n")
	b.WriteString("    " + jjhubCacheDeclaration(stringValue(record["repository"]), stringValue(record["token"])) + "\n")
	return b.String()
}

// jjhubCacheDeclaration is the BUILD.ts line `smithers cache connect` writes.
func jjhubCacheDeclaration(repository, token string) string {
	return fmt.Sprintf(`export const remoteCache = Smithers.RemoteCache.jjhub({ repo: %q, publicReadToken: %q })`, repository, token)
}

var jjhubCacheDeclarationPattern = regexp.MustCompile(`(?m)^export const \w+ = Smithers\.RemoteCache\.jjhub\([^\n]*\)\s*$`)

func existingJjhubCacheDeclaration(source string) string {
	return strings.TrimSpace(jjhubCacheDeclarationPattern.FindString(source))
}

const targetsImport = `import { Smithers } from "@smthrs/targets"`

// insertJjhubCacheDeclaration places the declaration after the import block of
// an existing BUILD.ts, or creates a minimal file when there is none.
func insertJjhubCacheDeclaration(source, declaration string) (string, error) {
	if strings.TrimSpace(source) == "" {
		return targetsImport + "\n\n" + declaration + "\n", nil
	}
	if !strings.Contains(source, "@smthrs/targets") {
		return "", fmt.Errorf("BUILD.ts does not import @smthrs/targets; add the declaration by hand:\n%s", declaration)
	}
	lines := strings.Split(source, "\n")
	lastImport := -1
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "import ") {
			lastImport = index
		}
	}
	insertAt := lastImport + 1
	out := make([]string, 0, len(lines)+3)
	out = append(out, lines[:insertAt]...)
	out = append(out, "", declaration)
	out = append(out, lines[insertAt:]...)
	return strings.Join(out, "\n"), nil
}
