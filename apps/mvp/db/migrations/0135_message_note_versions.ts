import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A version for a message's notes, what a segmentation marked, and the notes a conversation's shard is still owed
// (decision 0170, slice 5a).
//
// `messages.notes_version` counts the writes of a row's summary, phase and arc. A trigger raises it on every update
// that changes one of them and did not raise it itself, under the row's lock, so it only rises in commit order whoever
// writes: this Worker, whose statements raise it themselves (worker/TimelineSummaries.vibe), or one deployed before the
// column, whose statements do not. ChatApi's bridge sends the notes with it, and the conversation's shard ignores a
// write no newer than the one it holds (worker/chat/MessagesShardSource.ts). It stays on the server, as a summary's
// claim does: no shape lists it (worker/Chat.ts `SYNCED_MESSAGE_COLUMNS`).
//
// `messages_shard_pending` is the notes the shard has not acknowledged: one row per message, written by a second
// trigger in the transaction that changed the version, so a note Postgres committed is owed to the shard from that
// commit on, whatever becomes of the request that wrote it. ChatApi deletes a row once the shard has a receipt for a
// version at least the row's (`MessagesShardSource.drain`), after the write and before every read of the shard, so a
// crash between the commit and the send, or a shard that could not be reached, is made up without the write being sent
// again. Every message that held a note before this table is owed too. `attempted_at` is when a send of the row last
// left it owed: `drain` sends the rows never tried first, then the one tried longest ago, so a row the shard keeps
// declining goes to the back of its conversation's queue and never holds a later one out of it.
//
// `timeline_phase_claims.marked` is the ids of the messages a recorded segmentation set or cleared a mark on, kept with
// the record. A claim recorded before this has none, and a replay of one reads the conversation's noted messages.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS notes_version bigint NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE timeline_phase_claims ADD COLUMN IF NOT EXISTS marked jsonb`
  yield* sql`
    CREATE TABLE IF NOT EXISTS messages_shard_pending (
      message_id uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL,
      notes_version bigint NOT NULL,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      attempted_at timestamptz
    )`
  yield* sql`
    CREATE INDEX IF NOT EXISTS messages_shard_pending_conversation
    ON messages_shard_pending (conversation_id, attempted_at NULLS FIRST, enqueued_at)`
  // Both functions name their table by the schema this migration runs in, whatever path a later session searches.
  yield* sql`
    DO $do$ BEGIN EXECUTE format($create$
      CREATE OR REPLACE FUNCTION %1$I.messages_notes_versioned() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        IF NEW.notes_version = OLD.notes_version
          AND (NEW.summary, NEW.summary_revision, NEW.phase, NEW.arc)
            IS DISTINCT FROM (OLD.summary, OLD.summary_revision, OLD.phase, OLD.arc)
        THEN
          NEW.notes_version := OLD.notes_version + 1;
        END IF;
        RETURN NEW;
      END
      $fn$
    $create$, current_schema()); END $do$`
  yield* sql`
    DO $do$ BEGIN EXECUTE format($create$
      CREATE OR REPLACE FUNCTION %1$I.messages_notes_pending() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        INSERT INTO %1$I.messages_shard_pending (message_id, conversation_id, notes_version)
        VALUES (NEW.id, NEW.conversation_id, NEW.notes_version)
        ON CONFLICT (message_id) DO UPDATE SET notes_version = EXCLUDED.notes_version;
        RETURN NULL;
      END
      $fn$
    $create$, current_schema()); END $do$`
  yield* sql`DROP TRIGGER IF EXISTS messages_notes_versioned ON messages`
  yield* sql`
    CREATE TRIGGER messages_notes_versioned BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_notes_versioned()`
  yield* sql`DROP TRIGGER IF EXISTS messages_notes_pending ON messages`
  yield* sql`
    CREATE TRIGGER messages_notes_pending AFTER UPDATE ON messages
    FOR EACH ROW WHEN (NEW.notes_version IS DISTINCT FROM OLD.notes_version)
    EXECUTE FUNCTION messages_notes_pending()`
  yield* sql`
    INSERT INTO messages_shard_pending (message_id, conversation_id, notes_version)
    SELECT id, conversation_id, notes_version FROM messages
    WHERE role IN ('user', 'assistant') AND (summary IS NOT NULL OR phase IS NOT NULL OR arc IS NOT NULL)
    ON CONFLICT (message_id) DO NOTHING`
})
