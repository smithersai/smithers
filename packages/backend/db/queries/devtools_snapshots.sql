-- Ticket 0107: devtools snapshot surface queries.
--
-- Write path: guest-agent -> plue host -> UpsertDevtoolsSnapshot. The UPSERT
-- shape enforces the "latest-per-kind" retention policy at the SQL level so
-- the service layer never has to race a DELETE + INSERT against concurrent
-- writers on the same (session_id, kind).
--
-- Read path: the realtime stream `devtools_snapshots` is the production
-- reader. Server-side reads are admin/debug helpers only.

-- name: UpsertDevtoolsSnapshot :one
-- Insert-or-replace a snapshot for (session_id, kind). The ON CONFLICT
-- clause keys off the composite PRIMARY KEY and atomically replaces the
-- payload + timestamp. Latest-per-kind is a schema invariant; callers
-- cannot accidentally produce a second row for the same pair.
INSERT INTO devtools_snapshots (
    session_id, repository_id, kind, payload, timestamp
)
VALUES (
    $1, $2, $3, $4, NOW()
)
ON CONFLICT (session_id, kind) DO UPDATE
SET payload       = EXCLUDED.payload,
    -- repository_id is derived from the session context on the server, so
    -- it should never change for a given session_id. Update it defensively
    -- in case of a schema-level migration or a recovered session rebind.
    repository_id = EXCLUDED.repository_id,
    timestamp     = NOW()
RETURNING *;

-- name: GetDevtoolsSnapshot :one
-- Admin/debug helper: fetch the current snapshot for a (session, kind) pair.
-- Does NOT filter on repository_id; the caller is expected to enforce repo
-- scoping using the row's repository_id value.
SELECT * FROM devtools_snapshots
WHERE session_id = $1 AND kind = $2;

-- name: ListDevtoolsSnapshotsBySession :many
-- Admin/debug helper: list every current snapshot kind for a session. Not on
-- the hot path — realtime stream is the production read path for clients.
SELECT * FROM devtools_snapshots
WHERE repository_id = $1 AND session_id = $2
ORDER BY kind;
