// Generated properties with an oracle of their own for the branch machines' routing and a CI job's machine
// (worker/branch/Machines.ts, worker/flows/CiJobMachine.ts), work links' authority and writes
// (worker/github/WorkLinks.ts), a write's notice (worker/github/WriteFeed.ts), how a session ends
// (worker/SessionPrior.ts, worker/SessionEnds.ts), the request ray (worker/RequestRay.ts) and Electric's object and
// gateway (infra/ElectricAwake.ts, infra/ElectricRelay.ts). Everything that reads or writes rows runs on this file's
// schema of the compose Postgres, and each property reads the rows back.
import { digestSync } from "@smthrs/crypto"
import { Fuzz } from "@smthrs/fuzz"
import { CiJob, SandboxTools } from "@smthrs/sandbox"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as ElectricAwake from "../infra/ElectricAwake.ts"
import * as ElectricRelay from "../infra/ElectricRelay.ts"
import { workStatusOf } from "../src/features/issues/work.ts"
import { RAY_HEADER } from "../src/requestRay.ts"
import * as RequestRay from "./RequestRay.ts"
import * as SessionEnds from "./SessionEnds.ts"
import * as SessionPrior from "./SessionPrior.ts"
import * as SessionStore from "./SessionStore.ts"
import * as Machines from "./branch/Machines.ts"
import { type SandboxBranch, SandboxStartTimedOut, SandboxUnavailable } from "./branch/Sandboxes.ts"
import * as CiJobMachine from "./flows/CiJobMachine.ts"
import * as WorkLinks from "./github/WorkLinks.ts"
import * as WriteFeed from "./github/WriteFeed.ts"
import { testFile } from "./test/harness.ts"
import { configured, signInHarness } from "./test/signIn.ts"

const runtime = testFile("generated_branch_github_infra")

const options = (seed: number, executions: number) => ({
  seed: Number(process.env.EFFECT_FUZZ_SEED ?? seed),
  executions: Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? executions),
})

/** The property's own log lines stay out of the run's output. */
const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Logger.CurrentLoggers, new Set())

const UNAVAILABLE = "@smthrs/mvp/branch/SandboxUnavailable"
const START_TIMED_OUT = "@smthrs/mvp/branch/SandboxStartTimedOut"
const CHECKOUT_FAILED = "@smthrs/mvp/branch/CheckoutFailed"
const REFUSED = "@smthrs/sandbox/SandboxTools/ToolRefused"
const LOST = "@smthrs/sandbox/SandboxTools/ToolLost"
const TOOL_UNAVAILABLE = "@smthrs/sandbox/SandboxTools/ToolUnavailable"
const MACHINE_UNAVAILABLE = "@smthrs/sandbox/CiJob/MachineUnavailable"

interface Failure {
  readonly tag: string
  readonly reason?: string
  readonly exitCode?: number
  readonly checkoutFailure?: string
  readonly code?: string
}

/** A typed failure's tag and the fields a caller reads, and nothing else. */
const failureOf = (error: object): { readonly failed: Record<string, unknown> } => {
  const fields: Readonly<Record<string, unknown>> = { ...error, _tag: Reflect.get(error, "_tag") }
  return {
    failed: {
      tag: fields["_tag"],
      reason: fields["reason"],
      exitCode: fields["exitCode"],
      checkoutFailure: fields["checkoutFailure"],
      code: fields["code"],
    },
  }
}
const failed = (failure: Failure) => ({
  failed: { tag: failure.tag, reason: failure.reason, exitCode: failure.exitCode, checkoutFailure: failure.checkoutFailure, code: failure.code },
})
const settled = <A, E extends object>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.match({ onFailure: failureOf, onSuccess: (value) => ({ ok: value }) }))

const runResult = (exitCode: number, timedOut = false, stderr = ""): typeof SandboxTools.RunResult.Type => ({
  tool: "run",
  exitCode,
  timedOut,
  stdout: "",
  stderr,
  stdoutBytes: 0,
  stderrBytes: stderr.length,
  truncated: stderr !== "",
})

const PROVIDER_CODE = SandboxTools.ToolUnavailable.fields.code.literals[0]

/** Every answer a machine's object gives a tool call, with the failure `Machines.tool` owes for it. */
const toolAnswers = (generation: number): ReadonlyArray<{ readonly outcome: Machines.ToolOutcome; readonly failure?: Failure }> => [
  { outcome: { _tag: "Done", result: runResult(0), generation } },
  { outcome: { _tag: "Refused", reason: "path" }, failure: { tag: REFUSED, reason: "path" } },
  { outcome: { _tag: "Lost" }, failure: { tag: LOST } },
  { outcome: { _tag: "CheckoutFailed", exitCode: 128, checkoutFailure: "clone" }, failure: { tag: CHECKOUT_FAILED, exitCode: 128, checkoutFailure: "clone" } },
  { outcome: { _tag: "CheckoutFailed" }, failure: { tag: CHECKOUT_FAILED } },
  { outcome: { _tag: "Waiting" }, failure: { tag: UNAVAILABLE, reason: "waiting" } },
  { outcome: { _tag: "Unavailable", reason: "start_timeout" }, failure: { tag: START_TIMED_OUT } },
  { outcome: { _tag: "Unavailable" }, failure: { tag: UNAVAILABLE, reason: "exec" } },
]

const STARTED: typeof SandboxTools.Started.Type = { pid: 10, startedAt: 1_700_000_000_000 }
const OBSERVED: typeof SandboxTools.Observed.Type = { state: "finished", exitCode: 3, timedOut: true }

