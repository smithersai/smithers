import { Fuzz } from "@smthrs/fuzz"
import { CiJob, SandboxTools } from "@smthrs/sandbox"
import { Arbitrary, Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as ElectricAwake from "../infra/ElectricAwake.ts"
import * as ElectricRelay from "../infra/ElectricRelay.ts"
import * as RequestRay from "./RequestRay.ts"
import * as SessionEnds from "./SessionEnds.ts"
import * as SessionPrior from "./SessionPrior.ts"
import * as Machines from "./branch/Machines.ts"
import { CheckoutFailed, SandboxStartTimedOut, SandboxUnavailable, type SandboxBranch } from "./branch/Sandboxes.ts"
import * as CiJobMachine from "./flows/CiJobMachine.ts"
import * as WorkLinks from "./github/WorkLinks.ts"
import * as WriteFeed from "./github/WriteFeed.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

const flattenSql = (
  strings: TemplateStringsArray,
  values: ReadonlyArray<unknown>
): { text: string; params: Array<unknown> } => {
  let text = ""
  const params: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i] as { segments?: ReadonlyArray<{ sql?: string; params?: ReadonlyArray<unknown>; value?: unknown }> } | undefined
      if (v && typeof v === "object" && "segments" in v && Array.isArray(v.segments)) {
        for (const seg of v.segments) {
          if (seg && typeof seg === "object" && typeof seg.sql === "string") {
            text += seg.sql
            if (Array.isArray(seg.params)) params.push(...seg.params)
          } else if (seg && typeof seg === "object" && "value" in seg) {
            text += String(seg.value)
          }
        }
      } else {
        text += `$${params.length + 1}`
        params.push(v)
      }
    }
  }
  return { text, params }
}

