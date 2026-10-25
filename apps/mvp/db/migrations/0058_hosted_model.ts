import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Whether the deployment's own model answers anyone (docs/features/model-endpoint.md#hosted-inference, decision 0099).
// Off, every model call a person causes runs on their own model, and nobody's work is skipped. Will, 2026-10-25 13:28
// PDT: "our hosted cerebras inference is now a wip feature flagged and not being released or documented until post
// initial release".
//
// - `hosted_model`: at most one row, the Admin's setting; without it, the Worker's `HOSTED_MODEL_ENABLED` decides.
//   Browsers read the result on `GET /api/auth/session` (`hostedModel`), so a person without a model of their own sees
//   why they can't ask.
// - `hosted_model_changes`: the audit of `admin/SetHostedModel`, once per flow step (`invocation_key`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE hosted_model (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      enabled boolean NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`
    CREATE TABLE hosted_model_changes (
      invocation_key text PRIMARY KEY,
      enabled boolean NOT NULL,
      changed_by text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`
})
