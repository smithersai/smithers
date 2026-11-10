// Issues an agent's machine token (docs/features/machine-tokens.md). The operator's path: it runs under the deployment's
// production credentials and writes one `machine_tokens` row, the token's digest with its agent, lane, repository, scope
// and end. No person signs anything, and that is acceptable because this operator can already write this database: the
// command gives them no power they lack, while a token it makes can do only the acts in its scope, for 7 days at most.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/machine-token/issue.ts --project <neon id> --by <name> \
//     --repo <owner>/<name> --agent <agent> --lane <lane> --out <file> [--scope issue/create,issue/comment,...] [--days 7]
//     [--revoke <digest>] [--stage prod]
//
// The raw token goes to `--out`, created mode 600, and never to argv, stdout or a log. One audit JSON line goes to stdout
// with the digest and everything else the row holds. The database: DATABASE_URL when set; else production's, through
// Neon's API, as ops/feed-barrier/confirm.ts reads it.
import { digestSync } from "@smthrs/crypto"
import { repoId } from "../../src/features/repo/contract.ts"
import { randomBytes } from "node:crypto"
import { closeSync, constants, openSync, writeSync } from "node:fs"
import { parseArgs } from "node:util"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../../db/Database.ts"
import { neonUri, scrub } from "../feed-barrier/confirm.ts"
import { refuseUncheckedTls } from "../tls.mjs"

const PREFIX = "smm_"
const SCOPES = ["issue/create", "issue/update", "issue/comment", "issue/relate", "work/link"]
export const MAX_DAYS = 7

/** A new token: `smm_` and 32 random bytes. */
export const newToken = (random: (size: number) => Uint8Array = randomBytes) => `${PREFIX}${Buffer.from(random(32)).toString("base64url")}`

/** The row a request asks for, or what is wrong with it. */
export const requestOf = (values: {
  readonly repo?: string | undefined
  readonly agent?: string | undefined
  readonly lane?: string | undefined
  readonly by?: string | undefined
  readonly scope?: string | undefined
  readonly days?: string | undefined
}) => {
  if (values.repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error("--repo <owner>/<name> is required")
  // No `/` in an agent or a lane: a work link's source is `machine:<agent>/<lane>`, and it must name one pair.
  for (const [name, value] of [["agent", values.agent], ["lane", values.lane]] as const) {
    if (value === undefined || !/^[\w.:-]{1,100}$/.test(value)) throw new Error(`--${name} is required: letters, digits and . : - _`)
  }
  if (values.by === undefined || !/^[\w.:/-]{1,100}$/.test(values.by)) throw new Error("--by is required: letters, digits and . : / - _")
  const scope = (values.scope ?? SCOPES.join(",")).split(",")
  for (const act of scope) if (!SCOPES.includes(act)) throw new Error(`--scope names ${act}; a machine may hold ${SCOPES.join(", ")}`)
  const days = Number(values.days ?? MAX_DAYS)
  if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) throw new Error(`--days is above 0 and at most ${MAX_DAYS}`)
  const [owner, name] = values.repo.split("/") as [string, string]
  // The id the routes look a repository up by, lowercased: a token issued for `Acme/Widgets` must match it.
  return { repoId: repoId(owner, name), agent: values.agent!, lane: values.lane!, by: values.by!, scope, days }
}

/** Writes the token's digest and answers the audit line. The token itself never leaves `token`'s caller. */
export const issue = (token: string, request: ReturnType<typeof requestOf>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const digest = digestSync(token)
    const [row] = yield* sql<{ readonly expiresAt: string }>`
      INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at)
      VALUES (${digest}, ${request.repoId}, ${request.agent}, ${request.lane}, ${sql.literal(`ARRAY[${request.scope.map((act) => `'${act}'`).join(",")}]::text[]`)},
        ${request.by}, now() + make_interval(days => ${request.days}))
      RETURNING expires_at::text AS "expiresAt"`
    return { event: "machine_token.issued", digest, repo: request.repoId, agent: request.agent, lane: request.lane, scope: request.scope, by: request.by, expiresAt: row!.expiresAt }
  })

/** Ends a token at once, by its digest. */
export const revoke = (digest: string, by: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly agent: string }>`
      UPDATE machine_tokens SET revoked_at = now() WHERE token_sha256 = ${digest} AND revoked_at IS NULL RETURNING agent`
    return { event: "machine_token.revoked", digest, by, revoked: rows.length }
  })

/** Creates `path` mode 600 with `token`, refusing a file already there. */
export const writeToken = (path: string, token: string) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, `${token}\n`)
  } finally {
    closeSync(fd)
  }
}

const main = async () => {
  refuseUncheckedTls(process.env)
  const { values } = parseArgs({
    options: {
      project: { type: "string" }, by: { type: "string" }, repo: { type: "string" }, agent: { type: "string" }, lane: { type: "string" },
      out: { type: "string" }, scope: { type: "string" }, days: { type: "string" }, revoke: { type: "string" }, stage: { type: "string", default: "prod" },
    },
  })
  const key = process.env.NEON_API_KEY ?? ""
  const uri = process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== ""
    ? Redacted.make(process.env.DATABASE_URL)
    : await neonUri({ key, orgId: process.env.NEON_ORG_ID ?? "", project: values.project ?? "", stage: values.stage! })
  const layer = Database.layer(Effect.succeed(uri))
  try {
    if (values.revoke !== undefined) {
      if (values.by === undefined) throw new Error("--by is required")
      console.log(JSON.stringify(await Effect.runPromise(revoke(values.revoke, values.by).pipe(Effect.provide(layer)))))
      return
    }
    const request = requestOf(values)
    if (values.out === undefined) throw new Error("--out <file> is required: the token goes there, mode 600")
    const token = newToken()
    // The file first: a token no one holds is a row that opens nothing, and a failed write leaves no row.
    writeToken(values.out, token)
    console.log(JSON.stringify(await Effect.runPromise(issue(token, request).pipe(Effect.provide(layer)))))
  } catch (error) {
    console.error(scrub(error instanceof Error ? error.message : String(error), [key, Redacted.value(uri)]))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
