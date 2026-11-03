import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Repository secrets (decision 0005 §4, docs/features/secrets.md). A value is write-only: it is sealed before it reaches
// a flow, so Postgres, the flow journal and every replica hold only ciphertext.
//
// - `secrets`: one row per repository and name. `ciphertext` and `nonce` are AES-256-GCM under `SECRETS_KEY`
//   (`@smthrs/control`'s `WebCryptoCipher`), with the repository, the name and `key_version` as the authenticated
//   context, so a ciphertext moved to another row doesn't open. `hosts` and `methods` are the binding: the only hosts and
//   methods the egress puts the value in a request for. Only `secret/Put` and `secret/Delete` write it. The browser's
//   shape reads `repo_id, name, hosts, methods, updated_at`, never the ciphertext.
// - `secret_events`: the audit, never a value. A person's set, replace and delete, once per flow step
//   (`invocation_key`); and each egress decision, `forwarded` or the refusal's code, with the host, the method, the
//   guest's scope (a branch and its machine's generation) and the names of the secrets the request used.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE secrets (
      repo_id text NOT NULL,
      name text NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,63}$'),
      ciphertext text NOT NULL,
      nonce text NOT NULL,
      key_version integer NOT NULL CHECK (key_version >= 1),
      hosts text[] NOT NULL CHECK (cardinality(hosts) BETWEEN 1 AND 16),
      methods text[] CHECK (methods IS NULL OR cardinality(methods) >= 1),
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repo_id, name)
    )`
  yield* sql`ALTER TABLE secrets REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE secret_events (
      id bigserial PRIMARY KEY,
      repo_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('set', 'replace', 'delete', 'use')),
      names text[] NOT NULL DEFAULT '{}',
      actor_id text,
      invocation_key text UNIQUE,
      scope text,
      host text,
      method text,
      outcome text,
      at timestamptz NOT NULL DEFAULT now(),
      CHECK ((action = 'use') = (outcome IS NOT NULL AND host IS NOT NULL AND scope IS NOT NULL)),
      CHECK ((action = 'use') OR (actor_id IS NOT NULL AND invocation_key IS NOT NULL))
    )`
  yield* sql`CREATE INDEX secret_events_repo_at ON secret_events (repo_id, at DESC)`
})