const makeSqlLayer = (
  handler: (sqlText: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error
): Layer.Layer<SqlClient.SqlClient> => {
  const fn = ((strings: TemplateStringsArray | string, ...values: ReadonlyArray<unknown>) => {
    if (typeof strings === "string") return { segments: [{ sql: strings, params: [] }] }
    const { text, params } = flattenSql(strings, values)
    return Effect.suspend(() => {
      const out = handler(text, params)
      return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
    })
  }) as unknown as SqlClient.SqlClient
  const client = Object.assign(fn, {
    in: (a: unknown, b?: ReadonlyArray<unknown>) => {
      if (Array.isArray(a)) return { segments: [{ sql: `(${a.map((_, i) => `$in${i}`).join(",")})`, params: [...a] }] }
      const arr = b ?? []
      return { segments: [{ sql: `${String(a)} IN (${arr.map((_, i) => `$in${i}`).join(",")})`, params: [...arr] }] }
    },
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    unsafe: (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.suspend(() => {
        const out = handler(query, params)
        return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
      })
  })
  return Layer.succeed(SqlClient.SqlClient, client)
}

const makeRequest = (url: string, headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(new Request(url, { headers }))

describe("Wave-6 apps/mvp Machines, CiJobMachine, WorkLinks, WriteFeed, SessionPrior/Ends, RequestRay, ElectricAwake/Relay", () => {
  it("fuzzes Machines.ranOf/commandsOver/routed and CiJobMachine checkout/run/release", () =>
    property(
      Arbitrary.all({
        outcomeKind: intBetween(0, 6),
        cmdOutcomeKind: intBetween(0, 10),
        sleepKind: intBetween(0, 3),
        undeclared: bool,
        ciMode: intBetween(0, 4),
        generation: intBetween(1, 50)
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const branch: SandboxBranch = {
            branchId: "github/acme/app#feat",
            repoId: "github/acme/app",
            owner: "acme",
            repo: "app",
            ref: "refs/heads/feat",
            machine: s.undeclared ? "unknown-box" : "default"
          } as unknown as SandboxBranch

          const toolOutcome: Machines.ToolOutcome = s.outcomeKind === 0
            ? { _tag: "Done", result: { tool: "run", exitCode: 0, stdout: "ok", stderr: "", stdoutBytes: 2, stderrBytes: 0, timedOut: false, truncated: false }, generation: s.generation }
            : s.outcomeKind === 1
            ? { _tag: "Refused", reason: "path" }
            : s.outcomeKind === 2
            ? { _tag: "Lost" }
            : s.outcomeKind === 3
            ? { _tag: "CheckoutFailed", exitCode: 1, checkoutFailure: "clone" }
            : s.outcomeKind === 4
            ? { _tag: "Waiting" }
            : s.outcomeKind === 5
            ? { _tag: "Unavailable", reason: "start_timeout" }
            : { _tag: "Unavailable" }

          const ranExit = yield* Effect.exit(Machines.ranOf(toolOutcome))
          expect(Exit.isSuccess(ranExit)).toBe(s.outcomeKind === 0)

          const kept: Array<number> = []
          const obj: Machines.MachineObject = {
            tool: () => Effect.succeed(toolOutcome),
            command: (_b, _o, req) => {
              if (s.cmdOutcomeKind === 0) {
                if (req.op === "start") return Effect.succeed({ _tag: "Started", started: { key: req.key, pid: 10 }, generation: s.generation } as unknown as Machines.CommandOutcome)
                if (req.op === "observe") return Effect.succeed({ _tag: "Observed", observed: { status: "running" } } as unknown as Machines.CommandOutcome)
                if (req.op === "collect") return Effect.succeed({ _tag: "Collected", result: { exitCode: 0, stdout: "hi", stderr: "", timedOut: false, truncated: false } } as unknown as Machines.CommandOutcome)
                return Effect.succeed({ _tag: "Cancelled" })
              }
              const failOutcomes: ReadonlyArray<Machines.CommandOutcome> = [
                { _tag: "Refused", reason: "path" },
                { _tag: "Lost" },
                { _tag: "CheckoutFailed", exitCode: 1, checkoutFailure: "clone" },
                { _tag: "ToolUnavailable", code: SandboxTools.ToolUnavailable.fields.code.literals[0], exitCode: 127 },
                { _tag: "ToolUnavailable", code: SandboxTools.ToolUnavailable.fields.code.literals[0] },
                { _tag: "Unavailable", reason: "start_timeout" },
                { _tag: "Unavailable" },
                { _tag: "Waiting" },
                { _tag: "Cancelled" },
                { _tag: "Lost" }
              ]
              return Effect.succeed(failOutcomes[s.cmdOutcomeKind - 1]!)
            },
            sleepIfIdle: () =>
              Effect.succeed(
                s.sleepKind === 0 ? "slept" : s.sleepKind === 1 ? "busy" : s.sleepKind === 2 ? "gone" : "unavailable"
              )
          }

          const router = Machines.routed(
            (_id, machine) => (machine === "unknown-box" ? undefined : obj),
            (_id, gen) => Effect.sync(() => { kept.push(gen) })
          )

          // tool()
          const tExit = yield* Effect.exit(router.tool(branch, "owner-1", "call-1", { tool: "run", command: "echo ok", timeoutSeconds: 10 }))
          expect(Exit.isSuccess(tExit)).toBe(!s.undeclared && s.outcomeKind === 0)

          // commands()
          const cmds = router.commands(branch, "owner-1", "call-1")
          const cStart = yield* Effect.exit(cmds.start({ tool: "run", command: "echo hi", timeoutSeconds: 10 }, "k1"))
          const cObs = yield* Effect.exit(cmds.observe("k1", { waitMs: 5 }))
          const cCol = yield* Effect.exit(cmds.collect("k1"))
          const cCan = yield* Effect.exit(cmds.cancel("k1"))
          if (s.undeclared) {
            expect(Exit.isFailure(cStart)).toBe(true)
            expect(Exit.isFailure(cObs)).toBe(true)
            expect(Exit.isFailure(cCol)).toBe(true)
            expect(Exit.isFailure(cCan)).toBe(true)
          } else if (s.cmdOutcomeKind === 0) {
            expect(Exit.isSuccess(cStart)).toBe(true)
            expect(Exit.isSuccess(cObs)).toBe(true)
            expect(Exit.isSuccess(cCol)).toBe(true)
            expect(Exit.isSuccess(cCan)).toBe(true)
          }

          // sleepIfIdle()
          const slExit = yield* Effect.exit(router.sleepIfIdle(branch.branchId, s.generation, 0, branch.machine))
          expect(Exit.isSuccess(slExit)).toBe(!s.undeclared && s.sleepKind < 3)

          // CiJobMachine.layer
          const ciMachinesLayer = Layer.succeed(Machines.Machines, {
            commands: router.commands,
            tool: () => {
              if (s.ciMode === 0) {
                return Effect.succeed({
                  result: { tool: "run", exitCode: 0, stdout: "ok", stderr: "", stdoutBytes: 2, stderrBytes: 0, timedOut: false, truncated: false },
                  generation: s.generation
                })
              }
              if (s.ciMode === 1) {
                return Effect.succeed({
                  result: { tool: "run", exitCode: 1, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, timedOut: true, truncated: false },
                  generation: s.generation
                })
              }
              if (s.ciMode === 2) return Effect.fail(new SandboxUnavailable({ reason: "exec" }))
              if (s.ciMode === 3) return Effect.fail(new SandboxStartTimedOut())
              return Effect.fail(new SandboxTools.ToolLost())
            },
            sleepIfIdle: () =>
              s.ciMode === 2 ? Effect.fail(new SandboxUnavailable({ reason: "exec" })) : Effect.succeed("slept")
          } as unknown as Machines.Machines["Service"])

          const target: CiJob.Target = { run: "run-1", repo: "github/acme/app", sha: "deadbeef", branch: "main" } as unknown as CiJob.Target
          const job: CiJob.JobRef = { name: "test", machine: "default" } as unknown as CiJob.JobRef

          yield* Effect.gen(function*() {
            const ci = yield* CiJob.Machine
            const chk = yield* Effect.exit(ci.checkout(target, job))
            if (s.ciMode === 2 || s.ciMode === 3) expect(Exit.isFailure(chk)).toBe(true)
            else expect(Exit.isSuccess(chk)).toBe(true)

            const step = yield* Effect.exit(ci.run(target, job, 0, { name: "build", run: "pnpm test" } as unknown as CiJob.Step))
            if (s.ciMode === 2 || s.ciMode === 3) expect(Exit.isFailure(step)).toBe(true)
            else expect(Exit.isSuccess(step)).toBe(true)

            yield* ci.release(target, job)
          }).pipe(Effect.provide(CiJobMachine.layer.pipe(Layer.provide(ciMachinesLayer))))
        })
    ))

  it("fuzzes WorkLinks, WriteFeed, SessionPrior, SessionEnds, RequestRay, ElectricAwake & ElectricRelay", () =>
    property(
      Arbitrary.all({
        owner: word,
        repo: word,
        issueNum: intBetween(1, 500),
        runnerState: intBetween(0, 2),
        machineHeld: bool,
        writeOp: Arbitrary.schema(Schema.Literals(["branch/publish", "branch/update", "issue/create", "other/op"])),
        writeState: Arbitrary.schema(Schema.Literals(["done", "failed", "running"])),
        priorMode: intBetween(0, 5),
        electricMode: intBetween(0, 4),
        relayMode: intBetween(0, 4),
        isApi: bool,
        status: Arbitrary.schema(Schema.Literals([200, 400, 503]))
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const repoId = `github/${s.owner}/${s.repo}`

          // 1. WorkLinks.parseLinksPath, decode, fromTheFuture, runnerOf, write, workOf
          const validPath = `/api/repos/${s.owner}/${s.repo}/issues/${s.issueNum}/links`
          expect(WorkLinks.parseLinksPath(validPath)).toStrictEqual({ owner: s.owner, name: s.repo, number: s.issueNum })
          expect(WorkLinks.parseLinksPath("/api/other")).toBeUndefined()
          expect(WorkLinks.parseLinksPath(`/api/repos/${s.owner}/${s.repo}/issues/0/links`)).toBeUndefined()
          expect(WorkLinks.parseLinksPath(`/api/repos/%E0%A4%A/${s.repo}/issues/1/links`)).toBeUndefined()

          const now = Date.now()
          const futureAt = new Date(now + WorkLinks.MAX_SKEW_MS + 60_000).toISOString()
          const pastAt = new Date(now - 10_000).toISOString()
          const decoded = WorkLinks.decode(JSON.stringify({
            links: [
              { kind: "pr", ref: `#${s.issueNum}`, label: "PR", url: "https://github.com/a/b/pull/1", state: "open", at: pastAt },
              { kind: "session", ref: "s1", state: "working", at: futureAt }
            ]
          }))
          expect(decoded).toBeDefined()
          expect(WorkLinks.fromTheFuture(decoded!, now)).toBe(true)
          expect(WorkLinks.decode("not json")).toBeUndefined()
          expect(WorkLinks.decode(JSON.stringify({ links: [{ kind: "pr", ref: "r", url: "http://insecure" }] }))).toBeUndefined()

          const wlDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.startsWith("SET LOCAL ")) return []
            if (q.includes("FROM runners r WHERE")) {
              if (s.runnerState === 0) return []
              return [{ name: "runner-1", current: s.runnerState === 1 }]
            }
            if (q.includes("FROM runners WHERE")) {
              return s.runnerState === 1 ? [{ "?column?": 1 }] : []
            }
            if (q.includes("FROM github_repositories WHERE")) {
              return s.runnerState === 1 ? [{ "?column?": 1 }] : []
            }
            if (q.includes("FROM machine_tokens WHERE")) {
              return s.machineHeld ? [{ "?column?": 1 }] : []
            }
            if (q.includes("INSERT INTO work_links")) return [{ id: "wl-1" }]
            if (q.includes("FROM work_links WHERE")) {
              return [{
                number: s.issueNum,
                kind: "pr",
                ref: `#${s.issueNum}`,
                label: "PR",
                url: "https://github.com/a/b/pull/1",
                state: "open",
                source: "person",
                updatedAt: pastAt
              }]
            }
            return []
          })

          yield* Effect.gen(function*() {
            const rNone = yield* WorkLinks.runnerOf(makeRequest("https://smithers.sh/x"), repoId)
            expect(Option.isNone(rNone)).toBe(true)
            const rAuth = yield* WorkLinks.runnerOf(makeRequest("https://smithers.sh/x", { authorization: "Bearer tok-123" }), repoId)
            expect(Option.isSome(rAuth)).toBe(s.runnerState !== 0)

            const post: WorkLinks.Post = {
              links: [{ kind: "pr", ref: `#${s.issueNum}`, state: "open", at: pastAt }]
            }
            const wPerson = yield* WorkLinks.write(repoId, s.issueNum, post, "person:1", now)
            expect(Option.isSome(wPerson)).toBe(true)
            const wRunner = yield* WorkLinks.write(repoId, s.issueNum, post, "runner:1", now, { tokenSha256: "abc" })
            expect(Option.isSome(wRunner)).toBe(s.runnerState === 1)
            const wMachine = yield* WorkLinks.write(repoId, s.issueNum, post, "machine:1", now, undefined, { tokenSha256: "def" })
            expect(Option.isSome(wMachine)).toBe(s.machineHeld)

            const emptyWork = yield* WorkLinks.workOf(repoId, [])
            expect(emptyWork.size).toBe(0)
            const listed = yield* WorkLinks.workOf(repoId, [s.issueNum])
            expect(listed.size).toBe(1)
          }).pipe(Effect.provide(wlDb))

          // 2. WriteFeed.fold
          const wfDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM github_writes")) {
              return [{
                id: "w-1",
                repoId,
                actorId: "p-1",
                op: s.writeOp,
                state: s.writeState,
                name: "feat/x", itemNumber: s.issueNum, result: { url: "/x" }
              }]
            }
            if (q.includes("INSERT INTO notifications")) return [{ subject: "write:w-1" }]
            return []
          })
          const folded = yield* WriteFeed.fold("w-1").pipe(Effect.provide(wfDb))
          expect(typeof folded).toBe("number")

          // 3. SessionPrior.read & SessionEnds.endSession / endAlias / sweep
          const sessDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM session_end_receipts WHERE")) {
              return s.priorMode === 1 ? [{ session_tag: "t1" }] : []
            }
            if (q.includes("UNION ALL SELECT parent_id AS parent")) {
              if (s.priorMode <= 1) return []
              return [{ parent: "p-1", alias: s.priorMode === 4 ? "a-1" : null }]
            }
            if (q.includes("AS \"parentEnded\"")) {
              if (s.priorMode === 2) return []
              return [{ parentEnded: s.priorMode === 3, aliasEnded: s.priorMode === 4 }]
            }
            if (q.includes("FROM sessions WHERE id =") && q.includes("AS tag")) {
              return [{ tag: "t1", changed: true, at: pastAt, reason: "expired", aliases: [{ id: "a-1" }] }]
            }
            if (q.includes("FROM host_sessions h JOIN sessions s") && q.includes("AS \"parentEnded\"")) {
              return [{ parent: "p-1", tag: "t2", changed: true, parentEnded: false, at: pastAt, reason: "expired" }]
            }
            if (q.includes("SELECT id, person_id AS person FROM sessions")) {
              return [{ id: "s-1", person: "u-1" }]
            }
            if (q.includes("SELECT h.id, h.parent_id AS parent FROM host_sessions")) {
              return [{ id: "a-1", parent: "s-1" }]
            }
            if (q.includes("AS ended")) return [{ ended: true }]
            if (q.includes("AS erase")) return [{ erase: true }]
            return []
          })
          yield* Effect.gen(function*() {
            const prior = yield* SessionPrior.read("t1")
            expect(["ended", "live", "absent"]).toContain(prior)
            yield* SessionEnds.endSession("s-1", "sign_out", 2)
            yield* SessionEnds.endAlias("a-1", "expired")
            yield* SessionEnds.sweep()
          }).pipe(Effect.provide(sessDb))

          // 4. RequestRay
          const reqRay = makeRequest(s.isApi ? "https://smithers.sh/api/test" : "https://smithers.sh/page", {
            "cf-ray": "0123456789abcdef-IAD"
          })
          const rayResp = yield* RequestRay.withRequestRay(
            Effect.succeed(HttpServerResponse.empty({ status: s.status }))
          ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, reqRay))
          expect(rayResp.status).toBe(s.status)

          // 5. ElectricAwake (makeAwake, logged, isLive, recordStart, directOr, forward, serveObject, tagOf, correlationOf)
          expect(ElectricAwake.isLive("https://e/v1/shape?live=true")).toBe(true)
          expect(ElectricAwake.isLive("https://e/v1/shape?live=false")).toBe(false)
          expect(ElectricAwake.correlationOf("0123456789abcdef")).toBe("0123456789abcdef")
          expect(ElectricAwake.correlationOf("bad")).toBe("unavailable")
          expect(ElectricAwake.tagOf({ _tag: "MyTag" })).toBe("MyTag")
          expect(ElectricAwake.tagOf(new Error("e"))).toBe("Error")
          expect(ElectricAwake.tagOf("str")).toBe("string")

          const awake = yield* ElectricAwake.logged(
            ElectricAwake.makeAwake({
              running: Effect.succeed(s.electricMode % 2 === 0),
              start: Effect.void,
              setInactivityTimeout: () => Effect.void
            })
          )
          expect(typeof awake.started).toBe("boolean")
          yield* ElectricAwake.recordStart(Effect.succeed("started"), "inst-1")

          const inFlight = ElectricAwake.makeInFlight()
          const served = yield* ElectricAwake.serveObject({
            wake: s.electricMode === 0 ? Effect.fail(new Error("wake-fail")) : Effect.succeed({ started: true, held: true }),
            direct: s.electricMode <= 2 ? Effect.fail(new Error("port-down")) : Effect.succeed(HttpServerResponse.empty({ status: 200 })),
            waited: s.electricMode === 1 ? Effect.fail(new Error("waited-fail")) : Effect.succeed(HttpServerResponse.empty({ status: 200 })),
            url: "https://e/v1/shape?table=todos&live=true",
            requestId: "0123456789abcdef",
            inFlight
          })
          expect(served.status).toBe(s.electricMode <= 1 ? 503 : 200)
          expect(inFlight.current).toBe(0)

          // 6. ElectricRelay (tableOf, isOverloaded, isTransient, relay)
          expect(ElectricRelay.tableOf("https://e/v1/shape?table=todos")).toBe("todos")
          const overloadErr = Object.assign(new Error("Durable Object is overloaded"), { overloaded: true, retryable: true })
          const transientErr = Object.assign(new Error("connection reset"), { retryable: true })
          const hardErr = new Error("fatal")
          expect(ElectricRelay.isOverloaded(overloadErr)).toBe(true)
          expect(ElectricRelay.isTransient(overloadErr)).toBe(false)
          expect(ElectricRelay.isTransient(transientErr)).toBe(true)

          const relayCall: Effect.Effect<HttpServerResponse.HttpServerResponse, Error> = s.relayMode === 0
            ? Effect.succeed(HttpServerResponse.empty({ status: 200 }))
            : s.relayMode === 1
            ? Effect.fail(overloadErr)
            : s.relayMode === 2
            ? Effect.fail(transientErr)
            : s.relayMode === 3
            ? Effect.fail(hardErr)
            : Effect.interrupt
          const relExit = yield* Effect.exit(
            ElectricRelay.relay(relayCall, true, "0123456789abcdef", "todos")
          )
          if (s.relayMode <= 2) {
            expect(Exit.isSuccess(relExit)).toBe(true)
            if (Exit.isSuccess(relExit)) expect(relExit.value.status).toBe(s.relayMode === 0 ? 200 : 503)
          } else {
            expect(Exit.isFailure(relExit)).toBe(true)
          }
        })
    ))
})
