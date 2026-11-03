import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Co-editing (decision 0013 §4, docs/features/coedit.md): every input two people see at once, a conversation's prompt,
// a file of a branch's working copy or a run's answer box, is a text they edit together (`@smthrs/sync`'s
// `SharedText`). A text is every update written to it, in any order: `text_updates` keeps one row per update, as
// base64, under the text's scope (`branch:<id>` for a conversation's texts, `run:<id>` for a run's answer box), which
// decides who may read and write it, and its id (`text_id`, derived on every device from what the text is).
// `POST /api/texts/<id>` inserts a row for someone who may edit the text; the update's id is the writer's, so a resend
// changes nothing.
//
// A file's text starts from one seed: its content when someone first opened it, written as the seed's own replica.
// One seed per text, whoever sends it first, so two people opening a file at once agree on how it began.
//
// `data` is the update, as base64, and content: synced to the people who may see the text, never logged. Electric
// sends only `id` and `data`; rows are only inserted, never updated.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE text_updates (
      id uuid PRIMARY KEY,
      scope text NOT NULL CHECK (scope ~ '^(branch|run):[0-9a-f-]{36}$'),
      text_id uuid NOT NULL,
      data text NOT NULL CHECK (char_length(data) BETWEEN 1 AND 2097152),
      seed boolean NOT NULL DEFAULT false,
      person_id text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 100),
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  // A text's updates, as its shape reads them.
  yield* sql`CREATE INDEX text_updates_text ON text_updates (scope, text_id)`
  // One seed per text.
  yield* sql`CREATE UNIQUE INDEX text_updates_seed ON text_updates (scope, text_id) WHERE seed`
})
