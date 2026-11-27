import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Prepaid compute credits for 3rd-party contributors running Cloudflare sandboxes and remote jobs (decision 0175).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS compute_accounts (
      person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      balance_micro_usd bigint NOT NULL DEFAULT 0 CHECK (balance_micro_usd >= 0),
      lifetime_purchased_micro_usd bigint NOT NULL DEFAULT 0 CHECK (lifetime_purchased_micro_usd >= 0),
      lifetime_spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (lifetime_spent_micro_usd >= 0),
      stripe_customer_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE IF NOT EXISTS compute_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('topup', 'sandbox_usage', 'admin_grant', 'refund')),
      amount_micro_usd bigint NOT NULL,
      balance_after_micro_usd bigint NOT NULL CHECK (balance_after_micro_usd >= 0),
      idempotency_key text NOT NULL UNIQUE,
      description text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE INDEX IF NOT EXISTS compute_ledger_person_created_idx
    ON compute_ledger (person_id, created_at DESC)`
  yield* sql`
    CREATE TABLE IF NOT EXISTS compute_checkout_sessions (
      id text PRIMARY KEY,
      person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      pack_id text NOT NULL,
      amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd > 0),
      status text NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'canceled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz
    )`
  yield* sql`
    CREATE INDEX IF NOT EXISTS compute_checkout_sessions_person_idx
    ON compute_checkout_sessions (person_id, created_at DESC)`
  yield* sql`
    ALTER TABLE sandbox_generations
    ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'deployment'
      CHECK (billing_mode IN ('deployment', 'paid')),
    ADD COLUMN IF NOT EXISTS billed_seconds integer NOT NULL DEFAULT 0
      CHECK (billed_seconds >= 0),
    ADD COLUMN IF NOT EXISTS billed_micro_usd bigint NOT NULL DEFAULT 0
      CHECK (billed_micro_usd >= 0)`
})
