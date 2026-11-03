import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A person's own list of conversations (decision 0013 decision 2, docs/features/conversations.md#postgres): one row per
// person and conversation. Archive is personal; opening the branch brings it back, and the latest act wins across
// devices (`changed_at`): an act, archive or open, carries the time it was taken, so the same act tried again never
// moves past a later one. The names are a snapshot for the list, refreshed on every open. No backfill: a conversation
// joins someone's list when they open it or ask in it.
//
// `branches.create_request` is the request that made a branch (`conversation/new`), so asking again for the branch it
// made answers that branch, and any other request for the name is refused `exists`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE conversation_people (
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      person_id text NOT NULL,
      owner text NOT NULL CHECK (char_length(owner) BETWEEN 1 AND 300),
      repo text NOT NULL CHECK (char_length(repo) BETWEEN 1 AND 300),
      branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
      opened_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      changed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, person_id)
    )`
  yield* sql`CREATE INDEX conversation_people_person_opened ON conversation_people (person_id, opened_at DESC)`
  // Electric sends the whole row on update or delete without requiring superuser access.
  yield* sql`ALTER TABLE conversation_people REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE branches ADD COLUMN create_request uuid`
})
