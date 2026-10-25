// The branch workspace's real routes (worker/branch/BranchApi.ts) for the worker tests, on a test file's own schema of
// the compose Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). GitHub is scripted at the
// network, as the model is: a git host that answers the two smart HTTP requests a forge read sends, `GET
// <repo>.git/info/refs?service=git-upload-pack` (protocol v0) and `POST <repo>.git/git-upload-pack` with protocol
// v2's `ls-refs`. The forge is the production one, `Forge.layerConfig`, over Effect's `FetchHttpClient`. Flow starts
// are recorded, and the branch's machine and room are a test `TerminalSockets` and `Rooms`, standing in for the
// Cloudflare Durable Object bindings (worker/BranchSandboxes.ts, worker/BranchRooms.ts). People are found by login in
// the file's `people` and in the harness's `known` people. Every log line, span and metric the routes record is kept.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Effect, Layer, Logger, Metric, Tracer } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { SHARES_TABLE } from "../../src/features/branch/contract.ts"
import { TEXT_UPDATES_TABLE } from "../../src/features/coedit/contract.ts"
import { TERMINALS_TABLE } from "../../src/features/terminal/contract.ts"
import * as Actor from "../Actor.ts"
import * as BranchApi from "../branch/BranchApi.ts"
import * as Conversations from "../branch/Conversations.ts"
import { Forge } from "../branch/Forge.ts"
import type { BranchRoles, Policy } from "../branch/Access.ts"
import { Directory, type Person } from "../branch/People.ts"
import { type Member, RoomUnavailable, Rooms } from "../branch/Rooms.ts"
import { type Attachment, type Revoked, SandboxUnavailable, TerminalSockets } from "../branch/Sandboxes.ts"
import * as Flows from "../Flows.ts"
import { branchRoles, signedIn, type testFile } from "./harness.ts"

type Runtime = ReturnType<typeof testFile>

const encoder = new TextEncoder()

/** One pkt-line: four hex digits of length, counting themselves, then the payload's UTF-8 bytes. */
const pkt = (line: string): Uint8Array => {
  const payload = encoder.encode(line)
  const framed = new Uint8Array(payload.length + 4)
  framed.set(encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), 0)
  framed.set(payload, 4)
  return framed
}

const FLUSH = encoder.encode("0000")

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

/** A 40-hex SHA made from `seed`. */
export const shaOf = (seed: string): string => {
  let hex = ""
  for (let index = 0; hex.length < 40; index++) {
    hex += ((seed.charCodeAt(index % seed.length) * (index + 11)) % 256).toString(16).padStart(2, "0")
  }
  return hex.slice(0, 40)
}

/** A repository on the scripted GitHub: its default branch and each branch's head, by name. */
export interface GitHubRepository {
  readonly defaultBranch: string
  readonly branches: Readonly<Record<string, string>>
  /** A private repository answers only a request that carries a credential; without one, 401, as GitHub does. */
  readonly private?: boolean
}

/** What the scripted GitHub saw of one request. */
export interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly gitProtocol: string | null
  /** For `git-upload-pack`: the ref prefixes `ls-refs` asked for. */
  readonly prefixes: ReadonlyArray<string>
}

/**
 * A scripted GitHub git host on `https://github.com`: repositories by `owner/name` (any case), every request it saw,
 * and a queue of one-shot faults per method (a `Response` to answer instead, or `"throw"` for no answer at all): `GET`
 * is the HEAD read (`info/refs`), `POST` the branch read (`ls-refs`). `hold` keeps every answer back until the function
 * it returns is called.
 */
