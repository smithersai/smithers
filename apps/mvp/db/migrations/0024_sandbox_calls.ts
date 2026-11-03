import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The branch sandbox tools (decision 0005 §5, docs/features/sandbox-tools.md): one row per tool call on a branch's
// machine, from a person's slash command, the agent or the API alike. `POST /api/sandbox/calls` inserts it `running`
// for the person who asked (`person_id`, from their session; `answer_id` when the agent called it in that person's
// answer), and the remote `sandbox/Call` settles it once: `done` with the tool's `result`, or `failed` with why. The
// call's id is the client's, so a resend after a crash or a closed tab finds the same row and starts nothing new.
//
// `result` is content (a command's output, a file's text): stored for the person who asked, never logged. Not synced.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE sandbox_calls (
      id uuid PRIMARY KEY,
      branch_id uuid NOT NULL REFERENCES branches (id),
      person_id text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 100),
      answer_id uuid,
      tool text NOT NULL CHECK (tool IN ('run', 'read', 'write', 'list', 'status', 'diff')),
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
      failure text CHECK (failure IN (
        'unavailable', 'checkout', 'lost', 'path', 'not_found', 'not_a_file', 'not_a_directory', 'not_a_repository',
        'too_large'
      )),
      result jsonb,
      generation bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      CHECK ((status = 'running') = (settled_at IS NULL)),
      CHECK ((status = 'failed') = (failure IS NOT NULL)),
      CHECK ((status = 'done') = (result IS NOT NULL))
    )`
  // A branch's calls, newest first, and whether any still runs (sandbox/Keep).
  yield* sql`CREATE INDEX sandbox_calls_branch ON sandbox_calls (branch_id, created_at)`
})
