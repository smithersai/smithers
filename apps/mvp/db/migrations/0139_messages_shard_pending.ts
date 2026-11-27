import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Every committed write of a message is owed to its conversation's messages shard (decision 0170, slice 5b).
//
// `messages_shard_pending` held a row per message whose notes the shard had not acknowledged
// (0135_message_note_versions.ts). It now holds one for every write the shard has not acknowledged: a question
// asked, an answer recorded beside it, an answer that ended, failed or changed once it stopped streaming, and the
// timeline's notes. Triggers write the row in the transaction that wrote the message, so a write Postgres committed is
// owed to the shard from that commit on, whatever becomes of the request that wrote it: an answer whose bridge failed
// after its commit is sent by the next read of the conversation (worker/chat/MessagesShardSource.ts `drain`).
// A streaming answer's text is not owed while it streams: the shard is sent an answer once it ends.
//
// `obligation` is raised from one sequence by every write of the row, so it names which write the shard was sent:
// ChatApi takes a row away only under the obligation it read, and a write committed while the shard was being sent
// stays owed. Rows already owed are given one. Messages Postgres held before this are the backfill's
// (worker/chat/MessagesShardBackfill.vibe), and owe nothing here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE SEQUENCE IF NOT EXISTS messages_shard_obligation`
  yield* sql`
    ALTER TABLE messages_shard_pending
    ADD COLUMN IF NOT EXISTS obligation bigint NOT NULL DEFAULT nextval('messages_shard_obligation')`
  // Both triggers name the table and the sequence by the schema this migration runs in, whatever path a later
  // session searches.
  yield* sql`
    DO $do$ BEGIN EXECUTE format($create$
      CREATE OR REPLACE FUNCTION %1$I.messages_notes_pending() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        INSERT INTO %1$I.messages_shard_pending (message_id, conversation_id, notes_version, obligation)
        VALUES (NEW.id, NEW.conversation_id, NEW.notes_version, nextval('%1$I.messages_shard_obligation'))
        ON CONFLICT (message_id) DO UPDATE
        SET conversation_id = EXCLUDED.conversation_id, notes_version = EXCLUDED.notes_version,
          obligation = EXCLUDED.obligation;
        RETURN NULL;
      END
      $fn$
    $create$, current_schema()); END $do$`
  yield* sql`DROP TRIGGER IF EXISTS messages_shard_asked ON messages`
  yield* sql`
    CREATE TRIGGER messages_shard_asked AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_notes_pending()`
  yield* sql`DROP TRIGGER IF EXISTS messages_shard_answered ON messages`
  yield* sql`
    CREATE TRIGGER messages_shard_answered AFTER UPDATE ON messages
    FOR EACH ROW WHEN (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
      OR (NEW.status <> 'streaming'
        AND (NEW.text, NEW.failure, NEW.parts, NEW.model_id, NEW.stop_reason, NEW.input_tokens, NEW.output_tokens)
          IS DISTINCT FROM (OLD.text, OLD.failure, OLD.parts, OLD.model_id, OLD.stop_reason, OLD.input_tokens, OLD.output_tokens)))
    EXECUTE FUNCTION messages_notes_pending()`
})
