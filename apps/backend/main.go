package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/localbootstrap"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/native"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/process"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) (runErr error) {
	// Schema maintenance is server-free. The native path migrates its owned
	// PostgreSQL after the supervisor reports readiness.
	if len(args) > 0 && args[0] == "migrate" {
		if _, err := externalDatabaseURL(); err != nil {
			return err
		}
		return app.Run(ctx, app.Config{Args: args})
	}
	manifestPath := strings.TrimSpace(os.Getenv("SMITHERS_FLOW_HOST_MANIFEST"))
	if manifestPath == "" {
		return errors.New("SMITHERS_FLOW_HOST_MANIFEST is required to serve the packaged Flow hosts")
	}
	registry, err := flowmanifest.Load(manifestPath)
	if err != nil {
		return fmt.Errorf("load bundled Flow hosts: %w", err)
	}

	nativeBin := strings.TrimSpace(os.Getenv("SMITHERS_NATIVE_POSTGRES_BIN"))
	var databaseURL string
	if nativeBin == "" {
		var err error
		databaseURL, err = externalDatabaseURL()
		if err != nil {
			return err
		}
		if err := requireExternalBootstrapToken(os.Getenv("SMITHERS_DATA_ROOT")); err != nil {
			return err
		}
	}

	local, err := localbootstrap.Prepare(os.Getenv("SMITHERS_DATA_ROOT"))
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		runErr = errors.Join(runErr, local.Shutdown(shutdownCtx))
	}()

	dataRoot := os.Getenv("SMITHERS_DATA_ROOT")
	workspaceRuntime, err := process.New(process.Config{Root: filepath.Join(dataRoot, "workspaces")})
	if err != nil {
		return fmt.Errorf("start local workspace runtime: %w", err)
	}
	// app.Run normally owns this close. Retain a final close for migration or
	// startup failures before app.Run gets control of the adapter.
	defer func() { runErr = errors.Join(runErr, workspaceRuntime.Close()) }()
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{
		Runtime:    workspaceRuntime,
		NodeBinary: strings.TrimSpace(os.Getenv("SMITHERS_NODE_BINARY")),
		BundlePath: strings.TrimSpace(os.Getenv("SMITHERS_MODEL_HOST_BUNDLE")),
	})
	if err != nil {
		return fmt.Errorf("configure local model host: %w", err)
	}
	resolver, err := modelhost.NewOwnerSecretResolver(
		func() string { return os.Getenv("SMITHERS_DATABASE_URL") },
		func() string { return os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY") },
	)
	if err != nil {
		return err
	}
	chatHost, err := modelhost.New(resolver, launcher)
	if err != nil {
		return err
	}
	var recommender ports.Recommender
	if key := strings.TrimSpace(os.Getenv("AI_GATEWAY_API_KEY")); key != "" {
		recommender, err = modelhost.NewJevRecommender(key, os.Getenv("SMITHERS_JEV_ENDPOINT"), nil)
		if err != nil {
			return fmt.Errorf("configure recommender: %w", err)
		}
	}

	appConfig := app.Config{
		Role:             app.RoleLocal,
		Args:             args,
		Repository:       local.Client(),
		Workspace:        workspaceRuntime,
		FlowHostRegistry: &registry,
		ChatHost:         chatHost,
		Recommender:      recommender,
	}
	if nativeBin != "" {
		stateRoot := strings.TrimSpace(os.Getenv("SMITHERS_NATIVE_STATE_DIR"))
		if stateRoot == "" {
			stateRoot = dataRoot
		}
		return native.Run(ctx, native.Config{
			App: appConfig,
			Postgres: postgres.Config{
				BinDir:   nativeBin,
				StateDir: filepath.Join(stateRoot, "postgres"),
				Major:    18,
			},
		})
	}
	if err := app.Migrate(ctx, databaseURL); err != nil {
		return fmt.Errorf("migrate product database: %w", err)
	}
	return app.Run(ctx, appConfig)
}

func externalDatabaseURL() (string, error) {
	if databaseURL := strings.TrimSpace(os.Getenv("SMITHERS_DATABASE_URL")); databaseURL != "" {
		return databaseURL, nil
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return "", errors.New("SMITHERS_DATABASE_URL or DATABASE_URL is required for an external PostgreSQL backend")
	}
	if err := os.Setenv("SMITHERS_DATABASE_URL", databaseURL); err != nil {
		return "", err
	}
	return databaseURL, nil
}

func requireExternalBootstrapToken(dataRoot string) error {
	if strings.TrimSpace(os.Getenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN")) != "" {
		return nil
	}
	if strings.TrimSpace(dataRoot) == "" {
		dataRoot = localbootstrap.DefaultDataRoot
	}
	secretsPath := filepath.Join(dataRoot, "config", "secrets.json")
	if _, err := os.Stat(secretsPath); err == nil {
		// Existing installations reopen their protected, durable setup secret.
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect local secrets: %w", err)
	}
	return errors.New("SMITHERS_AUTH_BOOTSTRAP_TOKEN is required for first setup with external PostgreSQL")
}
