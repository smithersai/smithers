// Package native composes the shared backend with packaged PostgreSQL for a desktop installation.
package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

type Config struct {
	Postgres postgres.Config
	App      app.Config
}

func Run(ctx context.Context, cfg Config) error {
	database, err := postgres.Start(ctx, cfg.Postgres)
	if err != nil {
		return fmt.Errorf("start owned postgres: %w", err)
	}
	previous, existed := os.LookupEnv("SMITHERS_DATABASE_URL")
	if err := os.Setenv("SMITHERS_DATABASE_URL", database.ConnectionString); err != nil {
		_ = stop(database)
		return err
	}
	defer func() {
		if existed {
			_ = os.Setenv("SMITHERS_DATABASE_URL", previous)
		} else {
			_ = os.Unsetenv("SMITHERS_DATABASE_URL")
		}
	}()
	if err := app.Migrate(ctx, database.ConnectionString); err != nil {
		return errors.Join(fmt.Errorf("migrate owned postgres: %w", err), stop(database))
	}
	appCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	appDone := make(chan error, 1)
	go func() { appDone <- app.Run(appCtx, cfg.App) }()
	select {
	case appErr := <-appDone:
		cancel()
		return errors.Join(appErr, stop(database))
	case <-database.Done():
		cancel()
		appErr := <-appDone
		_ = database.Stop(context.Background())
		pgErr := database.Err()
		if pgErr == nil {
			pgErr = errors.New("owned postgres exited unexpectedly")
		} else {
			pgErr = fmt.Errorf("owned postgres exited: %w", pgErr)
		}
		return errors.Join(pgErr, appErr)
	case <-ctx.Done():
		cancel()
		appErr := <-appDone
		stopErr := stop(database)
		if appErr != nil && !errors.Is(appErr, context.Canceled) {
			return errors.Join(appErr, stopErr)
		}
		if stopErr != nil {
			return stopErr
		}
		return ctx.Err()
	}
}

func stop(database *postgres.Instance) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return database.Stop(ctx)
}
