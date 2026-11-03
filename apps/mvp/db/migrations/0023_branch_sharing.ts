import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Sharing a branch, Google Docs style (decision 0013 §2 and §4, docs/features/branch-workspace.md#sharing). A live
// branch is private to its creator (`branches.created_by`) until they share it. `branch_shares` is its permission
// list, one row per grantee:
//
// - a person, by their id (`people.id`, or local development's people), with the login they had when added, and
//   `view` or `edit`;
// - `repository`: anyone in the repository with the link, Members and above only, at `view` or `edit`.
//
// What a person may do is decided at every check from these rows, their role and the branch's mode
// (worker/branch/Access.ts); nothing here is a grant on GitHub. The branches tracked before sharing existed have no
// creator: they stay the team's, open to anyone in the repository with the link to edit, as the default branch is.
// Synced to the branch's owner only.
//
// `terminal_sessions.owner_role` is the owner's role when they opened it, so a change of sharing knows whose terminals
// end with their access. Every terminal opened before this migration was a Member's or above's, so `member` is its
// default; `POST /api/terminals` always names it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE branch_shares (
      branch_id uuid NOT NULL REFERENCES branches (id),
      grantee text NOT NULL CHECK (char_length(grantee) BETWEEN 1 AND 100),
      login text CHECK (char_length(login) BETWEEN 1 AND 100),
      access text NOT NULL CHECK (access IN ('view', 'edit')),
      shared_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (branch_id, grantee),
      CHECK ((grantee = 'repository') = (login IS NULL))
    )`
  yield* sql`
    INSERT INTO branch_shares (branch_id, grantee, access)
    SELECT id, 'repository', 'edit' FROM branches WHERE created_by IS NULL`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE branch_shares REPLICA IDENTITY FULL`
  yield* sql`
    ALTER TABLE terminal_sessions ADD COLUMN owner_role text NOT NULL DEFAULT 'member'
    CHECK (owner_role IN ('admin', 'maintainer', 'member', 'guest'))`
})
