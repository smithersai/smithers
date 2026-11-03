import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Who asked each question (docs/features/chat.md#messages-postgres). `asked_by` is the asking actor's person id, which
// ChatApi takes from the session, never from the request body. The answer routes accept a turn or a write only from
// that person (worker/Answers.ts), so one Member can't write, settle or read the turn of another's answer. An answer
// has none: it belongs to its question's asker. The messages shape doesn't sync the column (worker/Chat.ts).
//
// A question asked before this migration has no asker, so no one may write its answer any more. An answer still
// `streaming` under one would hold up later turns until chat/Expire settled it, so it settles now as `failed`,
// `abandoned`, as 0008 settled what ChatApi left.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN asked_by text`
  yield* sql`
    ALTER TABLE messages ADD CONSTRAINT messages_asked_by_check CHECK (role = 'user' OR asked_by IS NULL)`
  yield* sql`
    UPDATE messages SET status = 'failed', failure = 'abandoned', updated_at = now()
    WHERE role = 'assistant' AND status = 'streaming'`
})
