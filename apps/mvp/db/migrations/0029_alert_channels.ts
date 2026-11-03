import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Where spend alerts go outside the app, and what each delivery did (docs/features/spend-alerts.md#channels). Will,
// 2026-10-20: "configurable but atm i think alerts to email make sense but telegram too would be useful".
//
// `alert_channels` is the deployment's setting, one row per channel an Admin turned on: its destinations (email
// addresses, or one Telegram chat id) and the app's address the message links to. No row, no delivery on that channel.
// `alert_deliveries` is one receipt per alert and channel: sent, refused for good, or failed and being retried. Neither
// holds a credential; the providers' keys are deployment secrets. Both sync to Admins only.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE alert_channels (
      channel text PRIMARY KEY CHECK (channel IN ('email', 'telegram')),
      audience text NOT NULL DEFAULT 'admin' CHECK (audience IN ('admin')),
      destinations jsonb NOT NULL
        CHECK (jsonb_typeof(destinations) = 'array' AND jsonb_array_length(destinations) BETWEEN 1 AND 10),
      app_url text NOT NULL CHECK (app_url ~ '^https?://'),
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE alert_deliveries (
      alert_id text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('email', 'telegram')),
      audience text NOT NULL DEFAULT 'admin' CHECK (audience IN ('admin')),
      status text NOT NULL CHECK (status IN ('sent', 'refused', 'failed')),
      code text,
      reason text CHECK (char_length(reason) <= 120),
      http_status integer,
      provider_id text,
      attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (alert_id, channel)
    )`
  // The shape reads an audience's latest receipts.
  yield* sql`CREATE INDEX alert_deliveries_audience ON alert_deliveries (audience, updated_at)`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE alert_channels REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE alert_deliveries REPLICA IDENTITY FULL`
})
