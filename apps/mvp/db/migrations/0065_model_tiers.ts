import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Model tiers for people's own models (decision 0107, docs/features/personal-model.md#postgres).
//
// - `personal_models` holds one key per protocol per person, keyed by both: an OpenAI-compatible key and an
//   Anthropic-compatible one. `model_id` becomes the tiers' columns: `fast_model`, `implement_model` and `hard_model`,
//   the model id each tier uses on that key, or `NULL` where it uses another key's, a preset or the tier it falls back
//   to. A person's existing model becomes their `fast` model, and every tier falls back to it, so they are answered as
//   before. Only `model/Put` sets a tier on at most one of a person's keys.
// - `personal_model_usage` records which key answered each call (`protocol`, so a refusal marks only that key) and the
//   tier that answered it (`tier`). Calls before this migration have neither.
// - `model_roles` admits the `review` role (a pull request's review) and the `plan` role (drafting a flow), so an
//   admin may set the deployment's model for each with `admin/SetModel`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE personal_models
      ADD COLUMN fast_model text CHECK (fast_model IS NULL OR length(fast_model) BETWEEN 1 AND 81),
      ADD COLUMN implement_model text CHECK (implement_model IS NULL OR length(implement_model) BETWEEN 1 AND 81),
      ADD COLUMN hard_model text CHECK (hard_model IS NULL OR length(hard_model) BETWEEN 1 AND 81)`
  yield* sql`UPDATE personal_models SET fast_model = model_id`
  yield* sql`ALTER TABLE personal_models DROP COLUMN model_id`
  yield* sql`ALTER TABLE personal_models DROP CONSTRAINT personal_models_pkey, ADD PRIMARY KEY (person_id, protocol)`
  yield* sql`
    ALTER TABLE personal_model_usage
      ADD COLUMN protocol text CHECK (protocol IS NULL OR protocol IN ('openai-chat', 'anthropic-messages')),
      ADD COLUMN tier text CHECK (tier IS NULL OR tier IN ('fast', 'implement', 'hard'))`
  yield* sql`ALTER TABLE model_roles DROP CONSTRAINT model_roles_role_check`
  yield* sql`ALTER TABLE model_roles ADD CONSTRAINT model_roles_role_check
    CHECK (role IN ('agent', 'coding', 'renderer', 'judge', 'summary', 'review', 'plan'))`
})
