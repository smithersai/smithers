package migrate

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var migrationDirAbs = filepath.Abs

func RunAtlasApply(ctx context.Context, env AtlasEnv, dir string) error {
	args := []string{
		"migrate",
		"apply",
		"--url", env.URL,
		"--dir", migrationDirURI(dir),
	}
	return runAtlas(ctx, args...)
}

func RunAtlasStatus(ctx context.Context, env AtlasEnv, dir string) error {
	args := []string{
		"migrate",
		"status",
		"--url", env.URL,
		"--dir", migrationDirURI(dir),
	}
	return runAtlas(ctx, args...)
}

func RunAtlasDiff(ctx context.Context, env AtlasEnv, dir, name string) error {
	args := []string{
		"migrate",
		"diff",
		name,
		"--dir", migrationDirURI(dir),
		"--to", env.URL,
		"--dev-url", env.DevURL,
	}
	return runAtlas(ctx, args...)
}

func migrationDirURI(dir string) string {
	abs, err := migrationDirAbs(dir)
	if err != nil {
		abs = dir
	}
	return "file://" + filepath.ToSlash(abs)
}

func runAtlas(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "atlas", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("atlas %s: %w", strings.Join(redactAtlasArgs(args), " "), err)
	}
	return nil
}

// redactAtlasArgs strips DSN passwords from argv before it is embedded in
// error text, which lands in CI/release logs.
func redactAtlasArgs(args []string) []string {
	redacted := make([]string, len(args))
	for i, arg := range args {
		redacted[i] = redactURLCredentials(arg)
	}
	return redacted
}

func redactURLCredentials(arg string) string {
	if strings.HasPrefix(arg, "--url=") {
		return "--url=" + redactURLCredentials(strings.TrimPrefix(arg, "--url="))
	}
	u, err := url.Parse(arg)
	if err != nil {
		if strings.Contains(arg, "://") {
			return "[redacted invalid URL]"
		}
		return arg
	}
	if u.User != nil {
		u.User = url.User(u.User.Username())
	}
	query := u.Query()
	for key := range query {
		switch strings.ToLower(key) {
		case "password", "pass", "sslpassword":
			query.Set(key, "[redacted]")
		}
	}
	u.RawQuery = query.Encode()
	return u.String()
}