/** Every answer a machine's object gives a command operation, with the failure an operation it doesn't answer owes. */
const commandAnswers = (generation: number): ReadonlyArray<{ readonly outcome: Machines.CommandOutcome; readonly failure: Failure }> => [
  { outcome: { _tag: "Started", started: STARTED, generation }, failure: { tag: UNAVAILABLE, reason: "exec" } },
  { outcome: { _tag: "Observed", observed: OBSERVED }, failure: { tag: UNAVAILABLE, reason: "exec" } },
  { outcome: { _tag: "Collected", result: runResult(2, false, "boom") }, failure: { tag: UNAVAILABLE, reason: "exec" } },
  { outcome: { _tag: "Cancelled" }, failure: { tag: UNAVAILABLE, reason: "exec" } },
  { outcome: { _tag: "Refused", reason: "not_found" }, failure: { tag: REFUSED, reason: "not_found" } },
  { outcome: { _tag: "Lost" }, failure: { tag: LOST } },
  { outcome: { _tag: "CheckoutFailed", exitCode: 1, checkoutFailure: "branch" }, failure: { tag: CHECKOUT_FAILED, exitCode: 1, checkoutFailure: "branch" } },
  { outcome: { _tag: "ToolUnavailable", code: PROVIDER_CODE, exitCode: 127 }, failure: { tag: TOOL_UNAVAILABLE, code: PROVIDER_CODE, exitCode: 127 } },
  { outcome: { _tag: "ToolUnavailable", code: PROVIDER_CODE }, failure: { tag: TOOL_UNAVAILABLE, code: PROVIDER_CODE } },
  { outcome: { _tag: "Unavailable", reason: "start_timeout" }, failure: { tag: START_TIMED_OUT } },
  { outcome: { _tag: "Unavailable" }, failure: { tag: UNAVAILABLE, reason: "exec" } },
  { outcome: { _tag: "Waiting" }, failure: { tag: UNAVAILABLE, reason: "waiting" } },
]

