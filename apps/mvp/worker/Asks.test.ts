// An agent asks a person (worker/Asks.ts, worker/Runs.ts, docs/features/agent-status.md#addressed-waits): the asks
// routes with a real machine token, ChatApi's real runs routes and shape through the compose Electric, and `queue/ask`
// on the Durable Object's handlers (worker/test/executions.ts) over a fresh engine schema, all on this file's schema of
// the compose Postgres. Roles come from the real `RepoRoles` as local development builds it, so the session's role
// holds; a role that can't be read, a host that can't take an answer and Postgres down are injected faulty services.
import { digestSync } from "@smthrs/crypto"
import { FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Layer, Logger, Metric, Stream } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import type { Actor } from "./Actor.ts"
import * as Asks from "./Asks.ts"
import { DEV_ASK_TOKEN } from "./AsksDev.ts"
import { BranchRoles } from "./branch/Access.ts"
import { Directory } from "./branch/People.ts"
import * as Flows from "./Flows.ts"
import * as Ask from "./flows/Ask.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { rowIdOf } from "./RepoRuns.ts"
import * as Runs from "./Runs.ts"
import { engineSchema, executions } from "./test/executions.ts"
import { eventually, harness, signedIn, testFile } from "./test/harness.ts"

const runtime = testFile("asks")

beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM machine_tokens`)))

/** The question's words, an option and the answer: sentinels no record may carry. */
const PROMPT = "prompt-sentinel-2e9a: merge the docs preview?"
const OPTION = "option-sentinel-b7"
const ANSWER = "answer-sentinel-c3f0"

const scratch = () => runtime.runPromise(Effect.service(TestDatabase.Scratch))
const sql = <A extends object>(query: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, query))

/** Someone who has signed in: their subject id, their login, and them as a Maintainer of every repository. */
const person = async (role: Actor["role"] = "maintainer") => {
  const id = crypto.randomUUID()
  const login = `maya-sentinel-${id.slice(0, 8)}`
  await sql((sql) => sql`
    INSERT INTO people (id, github_id, github_login) VALUES (${id}, ${Math.floor(Math.random() * 1e12)}, ${login})`)
  const actor: Actor = { subject: { kind: "person", id }, role, login }
  return { id, login, actor }
}

/** A live machine token on `repo` for `agent`/`lane` holding `scope`. */
const token = async (scope: ReadonlyArray<string> = ["ask/create"], lane = "lane-1", repo = "github/acme/widgets") => {
  const raw = `smm_token-sentinel-${crypto.randomUUID()}`
  await sql((sql) => sql`
    INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at)
    VALUES (${digestSync(raw)}, ${repo}, 'builder', ${lane}, ${sql.literal(`ARRAY[${scope.map((act) => `'${act}'`).join(",")}]::text[]`)},
      'test', now() + interval '1 day')`)
  return raw
}

/** The asks routes over this file's schema, starting runs through `starter`, recording every line and count. */
const asksRoutes = async (
  starter: Flows.FlowStarter["Service"],
  database?: Layer.Layer<SqlClient.SqlClient, unknown>,
  options?: Asks.Options,
) => {
  const { database: own } = await scratch()
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const handler = HttpEffect.toWebHandler(
    Asks.make(database ?? own, options).fetch.pipe(
      Effect.provideService(Flows.FlowStarter, starter),
      Effect.provide(Directory.layer(own)),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const send = (path: string, bearer: string | null, init: RequestInit = {}) =>
    handler(new Request(`http://chat.test${path}`, {
      ...init,
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(init.headers ?? {}) },
    }))
  return {
    ask: (bearer: string | null, body: unknown, repo = "Acme/Widgets") =>
      send(`/api/repos/${repo}/asks`, bearer, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    read: (bearer: string | null, id: string, repo = "acme/widgets") => send(`/api/repos/${repo}/asks/${id}`, bearer),
    send,
    lines,
    count: (attributes: Record<string, string>) =>
      Effect.runSync(Metric.value(Metric.withAttributes(Asks.requests, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      )).count,
  }
}

/** Runs `use` with `queue/ask` running on objects over a fresh engine schema, and the app's tables on this file's. */
const withRemote = <A>(use: (remote: ReturnType<typeof executions>) => Promise<A>) =>
  scratch().then(({ database }) =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const engine = yield* engineSchema
      const remote = executions(engine.database, database)
      return yield* Effect.promise(() => use(remote))
    })))
  )

