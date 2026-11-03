// Ages one role row for the deploy smoke (ops/role-age/expire.ts): that row alone, its role untouched, past its life.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "../../worker/test/harness.ts"
import { FRESH_SECONDS } from "../../worker/github/RepoRoles.ts"
import { expire, run } from "./expire.ts"

const runtime = testFile("role_age_script")
const sql = <A extends object>(query: (client: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, query)))

test("ages that person's row on that repository past its life, role untouched; never forward; a held row stays as it is", async () => {
  await sql((client) => client`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at, read_until, read_failed) VALUES
    ('github/a/b', 'p1', 'admin', now(), now() - interval '1 second', false),
    ('github/a/b', 'p2', 'member', now(), NULL, false),
    ('github/a/c', 'p1', 'member', now() - interval '1 day', NULL, false),
    ('github/a/d', 'p1', 'member', now(), now() + interval '1 hour', true)`)
  const aged = await runtime.runPromise(expire("github/a/b", "p1"))
  expect(aged).toMatchObject({ repoId: "github/a/b", state: "aged" })
  expect(aged.ageSeconds!).toBeGreaterThan(FRESH_SECONDS)
  // Already older: it never moves forward.
  expect((await runtime.runPromise(expire("github/a/c", "p1"))).ageSeconds!).toBeGreaterThan(80_000)
  // A live claim or a cooldown stays whole.
  expect(await runtime.runPromise(expire("github/a/d", "p1"))).toEqual({ repoId: "github/a/d", state: "busy", ageSeconds: null })
  const rows = await sql((client) => client<{ repo: string; person: string; role: string; stale: boolean; held: boolean; failed: boolean }>`
    SELECT repo_id AS repo, person_id AS person, role, checked_at < clock_timestamp() - make_interval(secs => ${FRESH_SECONDS}) AS stale,
      read_until > clock_timestamp() AS held, read_failed AS failed FROM github_repo_roles WHERE repo_id <> 'github/a/c' ORDER BY repo_id, person_id`)
  expect(rows).toEqual([
    { repo: "github/a/b", person: "p1", role: "admin", stale: true, held: false, failed: false },
    { repo: "github/a/b", person: "p2", role: "member", stale: false, held: null, failed: false },
    { repo: "github/a/d", person: "p1", role: "member", stale: false, held: true, failed: true },
  ])
  expect(await runtime.runPromise(expire("github/a/b", "nobody"))).toEqual({ repoId: "github/a/b", state: "none", ageSeconds: null })
})

test("the command refuses what it can't act on, one line, and no secret in it", async () => {
  const lines: Array<string> = []
  const io = { out: (line: string) => void lines.push(line), err: (line: string) => void lines.push(line) }
  expect(await run(["--person", "p"], {}, io)).toBe(1)
  expect(await run(["--repo", "a/b"], {}, io)).toBe(1)
  expect(await run(["--repo", "a/b", "--person", "p"], {}, io)).toBe(1)
  expect(await run(["--repo", "a/b", "--person", "p", "--project", "x"], {}, io)).toBe(1)
  expect(await run(["--repo", "a/b", "--person", "p", "--project", "x"], { NEON_API_KEY: "key-secret" }, io)).toBe(1)
  expect(await run(["--repo", "a/b", "--person", "p"], { DATABASE_URL: "postgres://u:hunter2@127.0.0.1:1/x?connect_timeout=1" }, io)).toBe(1)
  expect(lines.slice(0, 5).map((line) => line.split(": ")[1]?.split(" ")[0])).toEqual(["--repo", "--person", "--project", "NEON_API_KEY", "NEON_ORG_ID"])
  expect(lines.join("\n")).not.toContain("hunter2")
}, 30_000)