test("a routed machine answers each tool call, command and sleep with its exact result or typed failure", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    declared: Schema.Boolean,
    named: Schema.Boolean,
    withCallId: Schema.Boolean,
    tool: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    command: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
    sleep: Schema.Literals(["slept", "busy", "gone", "unavailable"]),
    generation: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  }))
  const report = await Effect.runPromise(quiet(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const branch: SandboxBranch = {
      branchId: "branch-1",
      owner: "acme",
      name: "app",
      branch: "feat",
      ...(scenario.named ? { machine: "large" } : {}),
    }
    const tool = toolAnswers(scenario.generation)[scenario.tool]!
    const command = commandAnswers(scenario.generation)[scenario.command]!
    const call: typeof SandboxTools.Run.Type = { tool: "run", command: "echo ok", timeoutSeconds: 10 }
    const kept: Array<readonly [string, number, string | undefined]> = []
    const asked: Array<readonly [string, string | undefined]> = []
    const requests: Array<Machines.CommandRequest> = []
    const slept: Array<readonly [number, number]> = []
    const object: Machines.MachineObject = {
      tool: () => Effect.succeed(tool.outcome),
      command: (_branch, _owner, request) => Effect.sync(() => (requests.push(request), command.outcome)),
      sleepIfIdle: (generation, idleMs) => Effect.sync(() => (slept.push([generation, idleMs]), scenario.sleep)),
    }
    const router = Machines.routed(
      (branchId, machine) => (asked.push([branchId, machine]), scenario.declared ? object : undefined),
      (branchId, generation, machine) => Effect.sync(() => void kept.push([branchId, generation, machine])),
    )
    const undeclared = failed({ tag: UNAVAILABLE, reason: "undeclared" })
    const machine = scenario.named ? "large" : undefined

    // A tool call: its result and generation, and a keep for exactly the generation it ran on.
    expect(yield* settled(Machines.ranOf(tool.outcome))).toEqual(
      tool.failure === undefined ? { ok: { result: runResult(0), generation: scenario.generation } } : failed(tool.failure),
    )
    const ran = yield* settled(router.tool(branch, "owner-1", "call-1", call))
    const done = scenario.declared && tool.failure === undefined
    expect(ran).toEqual(
      !scenario.declared ? undeclared : tool.failure === undefined ? { ok: { result: runResult(0), generation: scenario.generation } } : failed(tool.failure),
    )
    expect(kept).toEqual(done ? [["branch-1", scenario.generation, machine]] : [])
    kept.length = 0

    // The four command operations: only the answer an operation asked for is its success.
    const commands = router.commands(branch, "owner-1", scenario.withCallId ? "call-1" : undefined)
    const answers = {
      start: yield* settled(commands.start(call, "k1")),
      observe: yield* settled(commands.observe("k1", { waitMs: 5 })),
      collect: yield* settled(commands.collect("k1")),
      cancel: yield* settled(commands.cancel("k1")),
    }
    const refusal = scenario.declared ? failed(command.failure) : undeclared
    const tag = scenario.declared ? command.outcome._tag : "Undeclared"
    expect(answers).toEqual({
      start: tag === "Started" ? { ok: STARTED } : refusal,
      observe: tag === "Observed" ? { ok: OBSERVED } : refusal,
      collect: tag === "Collected" ? { ok: runResult(2, false, "boom") } : refusal,
      cancel: tag === "Cancelled" ? { ok: undefined } : refusal,
    })
    expect(requests).toEqual(scenario.declared
      ? [
        { op: "start", key: "k1", call, ...(scenario.withCallId ? { callId: "call-1" } : {}) },
        { op: "observe", key: "k1", waitMs: 5 },
        { op: "collect", key: "k1" },
        { op: "cancel", key: "k1" },
      ]
      : [])
    expect(kept).toEqual(tag === "Started" ? [["branch-1", scenario.generation, machine]] : [])

    // Sleep: the machine's own word, or the typed failure; an undeclared machine is never asked.
    expect(yield* settled(router.sleepIfIdle("branch-1", scenario.generation, 30_000, machine))).toEqual(
      !scenario.declared ? undeclared : scenario.sleep === "unavailable" ? failed({ tag: UNAVAILABLE, reason: "exec" }) : { ok: scenario.sleep },
    )
    expect(slept).toEqual(scenario.declared ? [[scenario.generation, 30_000]] : [])
    expect(asked.every(([branchId, name]) => branchId === "branch-1" && name === machine)).toBe(true)
    return true
  }), options(20261129, 150))))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("a CI job's machine maps each machine answer to the job's checkout, step and release", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    mode: Schema.Literals(["passed", "failed", "unavailable", "start_timeout", "lost", "refused", "checkout"]),
    sleepFails: Schema.Boolean,
    named: Schema.Boolean,
    timeout: Schema.Boolean,
    index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })),
    generation: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
    commit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
  }))
  const report = await Effect.runPromise(quiet(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const target: CiJob.Target = { run: "run-1", repo: "acme/app", sha: scenario.commit.toString(16).repeat(40), ref: "refs/heads/main" }
    const job: CiJob.JobRef = scenario.named ? { name: "test", machine: "large" } : { name: "test" }
    const step: CiJob.Step = { name: "build", run: "pnpm test", ...(scenario.timeout ? { timeoutSeconds: 45 } : {}) }
    const result = scenario.mode === "passed" ? runResult(0) : runResult(3, true, "boom")
    const calls: Array<{ readonly branch: SandboxBranch; readonly owner: string; readonly callId: string; readonly call: SandboxTools.Call }> = []
    const sleeps: Array<ReadonlyArray<unknown>> = []
    const machines = Layer.succeed(Machines.Machines, {
      commands: () => Machines.commandsOver(() => Effect.succeed({ _tag: "Lost" as const }), () => Effect.void),
      tool: (branch, owner, callId, call) => {
        calls.push({ branch, owner, callId, call })
        if (scenario.mode === "passed" || scenario.mode === "failed") return Effect.succeed({ result, generation: scenario.generation })
        if (scenario.mode === "unavailable") return Effect.fail(new SandboxUnavailable({ reason: "exec" }))
        if (scenario.mode === "start_timeout") return Effect.fail(new SandboxStartTimedOut())
        if (scenario.mode === "lost") return Effect.fail(new SandboxTools.ToolLost())
        if (scenario.mode === "refused") return Effect.fail(new SandboxTools.ToolRefused({ reason: "path" }))
        return Machines.ranOf({ _tag: "CheckoutFailed", exitCode: 128 })
      },
      sleepIfIdle: (...args) => {
        sleeps.push(args)
        return scenario.sleepFails ? Effect.fail(new SandboxUnavailable({ reason: "exec" })) : Effect.succeed("slept" as const)
      },
    })
    const answers = yield* Effect.gen(function* () {
      const machine = yield* CiJob.Machine
      return {
        checkout: yield* settled(machine.checkout(target, job)),
        step: yield* settled(machine.run(target, job, scenario.index, step)),
        release: yield* settled(machine.release(target, job)),
      }
    }).pipe(Effect.provide(CiJobMachine.layer.pipe(Layer.provide(machines))))

    const ran = scenario.mode === "passed" || scenario.mode === "failed"
    const retried = scenario.mode === "unavailable" || scenario.mode === "start_timeout"
    expect(answers).toEqual({
      checkout: retried ? failed({ tag: MACHINE_UNAVAILABLE }) : { ok: scenario.mode === "passed" },
      step: retried
        ? failed({ tag: MACHINE_UNAVAILABLE })
        : scenario.mode === "passed"
        ? { ok: { exitCode: 0, timedOut: false } }
        : scenario.mode === "failed"
        ? { ok: { exitCode: 3, timedOut: true, output: { stdout: "", stderr: "boom", truncated: true } } }
        : { ok: { exitCode: CiJobMachine.LOST_EXIT_CODE, timedOut: false } },
      // Best effort: a release never fails, whatever its machine said.
      release: { ok: undefined },
    })
    expect(CiJobMachine.LOST_EXIT_CODE).toBe(-1)

    // Each call names the job's one machine, runs as CI, and has an id of its own.
    const machine = CiJobMachine.machineOf(target, job)
    expect(machine).toMatchObject({ owner: "acme", name: "app", branch: target.sha, forge: "github", kind: "job" })
    expect(machine.branchId).toMatch(/^job-[0-9a-f]{40}$/)
    expect(machine.machine).toBe(scenario.named ? "large" : undefined)
    expect(calls.map(({ branch, owner }) => ({ branch, owner }))).toEqual([0, 1, 2].map(() => ({ branch: machine, owner: "ci" })))
    expect(calls.map(({ call }) => call)).toEqual([
      { tool: "run", command: `test "$(git rev-parse HEAD)" = ${target.sha}`, timeoutSeconds: 60 },
      { tool: "run", command: "pnpm test", timeoutSeconds: scenario.timeout ? 45 : CiJob.limits.defaultTimeoutSeconds },
      { tool: "run", command: CiJobMachine.STOP_LEFTOVERS, timeoutSeconds: 30 },
    ])
    expect(new Set(calls.map(({ callId }) => callId)).size).toBe(3)
    for (const { callId } of calls) expect(callId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // Only a release whose command ran puts the machine to sleep, at once, on the generation it ran on.
    expect(sleeps).toEqual(ran ? [[machine.branchId, scenario.generation, 0, machine.machine]] : [])
    return true
  }), options(20261130, 120))))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("the links route, a post's decoding and its clock skew admit exactly the valid ones", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    owner: Schema.Literals(["acme", "octo-org", "-bad", "%E0%A4%A"]),
    name: Schema.Literals(["widgets", "hello.world"]),
    number: Schema.Literals(["1", "42", "2147483647", "2147483648", "0", "07", "x"]),
    collection: Schema.Literals(["issues", "pulls"]),
    leaf: Schema.Literals(["links", "comments"]),
    extra: Schema.Boolean,
    url: Schema.Literals(["https://github.com/acme/widgets/pull/1", "http://insecure.test/x", "not a url", "absent"]),
    ref: Schema.Literals(["lane-a", " ", "line\nbreak"]),
    kind: Schema.Literals(["pr", "session", "deploy"]),
    at: Schema.Literals(["2026-11-01T10:00:00Z", "2026-11-01 10:00:00", "absent"]),
    links: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    skewMs: Schema.Literals([-60_000, -1, 0, 1, 60_000]),
  }))
  const report = await Effect.runPromise(Fuzz.run(scenarios, (scenario) => Effect.sync(() => {
    const path = `/api/repos/${scenario.owner}/${scenario.name}/${scenario.collection}/${scenario.number}/${scenario.leaf}${scenario.extra ? "/more" : ""}`
    const routed = (scenario.owner === "acme" || scenario.owner === "octo-org") && scenario.collection === "issues" &&
      scenario.leaf === "links" && !scenario.extra && ["1", "42", "2147483647"].includes(scenario.number)
    expect(WorkLinks.parseLinksPath(path)).toEqual(routed ? { owner: scenario.owner, name: scenario.name, number: Number(scenario.number) } : undefined)

    const link = {
      kind: scenario.kind,
      ref: scenario.ref,
      ...(scenario.url === "absent" ? {} : { url: scenario.url }),
      ...(scenario.at === "absent" ? {} : { at: scenario.at }),
    }
    const body = { links: Array.from({ length: scenario.links }, () => link) }
    const valid = scenario.links > 0 && scenario.kind !== "deploy" && scenario.ref === "lane-a" &&
      (scenario.url === "absent" || scenario.url.startsWith("https://")) && scenario.at !== "2026-11-01 10:00:00"
    expect(WorkLinks.decode(JSON.stringify(body))).toEqual(valid ? body : undefined)
    expect(WorkLinks.decode(`${JSON.stringify(body)}}`)).toBeUndefined()

    // A link's time may lead the server's clock by exactly the allowed skew, and no further.
    const now = Date.parse("2026-11-01T10:00:00Z") - WorkLinks.MAX_SKEW_MS - scenario.skewMs
    const dated: WorkLinks.Post = { links: [{ kind: "pr", ref: "1" }, { kind: "session", ref: "s", at: "2026-11-01T10:00:00Z" }] }
    expect(WorkLinks.MAX_SKEW_MS).toBe(300_000)
    expect(WorkLinks.fromTheFuture(dated, now)).toBe(scenario.skewMs > 0)
    expect(WorkLinks.fromTheFuture({ links: [{ kind: "pr", ref: "1" }] }, now)).toBe(false)
    return true
  }), options(20261131, 300)))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const T0 = "2026-11-01T10:00:00Z"