/** ChatApi as `actor`, answering through `remote`'s objects, its Electric requests recorded and pointed at this file's schema. */
const chat = async (
  actor: Actor,
  remote: { readonly answers: Flows.TaskAnswers["Service"] },
  options: { readonly branchRoles?: Layer.Layer<BranchRoles>; readonly act?: boolean } = {},
) => {
  const { name } = await scratch()
  const upstream: Array<URL> = []
  const h = await harness(runtime, () => Stream.empty, {
    ...(options.act === true
      ? { sessions: signedIn({ ...actor, act: { kind: "agent", id: crypto.randomUUID() } }) }
      : { actor }),
    answers: remote.answers,
    ...(options.branchRoles === undefined ? {} : { branchRoles: options.branchRoles }),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      upstream.push(new URL(url))
      if (url.searchParams.get("table") === "runs") url.searchParams.set("table", `${name}.runs`)
      return fetch(url, init)
    },
  })
  const answer = (runId: string, version: number, value: unknown) =>
    h.fetch(`/api/runs/${runId}/answer`, { method: "POST", body: JSON.stringify({ version, value }) })
  return { h, upstream, answer }
}

const json = async (response: Response) => [response.status, await response.json()] as const

const rowOf = async (runId: string) =>
  (await sql((sql) => sql<{ readonly status: string; readonly answer: unknown; readonly answeredAt: Date | null }>`
    SELECT status, answer, answered_at AS "answeredAt" FROM runs WHERE id = ${runId}::uuid`))[0]

const body = (to: string, id = `ask-${crypto.randomUUID().slice(0, 8)}`) => ({ id, to, prompt: `  ${PROMPT} `, options: [OPTION, "no"] })

/** Asks `to` as the token's lane and drives the run until it parks: the ask's id, run id and execution id. */
const asked = async (remote: ReturnType<typeof executions>, to: string, bearer?: string) => {
  const routes = await asksRoutes(remote.starter)
  const sent = body(to)
  const response = await routes.ask(bearer ?? await token(), sent)
  const { runId } = (await response.json()) as { readonly runId: string }
  const executionId = Ask.askExecutionId("acme/widgets", sent.id)
  expect((await Effect.runPromise(remote.alarm(executionId)))._tag).toBe("Parked")
  return { id: sent.id, runId, executionId, routes }
}

