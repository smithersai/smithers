// DO NOT RUN THIS YET: it doesn't establish the cutoff it assumes (Codex Astra's review of 375dbf14, decision 0148):
//
// 1. Its check doesn't bind each Worker to the release, or prove Durable Objects drained: an old reader or writer can
//    outlive it.
// 2. Admitted intents in Durable Object storage, not yet in Postgres, and writes concurrent with it escape its checks.
// 3. Overflow containers keep cached credentials: marking an overflow revokes nothing they already hold.
//
// Finishing it needs real admission-generation machinery; the git-credential route stays off until then.
//
// The runner cutover (decision 0148, docs/features/agent-runners.md#turning-the-route-on): meant to run once, by the
// deploy owner, before the git-credential route is turned on. Until then nothing it does applies.
//
// Registrations and settings written before the fenced release can't be told apart from good ones, so none is kept. The
// command checks that only the fenced release can be writing or reading them, then, in one transaction, clears every
// runner's authorization and marks every agent and overflow for reconfirmation. Each counts again once an Admin writes
// it through the fenced route.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/runner-cutover/cutover.ts --project <id> --by <name> \
//     --release <build> --worker <script> [--worker <script>]... [--stage prod]
//
// It refuses unless, for every `--worker`, Cloudflare's newest deployment serves one version at 100%, and
// https://$APP_DOMAIN/version.json names `--release`; and it refuses, changing nothing, while any job is queued or
// claimed, or any TODO or Admin flow hasn't ended: each could hold a decision read from the old settings. Stop or wait
// for those and run it again. Afterwards it checks all of that once more, for what started during the transaction.
// Prints one JSON line; a failure, one scrubbed line. Rolling back to a release before the fence undoes its premise: run
// it again after any such rollback.
import { parseArgs } from "node:util"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../../db/Database.ts"
import { deployedBuild, neonUri, scrub, secretsOf } from "../feed-barrier/confirm.ts"

/** The schema the flow engine keeps its runs in: `ExecutionHost.ENGINE_SCHEMA`, whose module needs a Worker to load. */
export const ENGINE_SCHEMA = "smithers_flows"

/** How long the cutover waits for a lock: a long transaction on these tables fails it, rather than queueing the routes. */
const LOCK_TIMEOUT = "5s"

/** The longest one of its statements runs. */
const STATEMENT_TIMEOUT = "60s"

/** What is still in flight that could hold a decision read from the old settings. */
export const blockers = (engineSchema: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const jobs = yield* sql<{ readonly key: string }>`
      SELECT key FROM agent_jobs WHERE status IN ('queued', 'claimed') ORDER BY key`
    const runs = yield* sql<{ readonly runId: string }>`
      SELECT run_id AS "runId" FROM ${sql.literal(`"${engineSchema}"`)}.flows_runs
      WHERE status NOT IN ('completed', 'failed', 'cancelled')
        AND (run_id LIKE 'todo%' OR run_id LIKE 'runners-%' OR run_id LIKE 'agents-%' OR run_id LIKE 'overflow-%')
      ORDER BY run_id`
    return { jobs: jobs.map((row) => row.key), runs: runs.map((row) => row.runId) }
  })

/** One transaction: refused while anything is in flight (`blockers`); else clears and marks everything (above). */
export const cutover = (engineSchema: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`
      const inFlight = yield* blockers(engineSchema)
      if (inFlight.jobs.length > 0 || inFlight.runs.length > 0) return { outcome: "blocked" as const, ...inFlight }
      const runners = yield* sql`UPDATE runners SET repo_authorized_at = NULL WHERE repo_authorized_at IS NOT NULL RETURNING id`
      const agents = yield* sql`UPDATE agents SET reconfirm_at = now() RETURNING name`
      const overflow = yield* sql`UPDATE repo_overflow SET reconfirm_at = now() RETURNING repo_id`
      return { outcome: "cut" as const, runners: runners.length, agents: agents.length, overflow: overflow.length }
    })))

/**
 * The one version each of `workers` serves, by name: refused when Cloudflare's newest deployment of any serves more
 * than one, or serves one at less than 100%.
 */
export const servingOneVersion = async (
  options: { readonly token: string; readonly account: string; readonly workers: ReadonlyArray<string> },
  fetch: typeof globalThis.fetch = globalThis.fetch,
) => {
  const serving: Record<string, string> = {}
  for (const worker of options.workers) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.account)}/workers/scripts/${encodeURIComponent(worker)}/deployments`,
      { headers: { authorization: `Bearer ${options.token}`, accept: "application/json" } },
    )
    if (!response.ok) throw new Error(`Cloudflare answered ${response.status} for ${worker}'s deployments`)
    const { result } = (await response.json()) as {
      readonly result: { readonly deployments: ReadonlyArray<{ readonly versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }> }> }
    }
    const versions = result.deployments[0]?.versions ?? []
    if (versions.length !== 1 || versions[0]!.percentage !== 100) {
      throw new Error(`${worker} serves ${versions.length} versions: wait until one serves all of its traffic`)
    }
    serving[worker] = versions[0]!.version_id
  }
  return serving
}

