package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/smithersai/smithers/packages/backend/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	databaseURL := os.Getenv("SMITHERS_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("DATABASE_URL")
		if databaseURL != "" {
			if err := os.Setenv("SMITHERS_DATABASE_URL", databaseURL); err != nil {
				return err
			}
		}
	}
	if databaseURL != "" && (len(args) == 0 || args[0] != "migrate") {
		if err := app.Migrate(ctx, databaseURL); err != nil {
			return err
		}
	}
	return app.Run(ctx, app.Config{Args: args})
}
