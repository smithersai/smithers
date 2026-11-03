import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A sandbox call can fail `start_timeout`: its branch's machine didn't finish starting within
// SANDBOX_START_TIMEOUT_SECONDS (docs/features/sandbox-tools.md#sleep-and-wake), so the call settles instead of
// staying `running`. The failure's check gains it; the constraint is found by what it checks, whatever its name.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    DO $$
    DECLARE found record;
    BEGIN
      FOR found IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'sandbox_calls'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%failure = ANY%'
      LOOP
        EXECUTE format('ALTER TABLE sandbox_calls DROP CONSTRAINT %I', found.conname);
      END LOOP;
    END $$`
  yield* sql`
    ALTER TABLE sandbox_calls ADD CONSTRAINT sandbox_calls_failure_check CHECK (failure IN (
      'unavailable', 'start_timeout', 'checkout', 'lost', 'path', 'not_found', 'not_a_file', 'not_a_directory',
      'not_a_repository', 'too_large'
    ))`
})
