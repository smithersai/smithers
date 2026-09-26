// Command legacyimport loads a sealed cutover archive into the product
// database. It reads only the archive file and never contacts a legacy
// source. Product migrations must already be applied.
//
//	legacyimport -input archive.json                          # dry run, no database
//	legacyimport -input archive.json -sha256 HEX -apply       # import
//	legacyimport -input archive.json -sha256 HEX -verify      # read back and compare
//	legacyimport -attach SOURCE_ID -owner user:42             # unseal after an identity join
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/canonicalimport"
	"github.com/smithersai/smithers/packages/backend/credits"
)

// archive is the cutover interchange format.
type archive struct {
	ExportedAt      time.Time               `json:"exported_at"`
	CanonicalRows   []canonicalimport.Row   `json:"canonical_rows"`
	BillingAccounts []credits.LegacyAccount `json:"billing_accounts"`
}

type report struct {
	Mode          string                 `json:"mode"`
	ArchiveSHA256 string                 `json:"archive_sha256"`
	ExportedAt    time.Time              `json:"exported_at"`
	Canonical     canonicalimport.Report `json:"canonical"`
	Billing       credits.ImportReport   `json:"billing"`
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "legacyimport:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("legacyimport", flag.ContinueOnError)
	input := flags.String("input", "", "sealed JSON archive")
	apply := flags.Bool("apply", false, "import into DATABASE_URL")
	verify := flags.Bool("verify", false, "compare DATABASE_URL with the archive")
	want := flags.String("sha256", "", "archive SHA-256 from the sealed export receipt (required with -apply or -verify)")
	expect := flags.Int("expect-accounts", -1, "require exactly this many billing accounts")
	attach := flags.String("attach", "", "legacy billing source id to attach to -owner")
	owner := flags.String("owner", "", "verified owner as user:ID or org:ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *attach != "" {
		return attachOwner(ctx, *attach, *owner, out)
	}
	if *input == "" || (*apply && *verify) {
		return errors.New("-input is required; choose at most one of -apply and -verify")
	}
	content, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(content)
	result := report{Mode: "dry-run", ArchiveSHA256: hex.EncodeToString(sum[:])}
	var in archive
	dec := json.NewDecoder(bytes.NewReader(content))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&in); err != nil {
		return fmt.Errorf("archive: %w", err)
	}
	if dec.More() {
		return errors.New("archive: trailing data")
	}
	if *expect >= 0 && len(in.BillingAccounts) != *expect {
		return fmt.Errorf("archive has %d billing accounts, expected %d", len(in.BillingAccounts), *expect)
	}
	result.ExportedAt = in.ExportedAt
	importer := canonicalimport.Importer{}
	if result.Canonical, err = importer.DryRun(in.CanonicalRows); err != nil {
		return err
	}
	if result.Billing, err = credits.DryRun(in.ExportedAt, in.BillingAccounts); err != nil {
		return err
	}
	if *apply || *verify {
		if !strings.EqualFold(*want, result.ArchiveSHA256) {
			return fmt.Errorf("archive SHA-256 %s does not match -sha256 %q", result.ArchiveSHA256, *want)
		}
		pool, err := connect(ctx)
		if err != nil {
			return err
		}
		defer pool.Close()
		importer.DB = pool
		ledger := credits.Ledger{DB: pool}
		if *apply {
			result.Mode = "apply"
			if result.Canonical, err = importer.Apply(ctx, in.CanonicalRows); err != nil {
				return err
			}
			if result.Billing, err = ledger.Import(ctx, in.ExportedAt, in.BillingAccounts); err != nil {
				return err
			}
		} else {
			result.Mode = "verify"
			if result.Canonical, err = importer.Verify(ctx, in.CanonicalRows); err != nil {
				return err
			}
			if result.Billing, err = ledger.Verify(ctx, in.ExportedAt, in.BillingAccounts); err != nil {
				return err
			}
		}
	}
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(result)
}

func connect(ctx context.Context) (*pgxpool.Pool, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	return pgxpool.New(ctx, url)
}

func attachOwner(ctx context.Context, sourceID, owner string, out io.Writer) error {
	kind, rawID, ok := strings.Cut(owner, ":")
	id, err := strconv.ParseInt(rawID, 10, 64)
	if !ok || err != nil || (kind != "user" && kind != "org") || id <= 0 {
		return errors.New("-owner must be user:ID or org:ID")
	}
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = (credits.Ledger{DB: pool}).AttachOwner(ctx, sourceID, kind, id); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "attached %s to %s:%d\n", sourceID, kind, id)
	return err
}
