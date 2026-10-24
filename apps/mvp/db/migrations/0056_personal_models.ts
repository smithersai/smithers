import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A person's own model (decision 0096, docs/features/personal-model.md). The key is write-only: ChatApi seals it before
// it reaches a flow, so Postgres, the flow journal and every replica hold only ciphertext.
//
// - `personal_models`: at most one row per person. `ciphertext` and `nonce` are AES-256-GCM under SECRETS_KEY
//   (`@smthrs/control`'s `WebCryptoCipher`, the key repository secrets use), with the person and `key_version` as the
//   authenticated context, so a ciphertext moved to another person's row doesn't open. `key_last4` is all the browser
//   sees of the key again. `failure_status` and `failed_at` are the last time the person's key was refused or ran out
//   (the provider's 401, 402, 403 or 429), cleared by a later success. Only `model/Put` and `model/Delete` write a row;
//   the model endpoint writes only its failure. The browser's shape reads every column but the sealed ones.
// - `personal_model_events`: the audit of `model/Put` and `model/Delete`, once per flow step (`invocation_key`).
// - `personal_model_usage`: the ledger of calls a person's own model answered, one row per call, keyed by the endpoint's
//   invocation id. It is apart from `model_usage`, whose charges add up to the deployment's daily budget: these calls
//   spend the person's key, never the deployment's budget.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE personal_models (
      person_id text PRIMARY KEY,
      protocol text NOT NULL CHECK (protocol IN ('openai-chat', 'anthropic-messages')),
      base_url text NOT NULL CHECK (base_url ~ '^https://' AND length(base_url) <= 512),
      model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 81),
      ciphertext text NOT NULL,
      nonce text NOT NULL,
      key_version integer NOT NULL CHECK (key_version >= 1),
      key_last4 text NOT NULL CHECK (length(key_last4) <= 4),
      failure_status integer CHECK (failure_status IS NULL OR failure_status BETWEEN 400 AND 599),
      failed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((failure_status IS NULL) = (failed_at IS NULL))
    )`
  yield* sql`ALTER TABLE personal_models REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE personal_model_events (
      id bigserial PRIMARY KEY,
      person_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('set', 'replace', 'delete')),
      invocation_key text NOT NULL UNIQUE,
      at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX personal_model_events_person_at ON personal_model_events (person_id, at DESC)`
  yield* sql`
    CREATE TABLE personal_model_usage (
      invocation_id text PRIMARY KEY,
      request_id text NOT NULL,
      person_id text NOT NULL,
      role text NOT NULL,
      model_id text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      outcome text CHECK (outcome IS NULL OR outcome IN ('success', 'failed', 'interrupted')),
      error_code text,
      http_status integer,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  yield* sql`CREATE INDEX personal_model_usage_person_at ON personal_model_usage (person_id, created_at DESC)`
})