describe("an agent asks a person, and the person's answer resumes its run", () => {
  test("the addressee answers; the same run resumes and settles; the asker reads the answer", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const bearer = await token()
      const routes = await asksRoutes(remote.starter)
      const sent = body(maya.login.toUpperCase())
      const response = await routes.ask(bearer, sent)
      const executionId = Ask.askExecutionId("acme/widgets", sent.id)
      const runId = await Effect.runPromise(rowIdOf(executionId))
      expect(await json(response)).toEqual([202, { runId }])
      expect(response.headers.get("cache-control")).toBe("no-store")
      // The same ask again is the same ask.
      expect(await json(await routes.ask(bearer, sent))).toEqual([202, { runId }])
      expect((await Effect.runPromise(remote.alarm(executionId)))._tag).toBe("Parked")
      expect(await json(await routes.read(bearer, sent.id))).toEqual([200, { status: "open" }])

      // The row reaches its addressee's devices, and no one else's.
      const mine = await chat(maya.actor, remote)
      const rows = async (h: Awaited<ReturnType<typeof chat>>) => {
        const shape = await h.h.fetch("/api/shapes/runs?offset=-1")
        expect(shape.status).toBe(200)
        return ((await shape.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
          row.value === undefined ? [] : [row.value]
        )
      }
      const synced = (await rows(mine)).find((row) => row.id === runId)
      expect(synced).toMatchObject({ flow: "queue/ask", status: "needs_you", waiting: "input", repo_id: "github/acme/widgets", conversation_id: null })
      expect(synced).not.toHaveProperty("launched_by")
      expect(synced).not.toHaveProperty("addressed_to")
      expect(Object.fromEntries(mine.upstream[0]!.searchParams)).toMatchObject({
        where: "(launched_by = $1 AND execution IS NULL) OR addressed_to = $1",
        "params[1]": maya.id,
        columns: Runs.SYNCED_RUN_COLUMNS.join(","),
      })
      const other = await person()
      expect((await rows(await chat(other.actor, remote))).map((row) => row.id)).not.toContain(runId)

      expect(await json(await mine.answer(runId, 1, `  ${ANSWER} `))).toEqual([200, { txid: expect.any(Number) }])
      expect(await rowOf(runId)).toMatchObject({ status: "needs_you", answer: { value: ANSWER } })
      // The same answer again is taken as landed; another is refused.
      expect(await json(await mine.answer(runId, 1, ANSWER))).toEqual([200, { txid: null }])
      expect(await json(await mine.answer(runId, 1, "no"))).toEqual([409, { code: "not_open" }])
      expect((await Effect.runPromise(remote.alarm(executionId)))._tag).toBe("Settled")
      expect(await rowOf(runId)).toMatchObject({ status: "done", answer: { value: ANSWER } })
      const [status, read] = await json(await routes.read(bearer, sent.id))
      expect([status, read]).toEqual([200, { status: "answered", answer: ANSWER, answeredAt: expect.any(String) }])
      expect(new Date((read as { answeredAt: string }).answeredAt).getTime()).toBe((await rowOf(runId))!.answeredAt!.getTime())
      expect(await json(await mine.answer(runId, 1, ANSWER))).toEqual([200, { txid: null }])

      expect(mine.h.line("agent.status.answer").map((line) => line.annotations)).toEqual([
        expect.objectContaining({ runId, version: 1, addressed: true, status: 200 }),
        expect.objectContaining({ runId, addressed: true, existing: true, status: 200 }),
        expect.objectContaining({ runId, addressed: true, status: 409 }),
        expect.objectContaining({ runId, addressed: true, existing: true, status: 200 }),
      ])
      expect(routes.count({ op: "create", outcome: "started" })).toBe(2)
      expect(routes.count({ op: "read", outcome: "open" })).toBe(1)
      expect(routes.count({ op: "read", outcome: "answered" })).toBe(1)
      expect(routes.lines.filter((line) => line.message === "queue.ask.request")[0]).toMatchObject({
        level: "INFO",
        annotations: { op: "create", repoId: "github/acme/widgets", askId: sent.id, agent: "builder", lane: "lane-1", outcome: "started", status: 202 },
      })
      const recorded = JSON.stringify([routes.lines, mine.h.logs])
      for (const sentinel of ["prompt-sentinel", OPTION, ANSWER, "token-sentinel", maya.login]) expect(recorded).not.toContain(sentinel)
      await eventually(() => mine.h.line("agent.status.shape").length >= 1)
    }))

  test("the asks routes refuse what they can't take, and a lane reads only its own asks", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const bearer = await token()
      const routes = await asksRoutes(remote.starter)
      const sent = body(maya.login)
      const refusals: Array<readonly [Response, number, string]> = [
        [await routes.ask(null, sent), 401, "authentication"],
        [await routes.ask("smm_unknown", sent), 401, "authentication"],
        [await routes.ask("not-a-machine-token", sent), 401, "authentication"],
        [await routes.ask(await token(["ask/create"], "lane-1", "github/acme/other"), sent), 401, "authentication"],
        [await routes.ask(await token(["issue/create"]), sent), 403, "forbidden"],
        [await routes.ask(bearer, "{"), 400, "invalid"],
        [await routes.ask(bearer, { ...sent, id: "Not An Id" }), 400, "invalid"],
        [await routes.ask(bearer, { ...sent, prompt: "   " }), 400, "invalid"],
        [await routes.ask(bearer, { ...sent, options: Array.from({ length: 9 }, (_, n) => `o${n}`) }), 400, "invalid"],
        [await routes.ask(bearer, { ...sent, pad: "x".repeat(20 * 1024) }), 413, "too_large"],
        [await routes.ask(bearer, { ...sent, to: "nobody-signed-in" }), 422, "unknown_person"],
      ]
      for (const [response, status, code] of refusals) expect(await json(response)).toEqual([status, { code }])
      const malformed = await routes.send("/api/repos/acme/widgets/asks", bearer, { method: "POST", body: new Uint8Array([0xff, 0xfe]) })
      expect(await json(malformed)).toEqual([400, { code: "invalid" }])
      expect((await routes.send("/api/repos/acme/widgets/asks", bearer)).status).toBe(405)
      expect((await routes.send("/api/repos/acme/widgets/asks/x", bearer, { method: "POST" })).headers.get("allow")).toBe("GET")

      expect((await routes.ask(bearer, sent)).status).toBe(202)
      // A question needs no options.
      expect((await routes.ask(bearer, { id: "no-options", to: maya.login, prompt: "Ready?" })).status).toBe(202)
      // Another question under the id, or the same from another lane, is another ask.
      expect(await json(await routes.ask(bearer, { ...sent, prompt: "Something else?" }))).toEqual([409, { code: "conflict" }])
      const otherLane = await token(["ask/create"], "lane-2")
      expect(await json(await routes.ask(otherLane, sent))).toEqual([409, { code: "conflict" }])
      await Effect.runPromise(remote.alarm(Ask.askExecutionId("acme/widgets", sent.id)))
      expect(await json(await routes.read(otherLane, sent.id))).toEqual([404, { code: "not_found" }])
      expect(await json(await routes.read(bearer, "never-asked"))).toEqual([404, { code: "not_found" }])
      expect(await json(await routes.read(bearer, "Not%20An%20Id"))).toEqual([404, { code: "not_found" }])
      expect(await json(await routes.read(await token(["issue/create"]), sent.id))).toEqual([403, { code: "forbidden" }])
      expect(await json(await routes.read(null, sent.id))).toEqual([401, { code: "authentication" }])
      expect(Asks.handles("/api/repos/acme/widgets/asks/a/b")).toBe(false)
      expect(routes.count({ op: "create", outcome: "unknown_person" })).toBe(1)
      expect(routes.count({ op: "create", outcome: "conflict" })).toBe(2)
      expect(JSON.stringify(routes.lines)).not.toContain("sentinel")
    }))

  test("alchemy dev's development token asks on any repository as its own agent and lane; a deploy refuses it", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const dev = await asksRoutes(remote.starter, undefined, { developmentToken: DEV_ASK_TOKEN })
      const sent = body(maya.login)
      expect((await dev.ask(DEV_ASK_TOKEN, sent, "Elsewhere/Tools")).status).toBe(202)
      const executionId = Ask.askExecutionId("elsewhere/tools", sent.id)
      expect((await Effect.runPromise(remote.alarm(executionId)))._tag).toBe("Parked")
      expect(await json(await dev.read(DEV_ASK_TOKEN, sent.id, "elsewhere/tools"))).toEqual([200, { status: "open" }])
      const runId = await Effect.runPromise(rowIdOf(executionId))
      expect(await sql((sql) => sql`SELECT launched_by AS "launchedBy" FROM runs WHERE id = ${runId}::uuid`))
        .toEqual([{ launchedBy: "machine:development/local" }])
      // Beside it, an issued token still asks as its own lane; any other bearer is no one.
      expect((await dev.ask(await token(), body(maya.login))).status).toBe(202)
      expect(await json(await dev.ask("smm_unknown", body(maya.login)))).toEqual([401, { code: "authentication" }])
      expect(dev.lines.find((line) => line.message === "queue.ask.request")).toMatchObject({
        annotations: { agent: "development", lane: "local", outcome: "started" },
      })
      // A deploy passes no development token: the same bearer is no one there.
      const deploy = await asksRoutes(remote.starter)
      expect(await json(await deploy.ask(DEV_ASK_TOKEN, body(maya.login)))).toEqual([401, { code: "authentication" }])
      expect(JSON.stringify([dev.lines, deploy.lines])).not.toContain(DEV_ASK_TOKEN)
    }))

  test("an ask whose question ended without an answer reads closed", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const bearer = await token()
      const { id, executionId, routes } = await asked(remote, maya.login, bearer)
      // An answer the task refuses: the route never sends one, so it comes straight to the object here.
      expect(await Effect.runPromise(remote.answers.answer(executionId, Ask.ASK_TASK, 42))).toBe(true)
      expect((await Effect.runPromise(remote.alarm(executionId)))._tag).toBe("Settled")
      expect(await json(await routes.read(bearer, id))).toEqual([200, { status: "closed" }])
    }))

  test("a host that can't start the run, or Postgres out of reach, is 503 unavailable with its code", async () => {
    const maya = await person()
    const bearer = await token()
    const refusing = await asksRoutes(Flows.FlowStarter.of({
      start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "rpc" })),
    }))
    expect(await json(await refusing.ask(bearer, body(maya.login)))).toEqual([503, { code: "unavailable" }])
    expect(refusing.lines.at(-1)).toMatchObject({ level: "ERROR", annotations: { errorCode: "rpc", status: 503 } })
    const down = await asksRoutes(
      Flows.FlowStarter.of({ start: () => Effect.void }),
      Layer.effect(SqlClient.SqlClient, Effect.die(new Error("unreachable"))),
    )
    expect(await json(await down.ask(bearer, body(maya.login)))).toEqual([503, { code: "unavailable" }])
    expect(down.count({ op: "create", outcome: "unavailable" })).toBe(1)
  })
})