export const gitHost = () => {
  const repositories = new Map<string, GitHubRepository>()
  const seen: Array<Seen> = []
  const faults = { GET: [] as Array<Response | "throw">, POST: [] as Array<Response | "throw"> }
  let held: Promise<void> | undefined

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.method === "POST" ? new TextDecoder().decode(await request.arrayBuffer()) : ""
    const prefixes = [...body.matchAll(/ref-prefix ([^\n]+)\n/g)].map((match) => match[1]!)
    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      gitProtocol: request.headers.get("git-protocol"),
      prefixes,
    })
    if (held !== undefined) await held
    const fault = faults[request.method === "POST" ? "POST" : "GET"].shift()
    if (fault === "throw") throw new TypeError("fetch failed")
    if (fault !== undefined) return fault
    const route = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname)
    const repository = route === null ? undefined : repositories.get(`${route[1]}/${route[2]}`.toLowerCase())
    if (route === null || repository === undefined) return new Response("Repository not found.", { status: 404 })
    if (repository.private === true && request.headers.get("authorization") === null) {
      return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' } })
    }
    const refs = Object.entries(repository.branches).sort(([a], [b]) => a.localeCompare(b))
    if (route[3] === "info/refs") {
      if (request.method !== "GET" || url.searchParams.get("service") !== "git-upload-pack") {
        return new Response("", { status: 403 })
      }
      const head = repository.branches[repository.defaultBranch]!
      const advertisement = concat([
        pkt("# service=git-upload-pack\n"),
        FLUSH,
        pkt(`${head} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/${repository.defaultBranch} agent=git/github\n`),
        ...refs.map(([name, sha]) => pkt(`${sha} refs/heads/${name}\n`)),
        FLUSH,
      ])
      return new Response(advertisement, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      })
    }
    if (request.headers.get("git-protocol") !== "version=2" || !body.includes("command=ls-refs\n")) {
      return new Response("", { status: 400 })
    }
    const answered = refs.filter(([name]) => prefixes.some((prefix) => `refs/heads/${name}`.startsWith(prefix)))
    return new Response(concat([...answered.map(([name, sha]) => pkt(`${sha} refs/heads/${name}\n`)), FLUSH]), {
      headers: { "content-type": "application/x-git-upload-pack-result" },
    })
  }

  return {
    fetch,
    seen,
    /** Puts `repository` on GitHub as `owner/name`. */
    publish: (owner: string, name: string, repository: GitHubRepository) =>
      void repositories.set(`${owner}/${name}`.toLowerCase(), repository),
    /** The repository GitHub has as `owner/name`, if any. */
    repository: (owner: string, name: string): GitHubRepository | undefined =>
      repositories.get(`${owner}/${name}`.toLowerCase()),
    /** The next `method` requests get these answers, one each, instead of the repository's. */
    fail: (method: "GET" | "POST", ...answers: ReadonlyArray<Response | "throw">) => void faults[method].push(...answers),
    hold: () => {
      let release = () => {}
      held = new Promise<void>((resolve) => (release = resolve))
      return () => {
        held = undefined
        release()
      }
    },
  }
}

export type GitHost = ReturnType<typeof gitHost>

/**
 * Code Storage as a branch's forge sees it, scripted over the git host `github` (a third-party service, scripted like
 * the model): each repository's mirror `github/<owner>/<name>` serves git from GitHub's copy at
 * `https://<org>.code.storage/github/<owner>/<name>.git`, and `POST https://api.<org>.code.storage/api/repos/<repo>/
 * branches/create` makes a branch there at the commit `base_ref` names, as Code Storage does: `409 conflict` when it
 * exists, `404 ref_not_found` for a start it doesn't have, `404 repository_not_found` for no mirror. `fail` answers the
 * next create with a `Response` instead. Every create it took is in `created`. Ephemeral refs live in their own
 * namespace, served at the `+ephemeral` remote, and never alter the GitHub source.
 */