const T1 = "2026-11-01T11:00:00Z"
const T2 = "2026-11-01T12:00:00Z"
const stored = (at: string) => at.replace("Z", ".000000Z")

test("only a current runner or a live scoped machine token writes work links, and each write leaves exactly its rows", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    bearer: Schema.Boolean,
    runner: Schema.Literals(["absent", "removed", "unauthorized", "current", "elsewhere"]),
    installed: Schema.Boolean,
    machine: Schema.Literals(["absent", "live", "revoked", "expired", "unscoped", "elsewhere"]),
    duplicate: Schema.Boolean,
    issue: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const repoId = `github/acme/${crypto.randomUUID()}`
    const other = `github/acme/${crypto.randomUUID()}`
    const runnerToken = `runner-${crypto.randomUUID()}`
    const machineToken = `smm_${crypto.randomUUID()}`
    yield* sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES (${repoId}, ${scenario.installed ? 7 : null})`
    if (scenario.runner !== "absent") {
      yield* sql`INSERT INTO runners (repo_id, name, capacity, token_sha256, added_by, repo_authorized_at, removed_at)
        VALUES (${scenario.runner === "elsewhere" ? other : repoId}, 'lane-host', 1, ${digestSync(runnerToken)}, 'test',
          ${scenario.runner === "unauthorized" ? null : "2026-11-01T00:00:00Z"}::timestamptz,
          ${scenario.runner === "removed" ? "2026-11-01T00:00:00Z" : null}::timestamptz)`
    }
    if (scenario.machine !== "absent") {
      yield* sql`INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at, revoked_at)
        VALUES (${digestSync(machineToken)}, ${scenario.machine === "elsewhere" ? other : repoId}, 'fixer', 'lane-1',
          ${scenario.machine === "unscoped" ? "{issue/create}" : "{issue/create,work/link}"}::text[], 'test',
          now() + ${scenario.machine === "expired" ? "-1 minute" : "1 day"}::interval,
          ${scenario.machine === "revoked" ? "2026-11-01T00:00:00Z" : null}::timestamptz)`
    }
    const links = () => sql<{ kind: string; ref: string; label: string; state: string | null; source: string; at: string }>`
      SELECT kind, ref, label, state, source, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM work_links WHERE repo_id = ${repoId} AND number = ${scenario.issue} ORDER BY kind, ref`

    // Whose token the request carries: no one's, a runner that isn't current, or the runner by name.
    const request = HttpServerRequest.fromWeb(new Request("https://smithers.test/x", {
      headers: scenario.bearer ? { authorization: `Bearer ${runnerToken}` } : {},
    }))
    const known = scenario.runner === "current" || scenario.runner === "unauthorized"
    const current = scenario.runner === "current" && scenario.installed
    expect(Option.getOrUndefined(yield* WorkLinks.runnerOf(request, repoId))).toEqual(
      !scenario.bearer || !known
        ? undefined
        : current
        ? { _tag: "Runner", name: "lane-host", tokenSha256: digestSync(runnerToken) }
        : { _tag: "NotAuthorized" },
    )

    // A person's post writes one row per key (the last duplicate wins); the same post again changes nothing.
    const person: WorkLinks.Post = {
      links: [
        { kind: "session", ref: "lane", state: "working", at: T0 },
        { kind: "queue", ref: "q", state: "queued", at: T0 },
        ...(scenario.duplicate ? [{ kind: "session" as const, ref: "lane", label: "second", state: "working" as const, at: T0 }] : []),
      ],
    }
    const now = Date.parse("2026-11-01T13:00:00Z")
    expect(yield* WorkLinks.write(repoId, scenario.issue, person, "person:maya", now)).toEqual(Option.some({ links: 2, changed: 2 }))
    expect(yield* WorkLinks.write(repoId, scenario.issue, person, "person:maya", now)).toEqual(Option.some({ links: 2, changed: 0 }))
    const model = new Map([
      ["queue/q", { kind: "queue", ref: "q", label: "q", state: "queued", source: "person:maya", at: stored(T0) }],
      ["session/lane", { kind: "session", ref: "lane", label: scenario.duplicate ? "second" : "lane", state: "working", source: "person:maya", at: stored(T0) }],
    ])
    expect(yield* links()).toEqual([...model.values()])

    // A runner's post is written only while the runner is current; a refused one leaves every row as it was.
    const runnerWrote = yield* WorkLinks.write(repoId, scenario.issue,
      { links: [{ kind: "session", ref: "lane", state: "failed", at: T1 }] }, "runner:lane-host", now, { tokenSha256: digestSync(runnerToken) })
    expect(runnerWrote).toEqual(current ? Option.some({ links: 1, changed: 1 }) : Option.none())
    // A newer post replaces the whole link: its label falls back to the ref when the post gives none.
    if (current) model.set("session/lane", { kind: "session", ref: "lane", label: "lane", state: "failed", source: "runner:lane-host", at: stored(T1) })
    expect(yield* links()).toEqual([...model.values()])

    // A machine's post needs its token live and in scope here; even then it never replaces another source's link.
    const machineWrote = yield* WorkLinks.write(repoId, scenario.issue, {
      links: [{ kind: "session", ref: "lane", state: "done", at: T2 }, { kind: "pr", ref: "12", state: "open" }],
    }, "machine:fixer/lane-1", now, undefined, { tokenSha256: digestSync(machineToken) })
    const live = scenario.machine === "live"
    expect(machineWrote).toEqual(live ? Option.some({ links: 2, changed: 1 }) : Option.none())
    if (live) model.set("pr/12", { kind: "pr", ref: "12", label: "12", state: "open", source: "machine:fixer/lane-1", at: "2026-11-01T13:00:00.000000Z" })
    const sorted = [...model.values()].sort((a, b) => `${a.kind}/${a.ref}`.localeCompare(`${b.kind}/${b.ref}`))
    expect(yield* links()).toEqual(sorted)

    // The issues list reads the same rows back, newest first, with the status they give, for this issue only.
    const work = yield* WorkLinks.workOf(repoId, [scenario.issue, scenario.issue + 1])
    expect([...work.keys()]).toEqual([scenario.issue])
    const entry = work.get(scenario.issue)!
    expect(entry.status).toBe(workStatusOf(sorted.map((link) => ({ kind: link.kind as "pr", state: link.state as "open", updatedAt: link.at }))))
    expect(entry.status).toBe(live ? "in_review" : current ? "failed" : "queued")
    expect(entry.links.map((link) => link.updated_at)).toEqual(sorted.map((link) => link.at).sort().reverse())
    expect(entry.links.map((link) => `${link.kind}/${link.ref}/${link.source}/${link.url}`).sort()).toEqual(
      sorted.map((link) => `${link.kind}/${link.ref}/${link.source}/null`).sort(),
    )
    expect((yield* WorkLinks.workOf(repoId, [])).size).toBe(0)
    expect((yield* WorkLinks.workOf(other, [scenario.issue])).size).toBe(0)
    return true
  }), options(20261132, 60)))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("a write's receipt folds into its person's notice once per state, and only for the writes the feed shows", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    op: Schema.Literals(["issue/create", "issue/comment", "branch/publish"]),
    settle: Schema.Literals(["done", "failed", "refused", "pending"]),
    numbered: Schema.Boolean,
    number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9_999 })),
  }))
  const report = await runtime.runPromise(quiet(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = crypto.randomUUID()
    const repo = `acme/${crypto.randomUUID()}`
    const actor = `person-${crypto.randomUUID()}`
    // A branch write whose branch is gone has no name to open, so it folds nothing.
    yield* sql`INSERT INTO github_writes (id, repo_id, actor_id, via, op, payload, payload_hash, branch_id)
      VALUES (${id}, ${`github/${repo}`}, ${actor}, 'agent', ${scenario.op}, '{}'::jsonb, ${digestSync(id)},
        ${scenario.op === "branch/publish" ? crypto.randomUUID() : null}::uuid)`
    const notices = () => sql`
      SELECT recipient, subject, kind, state, mine, quiet, repo_id, title, href, version::int AS version
      FROM notifications WHERE recipient = ${actor}`
    const shown = scenario.op === "issue/create"
    const notice = (state: string, version: number, href: string) => ({
      recipient: actor,
      subject: `write:${id}`,
      kind: "write",
      state,
      mine: true,
      quiet: false,
      repo_id: `github/${repo}`,
      title: "Create issue",
      href,
      version,
    })

    expect(yield* WriteFeed.fold(id)).toBe(shown ? 1 : 0)
    expect(yield* WriteFeed.fold(id)).toBe(0)
    expect(yield* notices()).toEqual(shown ? [notice("working", 1, `/${repo}/issues`)] : [])

    if (scenario.settle !== "pending") {
      yield* sql`UPDATE github_writes SET status = ${scenario.settle}, settled_at = now(),
        failure = ${scenario.settle === "done" ? null : scenario.settle === "failed" ? "unavailable" : "not_allowed"},
        item_number = ${scenario.numbered ? scenario.number : null} WHERE id = ${id}`
    }
    const settledNow = shown && scenario.settle !== "pending"
    expect(yield* WriteFeed.fold(id)).toBe(settledNow ? 1 : 0)
    expect(yield* WriteFeed.fold(id)).toBe(0)
    expect(yield* notices()).toEqual(
      !shown
        ? []
        : !settledNow
        ? [notice("working", 1, `/${repo}/issues`)]
        : [notice(scenario.settle === "done" ? "done" : "failed", 2, scenario.numbered ? `/${repo}/issues/${scenario.number}` : `/${repo}/issues`)],
    )
    expect(yield* WriteFeed.fold(crypto.randomUUID())).toBe(0)
    return true
  }), options(20261133, 60))))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("a session's prior reads live, ended or absent, and each ending leaves its receipts and clears its tokens", async () => {
  const auth = await signInHarness(runtime, { config: { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" } })
  const seen = new Set<string>()
  const scenarios = Arbitrary.schema(Schema.Struct({
    state: Schema.Literals(["live", "stale_generation", "signed_out", "expired", "alias_expired", "erased"]),
    aliasFirst: Schema.Boolean,
  }))
  const report = await runtime.runPromise(quiet(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.promise(() => auth.signInAs())
    const sessions = yield* sql<{ id: string; tag: string; generation: number }>`
      SELECT id, session_tag AS tag, github_token_gen AS generation FROM sessions`
    const session = sessions.find((row) => !seen.has(row.id))!
    seen.add(session.id)
    const alias = crypto.randomUUID()
    yield* SessionStore.createHostSession({ id: alias, tokenDigest: alias, parentId: session.id, host: "alias.test" })
    const [host] = yield* sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`
    const aliasTag = host!.tag

    // How the session ends, if it does: a sign-out, its own deadline, its alias's deadline, or long enough ago to erase.
    if (scenario.state === "stale_generation") {
      expect(yield* SessionEnds.endSession(session.id, "sign_out", session.generation + 1)).toEqual(Option.none())
    }
    if (scenario.state === "signed_out") {
      expect(yield* SessionEnds.endSession(session.id, "sign_out", session.generation)).toEqual(Option.some(session.id))
      expect(yield* SessionEnds.endSession(session.id, "compromised")).toEqual(Option.none())
    }
    if (scenario.state === "expired") yield* sql`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = ${session.id}`
    if (scenario.state === "alias_expired") yield* sql`UPDATE host_sessions SET started_at = now() - interval '401 days' WHERE id = ${alias}`
    if (scenario.state === "erased") {
      yield* sql`UPDATE sessions SET expires_at = now() - interval '31 days' WHERE id = ${session.id}`
      yield* SessionEnds.sweep()
    }

    const homeEnded = scenario.state === "signed_out" || scenario.state === "expired" || scenario.state === "erased"
    const aliasEnded = homeEnded || scenario.state === "alias_expired"
    const reason = scenario.state === "signed_out" ? "sign_out" : "expired"
    const read = Effect.gen(function* () {
      const order = scenario.aliasFirst ? [aliasTag, session.tag] : [session.tag, aliasTag]
      const priors = new Map<string, SessionPrior.Prior>()
      for (const tag of order) priors.set(tag, yield* SessionPrior.read(tag))
      return { home: priors.get(session.tag), alias: priors.get(aliasTag) }
    })
    const persisted = Effect.gen(function* () {
      const [home] = yield* sql`SELECT revoked_at IS NOT NULL AS revoked, revoked_reason AS reason,
        github_access IS NULL AND github_refresh IS NULL AS cleared FROM sessions WHERE id = ${session.id}`
      const [hosted] = yield* sql`SELECT revoked_at IS NOT NULL AS revoked FROM host_sessions WHERE id = ${alias}`
      const receipts = yield* sql<{ tag: string; reason: string }>`SELECT session_tag AS tag, reason FROM session_end_receipts
        WHERE session_tag IN (${session.tag}, ${aliasTag})`
      const [cleanups] = yield* sql`SELECT count(*)::int AS count FROM github_token_cleanups WHERE session_id = ${session.id}`
      return { home, hosted, receipts: Object.fromEntries(receipts.map((receipt) => [receipt.tag, receipt.reason])), cleanups }
    })
    const expected = {
      home: scenario.state === "erased" ? undefined : { revoked: homeEnded, reason: homeEnded ? reason : null, cleared: homeEnded },
      hosted: scenario.state === "erased" ? undefined : { revoked: aliasEnded },
      receipts: { ...(homeEnded ? { [session.tag]: reason } : {}), ...(aliasEnded ? { [aliasTag]: reason } : {}) },
      // The tokens an ended session held are queued for revocation at GitHub, once.
      cleanups: { count: homeEnded ? 1 : 0 },
    }
    const priors = { home: homeEnded ? "ended" : "live", alias: aliasEnded ? "ended" : "live" }

    expect(yield* read).toEqual(priors)
    expect(yield* persisted).toEqual(expected)
    // Retention ends nothing that is live and keeps every ending's answer: reading again changes nothing.
    yield* SessionEnds.sweep()
    expect(yield* read).toEqual(priors)
    expect(yield* persisted).toEqual(expected)
    expect(yield* SessionPrior.read(crypto.randomUUID().replaceAll("-", ""))).toBe("absent")
    return true
  }), options(20261134, 30))))
  expect(Fuzz.formatReport(report)).toBeUndefined()
}, 120_000)

