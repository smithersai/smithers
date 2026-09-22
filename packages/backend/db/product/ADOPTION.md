# Adopting an existing Plue database

`adopt.py` checks an existing database against a fresh copy of
`0001_product_baseline.sql`. It writes only the product migration ledger, and
only when the product-object diff is empty. It does not reconcile drift or run
later migrations.

1. Complete and verify a database backup.
2. Create an **empty scratch database on the same PostgreSQL major version** as
   the target. The tool installs the checked-in baseline there.
3. Run the read-only plan. It exits `2` and prints a JSON drift list when
   adoption is blocked.

   ```sh
   python3 packages/backend/db/product/adopt.py \
     --baseline-url "$EMPTY_SCRATCH_DATABASE_URL" \
     --target-url "$TARGET_DATABASE_URL" > adoption-plan.json
   ```

4. After the plan has zero drift, use a **new** empty scratch database and
   repeat with `--apply`. Then run `smithers-backend migrate apply` followed by
   Plue's private migrations. The product migration checksum and version are
   recorded in `public.smithers_product_migrations`.

The target must be kept free of unrelated DDL between a zero-drift plan and
apply. `--apply` repeats the comparison. The adoption command does not mutate
Plue's Atlas ledger or delete historical tables or data.