/** The command (above): exit 0 with its result as one JSON line; 1 with one scrubbed line. */
export const run = async (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> => {
  let url: Redacted.Redacted<string> | undefined
  const secrets = () => [...secretsOf(env, url), ...(env.CLOUDFLARE_API_TOKEN === undefined ? [] : [env.CLOUDFLARE_API_TOKEN])]
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        release: { type: "string" },
        by: { type: "string" },
        worker: { type: "string", multiple: true },
        project: { type: "string" },
        stage: { type: "string", default: "prod" },
      },
    })
    if (values.by === undefined) throw new Error("--by is required")
    if (values.release === undefined) throw new Error("--release <the fenced build> is required")
    if (values.worker === undefined || values.worker.length === 0) throw new Error("--worker <script> is required")
    if (env.CLOUDFLARE_API_TOKEN === undefined || env.CLOUDFLARE_ACCOUNT_ID === undefined) {
      throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required: run under mvp-prod-env")
    }
    const options = { token: env.CLOUDFLARE_API_TOKEN, account: env.CLOUDFLARE_ACCOUNT_ID, workers: values.worker }
    const check = async () => {
      const deployed = await deployedBuild(env.APP_DOMAIN, fetch)
      if (deployed !== values.release) throw new Error(`the deployment serves ${deployed}, not ${values.release}`)
      return servingOneVersion(options, fetch)
    }
    const serving = await check()
    url = env.DATABASE_URL !== undefined && env.DATABASE_URL !== ""
      ? Redacted.make(env.DATABASE_URL)
      : await (async () => {
        if (values.project === undefined) throw new Error("--project <Neon project id> is required")
        if (env.NEON_API_KEY === undefined || env.NEON_ORG_ID === undefined) throw new Error("NEON_API_KEY and NEON_ORG_ID are required: run under mvp-prod-env")
        return neonUri({ key: env.NEON_API_KEY, orgId: env.NEON_ORG_ID, project: values.project, stage: values.stage! }, fetch)
      })()
    const database = Database.layer(Effect.succeed(url))
    const result = await Effect.runPromise(Effect.scoped(cutover(ENGINE_SCHEMA).pipe(Effect.provide(database))))
    if (result.outcome === "blocked") {
      io.out(JSON.stringify(result))
      return 1
    }
    // What started while it ran: a deploy, a TODO. It holds settings read before the cut, so the cut must run again.
    const after = await check()
    const raced = await Effect.runPromise(Effect.scoped(blockers(ENGINE_SCHEMA).pipe(Effect.provide(database))))
    const clean = JSON.stringify(after) === JSON.stringify(serving) && raced.jobs.length === 0 && raced.runs.length === 0
    io.out(JSON.stringify({ ...result, by: values.by, release: values.release, serving, ...(clean ? {} : { rerun: raced }) }))
    return clean ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.err(scrub(`runner cutover not done: ${message.split("\n")[0]}`, secrets()))
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${scrub(`runner cutover not done: ${message.split("\n")[0]}`, secretsOf(process.env))}\n`)
    process.exit(1)
  }
  process.on("uncaughtException", fail)
  process.on("unhandledRejection", fail)
  run(process.argv.slice(2), process.env, { out: (line) => console.log(line), err: (line) => console.error(line) })
    .then((code) => process.exit(code), fail)
}
