// Confirms a feed barrier (docs/features/notifications.md#rows-written-before): the deploy owner's word that every
// Worker of releases before the deployed one has drained, so no writer of private feed text is left. It writes one
// `feed_barriers` row, which is also the durable request to run `ops/RedactFeed` as `redact-feed-<id>`: ChatApi's next
// request, or the next `FlowExecution` alarm, claims and starts it. Idempotent: the same barrier again writes nothing
// and says so. It prints what it wrote or found as one JSON line on stdout; a failure, one scrubbed line on stderr.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/feed-barrier/confirm.ts --project <id> --by <name> \
//     [--release <build>] [--id <id>] [--stage prod]
//
// The release is the deployed build, as https://$APP_DOMAIN/version.json names it (the deploy's jj revision,
// dev/build.ts), unless `--release` names one; no git. `--project` is the production database's Neon project id, the
// project named smithers-mvp-ChatPostgres-prod-…: it must be in NEON_ORG_ID and carry the stage's name.
//
// Run from apps/mvp of a checkout at the deployed release, once Cloudflare shows no other Worker version serving. The
// database: DATABASE_URL when set (local development, tests); otherwise production's, read through Neon's API with
// NEON_API_KEY. Exit 0 with the row; 1 with what was wrong.
import { parseArgs } from "node:util"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../database/Connection.ts"
import { refuseUncheckedTls } from "../tls.mjs"

/** A barrier's id: the release's first 12 characters unless named. */
export const idOf = (release: string, id?: string) => (id ?? `r-${release.slice(0, 12)}`).toLowerCase()

/** The row for `id`: written now (`written`), or the one an earlier run wrote (`existing`). */
export const confirm = (barrier: { readonly id: string; readonly release: string; readonly by: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [written] = yield* sql<Row>`
      INSERT INTO feed_barriers (id, release, confirmed_by) VALUES (${barrier.id}, ${barrier.release}, ${barrier.by})
      ON CONFLICT (id) DO NOTHING
      RETURNING ${columns(sql)}`
    if (written !== undefined) return { outcome: "written", ...written }
    const [existing] = yield* sql<Row>`SELECT ${columns(sql)} FROM feed_barriers WHERE id = ${barrier.id}`
    return { outcome: "existing", ...existing! }
  })

interface Row {
  readonly id: string
  readonly release: string
  readonly confirmedBy: string
  readonly confirmedAt: string
  readonly completedAt: string | null
}

const columns = (sql: SqlClient.SqlClient) => sql.literal(
  `id, release, confirmed_by AS "confirmedBy", confirmed_at::text AS "confirmedAt", completed_at::text AS "completedAt"`,
)

/** The name Alchemy gives a stage's database project: `<stack>-ChatPostgres-<stage>-<suffix>` (infra/Postgres.ts). */
export const projectNamePattern = (stage: string) => new RegExp(`^smithers-mvp-ChatPostgres-${stage}-[A-Za-z0-9]+$`)

/**
 * Production's connection URI through Neon's API, as a secret, never printed: for project `project` exactly, after
 * checking it is in organization `orgId` and is the `stage` stage's database project, on its default branch's one
 * database, as its owner.
 */
export const neonUri = async (
  options: { readonly key: string; readonly orgId: string; readonly project: string; readonly stage: string },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Redacted.Redacted<string>> => {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
      headers: { authorization: `Bearer ${options.key}`, accept: "application/json" },
    })
    if (!response.ok) throw new Error(`Neon answered ${response.status} for ${path.split("?")[0]}`)
    return (await response.json()) as Record<string, unknown>
  }
  const { project } = (await get(`/projects/${encodeURIComponent(options.project)}`)) as {
    readonly project: { readonly id: string; readonly name: string; readonly org_id?: string; readonly default_branch_id?: string }
  }
  if (project.org_id !== options.orgId) {
    throw new Error(`project ${options.project} is in organization ${project.org_id ?? "none"}, not NEON_ORG_ID's`)
  }
  if (!projectNamePattern(options.stage).test(project.name)) {
    throw new Error(`project ${options.project} is ${project.name}, not the ${options.stage} stage's database project`)
  }
  const { branches } = (await get(`/projects/${project.id}/branches`)) as {
    readonly branches: ReadonlyArray<{ readonly id: string; readonly default: boolean }>
  }
  const main = branches.filter((branch) => branch.default)
  if (main.length !== 1 || (project.default_branch_id !== undefined && main[0]!.id !== project.default_branch_id)) {
    throw new Error(`project ${options.project} has no single default branch`)
  }
  const { databases } = (await get(`/projects/${project.id}/branches/${main[0]!.id}/databases`)) as {
    readonly databases: ReadonlyArray<{ readonly name: string; readonly owner_name: string }>
  }
  if (databases.length !== 1) throw new Error(`expected one database on the default branch, found ${databases.length}`)
  const database = databases[0]!
  const { uri } = (await get(
    `/projects/${project.id}/connection_uri?branch_id=${encodeURIComponent(main[0]!.id)}` +
      `&database_name=${encodeURIComponent(database.name)}&role_name=${encodeURIComponent(database.owner_name)}`,
  )) as { readonly uri: string }
  return Database.neonConnectionUri(uri)
}

