package compose

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/db/product"
)

var (
	applyProductSchema  = product.Apply
	productSchemaStatus = product.Status
)

// runMigrate is independent from server configuration and startup. A
// single-container installation needs only PostgreSQL to install the product
// schema; no Atlas executable or cloud configuration is loaded.
func runMigrate(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("smithers-backend migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	subcommand := "apply"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		subcommand = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return &flagParseError{err}
	}
	if fs.NArg() > 0 {
		return &flagParseError{fmt.Errorf("migrate: unexpected argument %q", fs.Arg(0))}
	}
	if subcommand != "apply" && subcommand != "status" {
		return &flagParseError{fmt.Errorf("migrate: unknown subcommand %q (want apply or status)", subcommand)}
	}
	databaseURL := strings.TrimSpace(os.Getenv("SMITHERS_DATABASE_URL"))
	if databaseURL == "" {
		return fmt.Errorf("migrate: SMITHERS_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("migrate: PostgreSQL pool: %w", err)
	}
	defer pool.Close()
	if subcommand == "apply" {
		return applyProductSchema(ctx, pool)
	}
	pending, err := productSchemaStatus(ctx, pool)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		_, err = fmt.Fprintln(stdout, "applied")
		return err
	}
	versions := make([]string, len(pending))
	for i, version := range pending {
		versions[i] = strconv.Itoa(version)
	}
	_, err = fmt.Fprintln(stdout, "pending "+strings.Join(versions, " "))
	return err
}
