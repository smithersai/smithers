import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Bug reports (docs/features/bugs.md): what a person files from the app, and the Admins' bell for it.
//
// - `bug_reports`: one row per report, keyed by the id the browser's flow chose, so filing it again changes nothing.
//   Who filed it (`reporter_id`), their login and role then, and `acted_by`, the kind of run that filed it for them
//   (`agent`, `flow`, `app`, `sandbox`), else null: all from the request's actor, never its body. What happened, in the
//   person's words (1 to 4,000 characters), and what the tab showed: its page, the repository on it, the build, its
//   latest trace ids, run ids and failure codes (JSON arrays), the browser and the window's size. Synced to Admins in
//   person, and to each person for their own reports.
// - `notifications` gains the kind `bug`: a report in an Admin's bell (subject `bug:<id>`), never a toast.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE bug_reports (
      id uuid PRIMARY KEY,
      reporter_id text NOT NULL,
      reporter_login text,
      reporter_role text,
      acted_by text CHECK (acted_by IN ('agent', 'flow', 'app', 'sandbox')),
      what text NOT NULL CHECK (char_length(what) BETWEEN 1 AND 4000),
      route text CHECK (route IS NULL OR char_length(route) <= 2048),
      repo text,
      build text NOT NULL,
      traces jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(traces) = 'array'),
      runs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(runs) = 'array'),
      failures jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(failures) = 'array'),
      browser text NOT NULL,
      viewport text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  // The read route and an Admin's inbox read the newest first; a person's shape reads their own.
  yield* sql`CREATE INDEX bug_reports_created ON bug_reports (created_at DESC)`
  yield* sql`CREATE INDEX bug_reports_reporter ON bug_reports (reporter_id, created_at)`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE bug_reports REPLICA IDENTITY FULL`
  yield* sql`ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check`
  yield* sql`
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('run', 'main', 'release', 'clone', 'spend', 'bug'))`
})