export const codeStorageGit = (github: GitHost) => {
  const ephemeral = gitHost()
  const files = new Map<string, string>()
  const faults: Array<Response> = []
  const created: Array<{ readonly repo: string; readonly from: string; readonly branch: string }> = []
  const problem = (status: number, code: string) => Response.json({ code }, { status })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname.startsWith("api.")) {
      const fileRoute = /^\/api\/repos\/([^/]+)\/file$/.exec(url.pathname)
      if (fileRoute !== null && request.method === "GET") {
        const path = url.searchParams.get("path") ?? ""
        const body = files.get(path)
        return body === undefined
          ? problem(404, "not_found")
          : new Response(body, { headers: { "content-length": String(new TextEncoder().encode(body).length) } })
      }
      const route = /^\/api\/repos\/([^/]+)\/branches\/create$/.exec(url.pathname)
      if (route === null || request.method !== "POST") return problem(404, "route_not_found")
      const fault = faults.shift()
      if (fault !== undefined) return fault
      const repo = decodeURIComponent(route[1]!)
      const { base_ref, target_branch, base_is_ephemeral = false, target_is_ephemeral = false } = (await request.json()) as {
        base_ref: string; target_branch: string; base_is_ephemeral?: boolean; target_is_ephemeral?: boolean
      }
      const [, owner = "", name = ""] = repo.split("/")
      const repository = github.repository(owner, name)
      if (repository === undefined) return problem(404, "repository_not_found")
      const sha = (base_is_ephemeral ? ephemeral.repository(owner, name) : repository)?.branches[base_ref]
      if (sha === undefined) return problem(404, "ref_not_found")
      const target = target_is_ephemeral ? ephemeral : github
      const previous = target.repository(owner, name)
      if (previous?.branches[target_branch] !== undefined) return problem(409, "conflict")
      target.publish(owner, name, { ...repository, branches: { ...(previous?.branches ?? {}), [target_branch]: sha } })
      created.push({ repo, from: base_ref, branch: target_branch })
      return Response.json({ message: "created", target_branch, target_is_ephemeral, commit_sha: sha })
    }
    // The mirror and ephemeral git remotes share commits, with separate advertised refs.
    const mirrored = /^\/github\/([^/]+)\/([^/]+?)(\+ephemeral)?\.git\/(.*)$/.exec(url.pathname)
    if (mirrored === null) return new Response("Repository not found.", { status: 404 })
    const forwarded = new Request(`https://github.com/${mirrored[1]}/${mirrored[2]}.git/${mirrored[4]}${url.search}`, request)
    forwarded.headers.delete("authorization")
    return (mirrored[3] === undefined ? github : ephemeral).fetch(forwarded)
  }
  return { fetch, created, ephemeral, files, fail: (...answers: ReadonlyArray<Response>) => void faults.push(...answers) }
}

/**
 * A branch's machine as the terminal routes reach it: every `attach`, `alive` and `enforce` call, in order. `alive`
 * answers `true` unless set; `enforce` succeeds unless `failing` is set. `attach` answers 200 with the attachment, as
 * the host's 101 can't be a web `Response` here.
 */
export const terminalSockets = () => {
  const state = { alive: true, failing: false }
  const attached: Array<{ readonly branchId: string; readonly attachment: Attachment }> = []
  const checked: Array<{ readonly branchId: string; readonly terminalId: string; readonly ownerId: string }> = []
  const enforced: Array<{ readonly branchId: string; readonly policy: Policy; readonly revoked: ReadonlyArray<Revoked> }> = []
  const service = TerminalSockets.of({
    attach: (branchId, attachment) =>
      Effect.sync(() => {
        attached.push({ branchId, attachment })
        return HttpServerResponse.jsonUnsafe({ attached: attachment })
      }),
    alive: (branchId, terminalId, ownerId) =>
      Effect.sync(() => {
        checked.push({ branchId, terminalId, ownerId })
        return state.alive
      }),
    enforce: (branchId, policy, revoked) =>
      state.failing
        ? Effect.fail(new SandboxUnavailable({ reason: "exec" }))
        : Effect.sync(() => void enforced.push({ branchId, policy, revoked })),
  })
  return {
    service,
    attached,
    checked,
    enforced,
    set alive(value: boolean) {
      state.alive = value
    },
    set failing(value: boolean) {
      state.failing = value
    },
  }
}

/**
 * A branch's room as the routes reach it: every `join` and `enforce` call, in order. `join` answers 200 with the
 * member, as the host's 101 can't be a web `Response` here; `enforce` succeeds unless `failing` is set.
 */
export const rooms = () => {
  const state = { failing: false }
  const joined: Array<{ readonly branchId: string; readonly member: Member }> = []
  const enforced: Array<{ readonly branchId: string; readonly policy: Policy }> = []
  const service = Rooms.of({
    join: (branchId, member) =>
      Effect.sync(() => {
        joined.push({ branchId, member })
        return HttpServerResponse.jsonUnsafe({ joined: member })
      }),
    enforce: (branchId, policy) =>
      state.failing ? Effect.fail(new RoomUnavailable()) : Effect.sync(() => void enforced.push({ branchId, policy })),
  })
  return {
    service,
    joined,
    enforced,
    set failing(value: boolean) {
      state.failing = value
    },
  }
}