const RETRY_LATER = { "retry-after": "5", "cache-control": "no-store" }
const answerOf = (response: HttpServerResponse.HttpServerResponse) => ({
  status: response.status,
  "retry-after": response.headers["retry-after"],
  "cache-control": response.headers["cache-control"],
})
const counted = (registry: Metric.MetricRegistry, id: string, attributes: Record<string, string> = {}) =>
  Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    .filter((entry) => entry.id === id && Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value))
    .reduce((sum, entry) => sum + (entry.state as { readonly count: number }).count, 0)

test("an API error carries its valid ray, and Electric's object and gateway answer 503 exactly when Electric can't", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    ray: Schema.Literals(["0123456789abcdef-IAD", "0123456789abcdef0123456789abcdef", "short", "0123456789abcdef; drop", "absent"]),
    path: Schema.Literals(["/api/test", "/api", "/page", "/apitest"]),
    status: Schema.Literals([200, 302, 400, 404, 503]),
    steps: Schema.Array(Schema.Struct({ running: Schema.Boolean, holdRefused: Schema.Boolean })).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    startFails: Schema.Boolean,
    wake: Schema.Boolean,
    direct: Schema.Boolean,
    waited: Schema.Boolean,
    live: Schema.Literals(["true", "false", "absent"]),
    requestId: Schema.Literals(["0123456789abcdef", "0123456789ABCDEF", "bad", "absent"]),
    relay: Schema.Literals(["answered", "overloaded", "transient", "both", "failed", "died", "interrupted"]),
  }))
  const report = await Effect.runPromise(quiet(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    // The ray: only Cloudflare's own identifier, only on an API route's error.
    const request = HttpServerRequest.fromWeb(new Request(`https://smithers.test${scenario.path}?q=1`, {
      headers: scenario.ray === "absent" ? {} : { "cf-ray": scenario.ray },
    }))
    const answered = yield* RequestRay.withRequestRay(Effect.succeed(HttpServerResponse.empty({ status: scenario.status }))).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
    const validRay = scenario.ray === "0123456789abcdef-IAD" || scenario.ray === "0123456789abcdef0123456789abcdef"
    expect(answered.status).toBe(scenario.status)
    expect(answered.headers[RAY_HEADER]).toBe(scenario.path === "/api/test" && scenario.status >= 400 && validRay ? scenario.ray : undefined)
    expect(yield* RequestRay.requestRay).toBeUndefined()
    expect(yield* RequestRay.requestRay.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))).toBe(validRay ? scenario.ray : undefined)

    // The waker: starts a stopped container, and sets the hold once per start until Cloudflare accepts it.
    let step = scenario.steps[0]!
    const starts: Array<number> = []
    const holds: Array<number> = []
    const awake = ElectricAwake.logged(ElectricAwake.makeAwake({
      running: Effect.sync(() => step.running),
      start: Effect.sync(() => void starts.push(1)),
      setInactivityTimeout: (ms) => Effect.suspend(() => (holds.push(ms), step.holdRefused ? Effect.fail("refused") : Effect.void)),
    }))
    let held = false
    let expectedStarts = 0
    let expectedHolds = 0
    for (const next of scenario.steps) {
      step = next
      const started = !next.running
      if (started) {
        expectedStarts++
        held = false
      }
      const sets = !held
      if (sets) {
        expectedHolds++
        held = !next.holdRefused
      }
      expect(yield* awake).toEqual({ started, held: sets && held })
      expect(starts.length).toBe(expectedStarts)
      expect(holds).toEqual(Array.from({ length: expectedHolds }, () => 6 * 60 * 60 * 1000))
    }

    // A container start counts once, and only when it succeeded.
    const startRegistry: Metric.MetricRegistry = new Map()
    const start = yield* Effect.exit(
      ElectricAwake.recordStart(scenario.startFails ? Effect.fail("no container instance") : Effect.succeed("started"), "instance-1").pipe(
        Effect.provideService(Metric.MetricRegistry, startRegistry),
      ),
    )
    expect(Exit.isFailure(start) ? { failed: Cause.squash(start.cause) } : { ok: start.value }).toEqual(
      scenario.startFails ? { failed: "no container instance" } : { ok: "started" },
    )
    expect(counted(startRegistry, "electric_container_starts")).toBe(scenario.startFails ? 0 : 1)

    // The object: the direct answer, else the waited one, else 503; it counts a request in flight only while it forwards.
    const inFlight = ElectricAwake.makeInFlight()
    const ran: Array<string> = []
    const send = (name: string, ok: boolean, status: number) =>
      Effect.suspend(() => {
        ran.push(`${name}:${inFlight.current}`)
        return ok ? Effect.succeed(HttpServerResponse.empty({ status })) : Effect.fail(new Error(`${name} down`))
      })
    const url = `https://electric/v1/shape?table=todos${scenario.live === "absent" ? "" : `&live=${scenario.live}`}`
    const served = yield* ElectricAwake.serveObject({
      wake: scenario.wake ? Effect.succeed({ started: true, held: true }) : Effect.fail({ _tag: "ContainerNotRunningError" }),
      direct: send("direct", scenario.direct, 200),
      waited: send("waited", scenario.waited, 206),
      url,
      requestId: scenario.requestId === "absent" ? undefined : scenario.requestId,
      inFlight,
    })
    expect(answerOf(served)).toEqual(
      !scenario.wake || (!scenario.direct && !scenario.waited)
        ? { status: 503, ...RETRY_LATER }
        : { status: scenario.direct ? 200 : 206, "retry-after": undefined, "cache-control": undefined },
    )
    expect(ran).toEqual(!scenario.wake ? [] : scenario.direct ? ["direct:1"] : ["direct:1", "waited:1"])
    expect(inFlight.current).toBe(0)
    expect(ElectricAwake.isLive(url)).toBe(scenario.live === "true")
    expect(ElectricRelay.tableOf(url)).toBe("todos")
    expect(ElectricRelay.tableOf("https://electric/v1/shape")).toBeUndefined()
    expect(ElectricAwake.correlationOf(scenario.requestId === "absent" ? undefined : scenario.requestId)).toBe(
      scenario.requestId === "0123456789abcdef" ? scenario.requestId : "unavailable",
    )
    expect([{ _tag: "MyTag" }, new TypeError("x"), "text", null, 7].map(ElectricAwake.tagOf)).toEqual(["MyTag", "TypeError", "string", "object", "number"])

    // The gateway: an overloaded or transient object is a 503 to retry; any other failure stays the failure it was.
    const overloaded = scenario.relay === "overloaded" || scenario.relay === "both"
    const retryable = scenario.relay === "transient" || scenario.relay === "both"
    const error = Object.assign(new Error("call failed"), overloaded ? { overloaded: true } : {}, retryable ? { retryable: true } : {})
    expect([ElectricRelay.isOverloaded(error), ElectricRelay.isTransient(error)]).toEqual([overloaded, retryable && !overloaded])
    expect(ElectricRelay.isOverloaded({ overloaded: "true" })).toBe(false)
    const call: Effect.Effect<HttpServerResponse.HttpServerResponse, Error> = scenario.relay === "answered"
      ? Effect.succeed(HttpServerResponse.empty({ status: scenario.status }))
      : scenario.relay === "died"
      ? Effect.die(error)
      : scenario.relay === "interrupted"
      ? Effect.interrupt
      : Effect.fail(error)
    const registry: Metric.MetricRegistry = new Map()
    const relayed = yield* Effect.exit(
      ElectricRelay.relay(call, scenario.live === "true", "0123456789abcdef", "todos").pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    )
    const outcome = overloaded ? "overloaded" : retryable ? "transient" : "failed"
    if (scenario.relay === "answered") {
      expect(Exit.isSuccess(relayed) && answerOf(relayed.value)).toEqual({ status: scenario.status, "retry-after": undefined, "cache-control": undefined })
    } else if (overloaded || retryable) {
      expect(Exit.isSuccess(relayed) && answerOf(relayed.value)).toEqual({ status: 503, ...RETRY_LATER })
    } else if (scenario.relay === "interrupted") {
      expect(Exit.isFailure(relayed) && Cause.hasInterruptsOnly(relayed.cause)).toBe(true)
    } else {
      expect(Exit.isFailure(relayed) && Cause.squash(relayed.cause)).toBe(error)
      expect(Exit.isFailure(relayed) && Cause.hasDies(relayed.cause)).toBe(scenario.relay === "died")
    }
    const failure = scenario.relay !== "answered" && scenario.relay !== "interrupted"
    expect(counted(registry, "electric_gateway_failures")).toBe(failure ? 1 : 0)
    expect(counted(registry, "electric_gateway_failures", {
      outcome,
      table: "todos",
      overloaded: String(overloaded),
      retryable: String(retryable),
    })).toBe(failure ? 1 : 0)
    return true
  }), options(20261135, 200))))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
