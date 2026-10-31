import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Repository feeds (decision 0128, docs/features/feeds.md): what an outside collector pushes about a repository, and
// what people answer back.
//
// - `feed_documents`: one named JSON document per repository (`repo` is `owner/name`, lowercased). `id` is
//   `<repo>:<name>`, Electric's key; `visibility` says who it syncs to (everyone, or the repository's Maintainers and
//   Admins); `updated_at` changes only when the body or visibility does.
// - `feed_answers`: a person's answer to an item a feed shows, keyed by the id the browser chose, so a resend changes
//   nothing. `seq` orders them for the collector's cursor. Who answered is the session's: their id and login then.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE feed_documents (
      id text PRIMARY KEY,
      repo text NOT NULL,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      visibility text NOT NULL CHECK (visibility IN ('public', 'maintainers')),
      body jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repo, name),
      CHECK (id = repo || ':' || name)
    )`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE feed_documents REPLICA IDENTITY FULL`
  yield* sql`
    CREATE TABLE feed_answers (
      id uuid PRIMARY KEY,
      repo text NOT NULL,
      item text NOT NULL CHECK (char_length(item) BETWEEN 1 AND 200),
      choice text CHECK (choice IS NULL OR char_length(choice) BETWEEN 1 AND 200),
      text text CHECK (text IS NULL OR char_length(text) <= 8000),
      person_id text NOT NULL,
      login text,
      at timestamptz NOT NULL DEFAULT now(),
      seq bigserial NOT NULL UNIQUE
    )`
  // The collector reads a repository's answers after its cursor.
  yield* sql`CREATE INDEX feed_answers_repo_seq ON feed_answers (repo, seq)`
})