export type TestRooms = ReturnType<typeof rooms>

export type Sockets = ReturnType<typeof terminalSockets>

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

interface BranchOptions {
  /** Who is signed in on every request: nobody unless set. */
  readonly actor?: Actor.Actor
  /** Sessions in place of `actor`. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** An injected faulty forge for refusal tests. */
  readonly forge?: Forge["Service"]
  /** The database the routes connect to: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** Where a route starts a remote flow: one that records each start in `starts` unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
  /** The routes' configuration, in place of the environment. */
  readonly config?: Record<string, string>
  /** The scripted GitHub: a fresh one unless set. */
  readonly githubApi?: typeof globalThis.fetch
  readonly github?: GitHost
  /** The branch machines' sockets: a fresh `terminalSockets()` unless set. */
  readonly sockets?: TerminalSockets["Service"]
  /** People who can be found by login beside the file's `people`, as local development's are. */
  readonly known?: ReadonlyArray<Person>
  /** The people directory, in place of the file's `people` and `known`. */
  readonly directory?: Directory["Service"]
  /** Who has which role on a branch's repository: as a deployment without the App gives them unless set. */
  readonly branchRoles?: Layer.Layer<BranchRoles>
}

/** The branch workspace's routes on the file's schema, recording every log line, span, metric and Electric request. */
export const branchHarness = async (runtime: Runtime, options: BranchOptions = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = options.database ?? scratch.database
  const github = options.github ?? gitHost()
  const sockets = terminalSockets()
  const room = rooms()
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((logOptions) => void logs.push(StructuredLogger.formatStructured.log(logOptions)))
  const registry: Metric.MetricRegistry = new Map()
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  /** Every request sent to Electric, as sent, before the table is pointed at the file's schema. */
  const electric: Array<URL> = []
  const forge = codeStorageGit(github)
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "github.com") return github.fetch(input, init)
    if (url.hostname === "api.github.com") return options.githubApi === undefined
      ? Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }))
      : options.githubApi(input, init)
    if (url.hostname.endsWith(".code.storage")) return forge.fetch(input, init)
    electric.push(new URL(url))
    const table = url.searchParams.get("table")
    if (table === "conversation_people" || table === TERMINALS_TABLE || table === SHARES_TABLE || table === TEXT_UPDATES_TABLE) {
      url.searchParams.set("table", `${scratch.name}.${table}`)
    }
    return globalThis.fetch(url, init)
  }
  const config = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl), ...options.config })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    )
  const homeRepository = await runtime.runPromise(observed(Conversations.configuredHomeRepositoryNames))
  const api = await runtime.runPromise(observed(BranchApi.make(database).pipe(
    Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch),
  )))
  const capturedForge = options.forge ?? await runtime.runPromise(observed(Effect.service(Forge).pipe(
    Effect.provide(Forge.layerConfig), Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch),
  )))
  const starter = options.starter ?? Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) =>
      Effect.sync(() => void starts.push({ flow: flow._tag, executionId, payload })),
  })
  const handler = HttpEffect.toWebHandler(
    observed(
      api.fetch.pipe(
        // Alchemy's deployed request environment contains no deployment Config values.
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        Effect.provideService(Conversations.homeRepositoryNames, homeRepository),
        Effect.provideService(Flows.FlowStarter, starter),
        Effect.provideService(TerminalSockets, options.sockets ?? sockets.service),
        Effect.provideService(Rooms, room.service),
        options.directory === undefined
          ? Effect.provide(Directory.layer(database, options.known))
          : Effect.provideService(Directory, options.directory),
        Effect.provide(options.sessions ?? (options.actor === undefined ? Actor.signedOut : signedIn(options.actor))),
        Effect.provide(options.branchRoles ?? branchRoles(database)),
        Effect.provideService(Forge, capturedForge),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ),
  )
  const line = (message: string) => logs.filter((log) => log.message === message)
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    github,
    /** The scripted Code Storage over `github`, the forge when `config` names an organization and a key. */
    forge,
    sockets,
    rooms: room,
    starts,
    electric,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count,
    snapshot: () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
    line,
    /** The one line logged with this message. */
    only: (message: string) => {
      const lines = line(message)
      if (lines.length !== 1) throw new Error(`expected one ${message} line, got ${lines.length}`)
      return lines[0]!
    },
    span: (name: string) => spans.filter((span) => span.name === name),
    spans,
    logs,
  }
}

