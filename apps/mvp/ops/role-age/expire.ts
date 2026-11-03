// Ages one person's role row past its life, so the next read must ask GitHub again: how the deploy smoke
// (e2e/cold-path.spec.ts) opens the cold path without waiting five minutes. One row of one person on one repository, and
// only `checked_at` moves, and only back: the row's role is untouched, a stale row decides nothing (a read renews it), so
// nobody gains or loses access. A row a read holds, or a cooldown protects, is left as it is and answered `busy`. It
// prints the row's repository and state as one JSON line; a failure, one scrubbed line on stderr.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/role-age/expire.ts --project <id> --repo <owner/name> --person <id>
//
// The database: DATABASE_URL when set (local development, tests); otherwise production's through Neon's API, as
// ops/feed-barrier/confirm.ts finds it.
import { parseArgs } from "node:util"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../../db/Database.ts"
import { neonUri, scrub, secretsOf } from "../feed-barrier/confirm.ts"

/**
 * How old the row becomes: past worker/github/RepoRoles.ts's five minute life. Its number is written out because importing
 * it loads the worker, whose app imports plain node can't resolve; expire.test.ts fails if the life outgrows this.
 */
const AGED_SECONDS = 6 * 60

/** What aging found: `aged`, past its life; `busy`, a claim or a cooldown holds it, untouched; `none`, no row, as cold. */
export type Aged = { readonly repoId: string; readonly state: "aged" | "busy" | "none"; readonly ageSeconds: number | null }

/** Ages `personId`'s row on `repoId`, in one statement, unless a read's claim or a cooldown holds it. */
export const expire = (repoId: string, personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly state: "aged" | "busy"; readonly ageSeconds: number }>`
      WITH found AS (SELECT repo_id, person_id, read_until IS NOT NULL AND read_until > clock_timestamp() AS held FROM github_repo_roles
        WHERE repo_id = ${repoId} AND person_id = ${personId} FOR UPDATE),
      aged AS (UPDATE github_repo_roles r
        SET checked_at = LEAST(r.checked_at, clock_timestamp() - make_interval(secs => ${AGED_SECONDS}))
        FROM found WHERE r.repo_id = found.repo_id AND r.person_id = found.person_id AND NOT found.held
        RETURNING r.checked_at)
      SELECT CASE WHEN found.held THEN 'busy' ELSE 'aged' END AS state,
        coalesce(extract(epoch FROM clock_timestamp() - (SELECT checked_at FROM aged))::int, 0) AS "ageSeconds" FROM found`
    return row === undefined
      ? { repoId, state: "none", ageSeconds: null } satisfies Aged
      : { repoId, state: row.state, ageSeconds: row.state === "aged" ? row.ageSeconds : null } satisfies Aged
  })

/** The command. Exit 0 with the line; 1 with what was wrong. */
export const run = async (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> => {
  let url: Redacted.Redacted<string> | undefined
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        person: { type: "string" },
        project: { type: "string" },
        stage: { type: "string", default: "prod" },
      },
    })
    if (values.repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(values.repo)) throw new Error("--repo <owner/name> is required")
    if (values.person === undefined) throw new Error("--person <id> is required")
    url = env.DATABASE_URL !== undefined && env.DATABASE_URL !== ""
      ? Redacted.make(env.DATABASE_URL)
      : await (async () => {
        if (values.project === undefined) throw new Error("--project <Neon project id> is required")
        if (env.NEON_API_KEY === undefined || env.NEON_API_KEY === "") throw new Error("NEON_API_KEY is not set: run under mvp-prod-env")
        if (env.NEON_ORG_ID === undefined || env.NEON_ORG_ID === "") throw new Error("NEON_ORG_ID is not set: run under mvp-prod-env")
        return neonUri({ key: env.NEON_API_KEY, orgId: env.NEON_ORG_ID, project: values.project, stage: values.stage! }, fetch)
      })()
    const row = await Effect.runPromise(Effect.scoped(
      expire(`github/${values.repo}`, values.person).pipe(Effect.provide(Database.layer(Effect.succeed(url)))),
    ))
    io.out(JSON.stringify(row))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.err(scrub(`role row not aged: ${message.split("\n")[0]}`, secretsOf(env, url)))
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), process.env, { out: (line) => console.log(line), err: (line) => console.error(line) })
    .then((code) => process.exit(code), () => process.exit(1))
}