describe("POST /api/runs/<id>/answer on a question addressed to a person", () => {
  test("someone else, a non-maintainer and an agent acting for the person are refused; a stale version is not_open", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const { runId } = await asked(remote, maya.login)
      const other = await person()
      expect(await json(await (await chat(other.actor, remote)).answer(runId, 1, ANSWER))).toEqual([403, { code: "forbidden" }])
      const member = await chat({ ...maya.actor, role: "member" }, remote)
      expect(await json(await member.answer(runId, 1, ANSWER))).toEqual([403, { code: "forbidden" }])
      expect(member.h.line("agent.status.answer").at(-1)).toMatchObject({ annotations: { errorCode: "not_maintainer" } })
      const agent = await chat(maya.actor, remote, { act: true })
      expect(await json(await agent.answer(runId, 1, ANSWER))).toEqual([403, { code: "person_only" }])
      const mine = await chat(maya.actor, remote)
      expect(await json(await mine.answer(runId, 2, ANSWER))).toEqual([409, { code: "not_open" }])
      expect(await json(await mine.answer(runId, 1, true))).toEqual([400, { code: "invalid" }])
      expect(await json(await mine.answer(runId, 1, "   "))).toEqual([400, { code: "invalid" }])
      expect(await rowOf(runId)).toMatchObject({ status: "needs_you", answer: null })
      // An admin of the repository answers.
      const admin = await chat({ ...maya.actor, role: "admin" }, remote)
      expect((await admin.answer(runId, 1, ANSWER)).status).toBe(200)
    }))

  test("a role that can't be read is 503; a resolver that gives no repository role is 403", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const { runId } = await asked(remote, maya.login)
      const refusing = Layer.succeed(BranchRoles, BranchRoles.of({
        roleOn: () => Effect.succeed("maintainer"),
        repoRoleOn: () => Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable" })),
      }))
      const unreadable = await chat(maya.actor, remote, { branchRoles: refusing })
      expect(await json(await unreadable.answer(runId, 1, ANSWER))).toEqual([503, { code: "unavailable" }])
      expect(unreadable.h.line("agent.status.answer").at(-1)).toMatchObject({ annotations: { errorCode: "github_unavailable" } })
      const roleless = Layer.succeed(BranchRoles, BranchRoles.of({ roleOn: () => Effect.succeed("maintainer") }))
      expect(await json(await (await chat(maya.actor, remote, { branchRoles: roleless })).answer(runId, 1, ANSWER))).toEqual([
        403,
        { code: "forbidden" },
      ])
      expect(await rowOf(runId)).toMatchObject({ status: "needs_you", answer: null })
    }))

  test("a run that settles before the route records its answer has the answer taken as landed", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const { runId, executionId } = await asked(remote, maya.login)
      // Cloudflare may run the woken object's alarm before the route's write: the run's own settle records the answer.
      const settling = Flows.TaskAnswers.of({
        answer: (execution, task, value) =>
          Effect.tap(remote.answers.answer(execution, task, value), () => remote.alarm(executionId)),
      })
      const mine = await chat(maya.actor, { answers: settling })
      expect(await json(await mine.answer(runId, 1, ANSWER))).toEqual([200, { txid: null }])
      expect(await rowOf(runId)).toMatchObject({ status: "done", answer: { value: ANSWER } })
      expect(mine.h.line("agent.status.answer").at(-1)).toMatchObject({ annotations: { existing: true } })
    }))

  test("a run that isn't parked yet, or a host that can't take the answer, is 503 and records nothing", () =>
    withRemote(async (remote) => {
      const maya = await person()
      const { database } = await scratch()
      // The row of a run whose object never parked: its open step ran, its drive didn't reach the task.
      const executionId = Ask.askExecutionId("acme/widgets", "not-parked")
      await Effect.runPromise(Ask.open(database)({
        repo: "acme/widgets", id: "not-parked", to: maya.id, askedBy: "machine:builder/lane-1", prompt: PROMPT,
      }).pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId } as unknown as FlowRuntime.FlowInstance["Service"])))
      const runId = await Effect.runPromise(rowIdOf(executionId))
      const mine = await chat(maya.actor, remote)
      expect(await json(await mine.answer(runId, 1, ANSWER))).toEqual([503, { code: "unavailable" }])
      expect(mine.h.line("agent.status.answer").at(-1)).toMatchObject({ annotations: { errorCode: "not_waiting" } })
      const failing = await chat(maya.actor, {
        answers: Flows.TaskAnswers.of({ answer: () => Effect.fail(new Flows.AnswerUnavailable({ errorCode: "rpc" })) }),
      })
      expect(await json(await failing.answer(runId, 1, ANSWER))).toEqual([503, { code: "unavailable" }])
      expect(await rowOf(runId)).toMatchObject({ status: "needs_you", answer: null })
    }))
})