export type BranchHarness = Awaited<ReturnType<typeof branchHarness>>

/**
 * Empties the branch workspace's tables but the home branch and its conversation, which 0014_branch_workspace made and
 * every ask that names no conversation needs. Runs after `testFile`'s own `beforeEach`, which empties messages and views.
 */
export const resetBranches = (runtime: Runtime) =>
  runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const home = yield* Conversations.home
    yield* sql`DELETE FROM github_branch_requests`
    yield* sql`DELETE FROM conversation_people`
    yield* sql`DELETE FROM terminal_sessions`
    yield* sql`DELETE FROM sandbox_calls`
    // The sandbox ledger and limits (worker/branch/Budget.ts): every test's machines start under the defaults.
    yield* sql`DELETE FROM sandbox_generations`
    yield* sql`DELETE FROM sandbox_limits`
    yield* sql`DELETE FROM text_updates`
    yield* sql`DELETE FROM branch_shares WHERE branch_id NOT IN (SELECT branch_id FROM conversations WHERE id = ${home!})`
    yield* sql`DELETE FROM conversations WHERE id <> ${home!}`
    yield* sql`DELETE FROM branches WHERE id NOT IN (SELECT branch_id FROM conversations)`
  }))

/**
 * Records branch `name` of `repo` with its conversation, as `POST /api/branches` does: its ids. With `owner`, it is
 * theirs, private until they share it; without, it is the team's, open to anyone in the repository with the link.
 */
export const tracked = (
  runtime: Runtime,
  repo: string,
  name: string,
  mode: "locked" | "open" | "restricted" = "open",
  owner?: string,
) =>
  runtime.runPromise(
    Effect.map(Conversations.track(repo, name, mode, shaOf(`${repo}:${name}`), owner), (result) => result.branch),
  )

/** Shares branch `branchId` with `grantee` (a person's id, or `repository`) to `access`, as its owner would. */
export const shared = (runtime: Runtime, branchId: string, grantee: string, access: "view" | "edit", login?: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO branch_shares (branch_id, grantee, login, access)
      VALUES (${branchId}, ${grantee}, ${grantee === "repository" ? null : login ?? grantee}, ${access})
      ON CONFLICT (branch_id, grantee) DO UPDATE SET access = EXCLUDED.access`))

/** A terminal's row as Postgres holds it. */
export interface TerminalRow {
  readonly id: string
  readonly branchId: string
  readonly ownerId: string
  readonly ownerLogin: string
  readonly status: string
  readonly generation: string | null
  readonly failure: string | null
  readonly endedReason: string | null
  readonly ended: boolean
}

/** Every terminal of branch `branchId`, oldest first. */
export const terminalRows = (runtime: Runtime, branchId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<TerminalRow>`
      SELECT id, branch_id AS "branchId", owner_id AS "ownerId", owner_login AS "ownerLogin", status,
        generation::text AS generation, failure, ended_reason AS "endedReason", ended_at IS NOT NULL AS ended
      FROM terminal_sessions WHERE branch_id = ${branchId} ORDER BY created_at, id`))

/** Inserts terminal `id` of `ownerId` on `branchId` as it stands after an open: `status`, created `ageSeconds` ago. */
export const terminal = (
  runtime: Runtime,
  row: {
    readonly id: string
    readonly branchId: string
    readonly ownerId: string
    readonly status: "opening" | "open" | "ended" | "failed"
    readonly ageSeconds?: number
    readonly ownerRole?: "admin" | "maintainer" | "member" | "guest"
  },
) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, owner_role, status, generation, ended_reason,
        failure, created_at)
      VALUES (${row.id}, ${row.branchId}, ${row.ownerId}, ${row.ownerId}, ${row.ownerRole ?? "member"}, ${row.status},
        ${row.status === "open" ? 1 : null}, ${row.status === "ended" ? "closed" : null},
        ${row.status === "failed" ? "unavailable" : null}, now() - make_interval(secs => ${row.ageSeconds ?? 0}))`))