/** The build `https://<domain>/version.json` names: what the deployment serves (dev/build.ts). */
export const deployedBuild = async (domain: string | undefined, fetch: typeof globalThis.fetch = globalThis.fetch) => {
  if (domain === undefined || domain === "") throw new Error("APP_DOMAIN is not set: run under mvp-prod-env, or pass --release")
  const response = await fetch(`https://${domain}/version.json`, { headers: { "cache-control": "no-cache" } })
  if (!response.ok) throw new Error(`https://${domain}/version.json answered ${response.status}`)
  const { build } = (await response.json()) as { readonly build?: unknown }
  if (typeof build !== "string" || !/^[0-9a-f]{12}$/.test(build)) {
    throw new Error(`https://${domain}/version.json names no deployed revision (${JSON.stringify(build)}); pass --release`)
  }
  return build
}

/** `text` with every one of `secrets` in it replaced: nothing a failure says carries a key or a password. */
export const scrub = (text: string, secrets: ReadonlyArray<string>) =>
  [...secrets].filter((secret) => secret.length >= 4).sort((left, right) => right.length - left.length)
    .reduce((scrubbed, secret) => scrubbed.split(secret).join("<redacted>"), text)
    // A connection string's password, whatever else holds it.
    .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1<redacted>@")

/** A connection string's password as written, whatever else the string gets wrong; none when it names none. */
const passwordIn = (text: string): string | undefined => /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:([^@\s]*)@/i.exec(text)?.[1]

/** `text` percent-decoded, or as it is when its escapes are malformed. Never throws. */
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The secrets a run knows, each as written and as decoded: the Neon key, the connection string, and its password.
 * Never throws, however malformed the connection string: a parse failure would carry the string in its message.
 */
export const secretsOf = (env: NodeJS.ProcessEnv, url?: Redacted.Redacted<string>) => {
  const found: Array<string> = []
  for (const value of [env.NEON_API_KEY, env.DATABASE_URL, url === undefined ? undefined : Redacted.value(url)]) {
    if (value === undefined || value === "") continue
    found.push(value, decoded(value))
    const password = passwordIn(value)
    if (password !== undefined && password !== "") found.push(password, decoded(password))
  }
  return found
}

/**
 * An ops command against production's database: `act` runs with its parsed options and a way to read the deployed
 * release, and what it returns prints as one JSON line on `out`; on any failure, one line on `err` beginning `failure`
 * with every secret it knows scrubbed, and 1. Never a stack, a connection string or a key.
 */
export const opsCommand = <A>(
  failure: string,
  act: (
    options: { readonly by: string; readonly release: string | undefined; readonly id: string | undefined },
    release: () => Promise<string>,
  ) => Promise<Effect.Effect<A, unknown, SqlClient.SqlClient>>,
) =>
async (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> => {
  let url: Redacted.Redacted<string> | undefined
  try {
    refuseUncheckedTls(env)
    const { values } = parseArgs({
      args: [...argv],
      options: {
        release: { type: "string" },
        by: { type: "string" },
        id: { type: "string" },
        project: { type: "string" },
        stage: { type: "string", default: "prod" },
      },
    })
    if (values.by === undefined) throw new Error("--by is required")
    url = env.DATABASE_URL !== undefined && env.DATABASE_URL !== ""
      ? Redacted.make(env.DATABASE_URL)
      : await (async () => {
        if (values.project === undefined) throw new Error("--project <Neon project id> is required (the smithers-mvp-ChatPostgres-<stage>-… project)")
        if (env.NEON_API_KEY === undefined || env.NEON_API_KEY === "") throw new Error("NEON_API_KEY is not set: run under mvp-prod-env")
        if (env.NEON_ORG_ID === undefined || env.NEON_ORG_ID === "") throw new Error("NEON_ORG_ID is not set: run under mvp-prod-env")
        return neonUri({ key: env.NEON_API_KEY, orgId: env.NEON_ORG_ID, project: values.project, stage: values.stage! }, fetch)
      })()
    const database = Database.layer(url)
    const work = await act({ by: values.by, release: values.release, id: values.id }, () => deployedBuild(env.APP_DOMAIN, fetch))
    const row = await Effect.runPromise(Effect.scoped(work.pipe(Effect.provide(database))))
    io.out(JSON.stringify(row))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.err(scrub(`${failure}: ${message.split("\n")[0]}`, secretsOf(env, url)))
    return 1
  }
}

/** Runs `command` as the process's own, when `url` is the file node was started with. */
export const asMain = (url: string, failure: string, command: ReturnType<typeof opsCommand>) => {
  if (url !== `file://${process.argv[1]}`) return
  // Anything that escapes the command still prints one scrubbed line and nothing else: never a stack, a key or a password.
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${scrub(`${failure}: ${message.split("\n")[0]}`, secretsOf(process.env))}\n`)
    process.exit(1)
  }
  process.on("uncaughtException", fail)
  process.on("unhandledRejection", fail)
  command(process.argv.slice(2), process.env, { out: (line) => console.log(line), err: (line) => console.error(line) })
    .then((code) => process.exit(code), fail)
}

const FAILURE = "feed barrier not confirmed"

/** The command: confirms the barrier and prints its row. */
export const run = opsCommand(FAILURE, async (options, deployed) => {
  const release = options.release ?? await deployed()
  return confirm({ id: idOf(release, options.id), release, by: options.by })
})

asMain(import.meta.url, FAILURE, run)
