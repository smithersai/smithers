import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Decision 0009's first slice (docs/features/notifications.md#postgres): the run index gains its scope, and two tables
// hold who follows what and each person's feed.
//
// - `runs.conversation_id`, `branch_id`, `repo_id`: where a run works. In this slice every run is an agent's answer, so
//   its scope is its answer's conversation and that conversation's branch. Rows written before this migration take it
//   from their answer.
// - `watches`: who follows a branch or a repository (`branch:<id>`, `repo:<id>`), and how closely: `attention`, the
//   default, `all` or `muted` (0009 decision 8). A person watches the branch and the repository of every conversation
//   their tab shows. Not synced.
// - `notifications`: one row per person per subject (`run:<id>`, `main:<repo id>`, `release:<repo id>:<tag>`), written
//   in the same transaction as the run report or the GitHub delivery it comes from. `version` goes up when the row needs
//   attention again; `read_version`, `dismissed_version` and `hidden_version` are the versions the person's acts reached,
//   merged with `greatest()`, so two devices never conflict. `mine` marks the person's own run; `quiet` a row that is a
//   toast while it lives and never a feed entry: someone else's run on a branch the person watches. `occurred_at` orders
//   a repository's events, so a late delivery never rolls `main` back. Synced to the recipient only.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE runs ADD COLUMN conversation_id uuid`
  yield* sql`ALTER TABLE runs ADD COLUMN branch_id uuid`
  yield* sql`ALTER TABLE runs ADD COLUMN repo_id text`
  yield* sql`
    UPDATE runs r SET conversation_id = m.conversation_id, branch_id = c.branch_id, repo_id = c.repo_id
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = r.id`
  // The fold reads a branch's runs; the shape of a branch's runs comes later (0009 §3).
  yield* sql`CREATE INDEX runs_branch ON runs (branch_id)`
  yield* sql`
    CREATE TABLE watches (
      principal_id text NOT NULL,
      subject text NOT NULL CHECK (subject ~ '^(branch|repo):\\S+$' AND char_length(subject) <= 320),
      level text NOT NULL DEFAULT 'attention' CHECK (level IN ('all', 'attention', 'muted')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (principal_id, subject)
    )`
  // Routing reads a subject's watchers.
  yield* sql`CREATE INDEX watches_subject ON watches (subject)`
  yield* sql`
    CREATE TABLE notifications (
      recipient text NOT NULL,
      subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 400),
      kind text NOT NULL CHECK (kind IN ('run', 'main', 'release')),
      state text NOT NULL CHECK (state IN ('working', 'waiting', 'needs_you', 'failed', 'done', 'update')),
      mine boolean NOT NULL DEFAULT false,
      quiet boolean NOT NULL DEFAULT false,
      run_id uuid,
      repo_id text,
      conversation_id uuid,
      actor text CHECK (char_length(actor) <= 100),
      title text CHECK (char_length(title) <= 200),
      ref text CHECK (char_length(ref) <= 255),
      href text NOT NULL CHECK (href ~ '^/' AND char_length(href) <= 600),
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      read_version integer NOT NULL DEFAULT 0,
      dismissed_version integer NOT NULL DEFAULT 0,
      hidden_version integer NOT NULL DEFAULT 0,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (recipient, subject),
      CHECK ((kind = 'run') = (run_id IS NOT NULL)),
      CHECK ((kind = 'run') = (state <> 'update')),
      CHECK (read_version BETWEEN 0 AND version),
      CHECK (dismissed_version BETWEEN 0 AND version),
      CHECK (hidden_version BETWEEN 0 AND version)
    )`
  // The shape reads one person's rows; the fold reads one run's.
  yield* sql`CREATE INDEX notifications_run ON notifications (run_id) WHERE run_id IS NOT NULL`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE notifications REPLICA IDENTITY FULL`
})
