import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Decision 0009's `runs`, as decision 0015 first needs it (docs/features/agent-status.md#the-runs-table): one row per
// agent run, keyed by its execution id (an answer's id for chat/Answer), holding the status the run reports from its own
// steps and its latest question. `launched_by` is the asker; only they may write or answer the row, and the shape syncs
// only their rows, without the column. `wait` and `answer` stay after the question closes, so the conversation shows
// what was answered; `version` counts the run's questions, so an answer names the one it answers.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE runs (
      id uuid PRIMARY KEY,
      flow text NOT NULL,
      status text NOT NULL CHECK (status IN ('working', 'waiting', 'needs_you', 'failed', 'done')),
      waiting text CHECK (waiting IN ('turn', 'input', 'approval')),
      wait jsonb CHECK (wait IS NULL OR jsonb_typeof(wait) = 'object'),
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      answer jsonb CHECK (answer IS NULL OR jsonb_typeof(answer) = 'object'),
      answered_at timestamptz,
      launched_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((status IN ('waiting', 'needs_you')) = (waiting IS NOT NULL)),
      CHECK (status <> 'needs_you' OR wait IS NOT NULL),
      CHECK ((answer IS NULL) = (answered_at IS NULL))
    )`
  // The shape reads one person's rows.
  yield* sql`CREATE INDEX runs_launched_by ON runs (launched_by)`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE runs REPLICA IDENTITY FULL`
})
