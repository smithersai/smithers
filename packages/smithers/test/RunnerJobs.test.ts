/**
 * `RunnerJobs`: a flow host's job store for a local runner, in another process than the runner's daemon. The protocol
 * runs over real files against the daemon's real store (`LocalJobs`) on a test clock; the end-to-end test runs an
 * external agent step on its own engine against a real `smthrs runner serve` process, a real jj mirror and the
 * deterministic ACP test agent, with nothing between the two but the runner's state directory.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as ExternalAgent from "@smthrs/agent/ExternalAgent"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Exit, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as RunnerJobs from "../src/RunnerJobs.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const HOUR = 3_600_000
const task = (profile = "coder"): AgentRunner.Task => ({
  agent: { name: "issue-sweep", labels: [], profile, maxHours: 1, restarts: 1 },
  repository: "github/acme/app",
  base: "a".repeat(40),
  system: [],
  prompt: "do it",
  limits: { files: 10, bytes: 1000 }
})
const claimAll = { profiles: ["coder"], free: 1, running: [], waitSeconds: 0 }
const done: AgentRunner.Outcome = {
  _tag: "Done",
  changes: { additions: [{ path: "NOTES.md", contents: "YWxwaGEK" }], deletions: [] },
  summary: "ok",
  usage: {}
}

describe("RunnerJobs over the daemon's store", () => {
  let stateDir = ""
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "runner-jobs-client-"))
  })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  /** Runs `body` with the flow host's client and the daemon's store over one state directory, on a test clock. */
  const run = <A, E>(
    body: (
      client: AgentRunner.AgentJobs["Service"],
      daemon: LocalJobs.Store,
      admit: Effect.Effect<void, unknown, FileSystem.FileSystem>
    ) => Effect.Effect<A, E, FileSystem.FileSystem>
  ) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* RunnerJobs.make(stateDir)
        const daemon = yield* LocalJobs.make(stateDir)
        return yield* body(client, daemon, RunnerJobs.admitAll(stateDir, daemon.jobs))
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestClock.layer(), NodeServices.layer)))
    )
  const requests = () => {
    const dir = RunnerJobs.paths(stateDir).dir
    return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : []
  }

  test("a start waits for the daemon as Running, is admitted once, and reads the runner's settlement", () =>
    run((client, daemon, admit) =>
      Effect.gen(function*() {
        yield* client.start(task(), "issue#g1")
        expect(requests()).toEqual([`${LocalJobs.fileOf("issue#g1")}.start.json`])
        // The daemon hasn't admitted it: the step waits rather than starting another generation.
        expect(yield* client.status("issue#g1")).toEqual({ _tag: "Running" })
        yield* admit
        expect(requests()).toEqual([])
        expect(yield* daemon.jobs.status("issue#g1")).toEqual({ _tag: "Running" })
        // Once the job is the store's, a start of the same key writes nothing.
        yield* client.start(task(), "issue#g1")
        expect(requests()).toEqual([])
        const job = (yield* daemon.host.claim(claimAll))!
        expect(job.task).toEqual(task())
        expect(yield* client.status("issue#g1")).toEqual({ _tag: "Running" })
        yield* daemon.host.settle({ key: "issue#g1", claim: job.claim, outcome: done })
        expect(yield* client.status("issue#g1")).toEqual({ _tag: "Ended", outcome: done })
        // A key nobody asked for reads as another generation.
        expect(yield* client.status("issue#g2")).toEqual({ _tag: "Again" })
      })
    ))

  test("a cancel of a key not started yet wins over its start, in either order", () =>
    run((client, daemon, admit) =>
      Effect.gen(function*() {
        yield* client.cancel("early#g1")
        expect(yield* client.status("early#g1")).toEqual({ _tag: "Running" })
        yield* client.start(task(), "early#g1")
        yield* admit
        expect(yield* client.status("early#g1")).toMatchObject({ _tag: "Ended", outcome: { _tag: "Cancelled" } })
        yield* client.start(task(), "late#g1")
        yield* admit
        yield* client.cancel("late#g1")
        yield* admit
        expect(yield* client.status("late#g1")).toMatchObject({ _tag: "Ended", outcome: { _tag: "Cancelled" } })
        expect(yield* daemon.host.claim(claimAll)).toBeNull()
      })
    ))

  test("a retryable end reads Again, and an open job past its deadline reads timeout before the daemon writes it", () =>
    run((client, daemon, admit) =>
      Effect.gen(function*() {
        yield* client.start(task(), "retry#g1")
        yield* admit
        const job = (yield* daemon.host.claim(claimAll))!
        yield* daemon.host.settle({ key: "retry#g1", claim: job.claim, outcome: { _tag: "Retryable" } })
        expect(yield* client.status("retry#g1")).toEqual({ _tag: "Again" })
        yield* client.start(task("nobody"), "stuck#g1")
        yield* admit
        yield* TestClock.adjust(HOUR)
        expect(yield* client.status("stuck#g1")).toEqual({
          _tag: "Ended",
          outcome: { _tag: "Failed", reason: "timeout" }
        })
      })
    ))

  test("a request that doesn't decode is set aside; a job file that doesn't decode is unavailable", () =>
    run((client, _daemon, admit) =>
      Effect.gen(function*() {
        const at = RunnerJobs.paths(stateDir)
        mkdirSync(at.dir, { recursive: true })
        writeFileSync(join(at.dir, "junk.start.json"), "{")
        // A request filed under another key's name is refused too.
        writeFileSync(at.request("a#g1", "start"), JSON.stringify({ _tag: "Start", key: "b#g1", task: task() }))
        yield* admit
        expect(requests().sort()).toEqual(
          [`${LocalJobs.fileOf("a#g1")}.start.json.rejected`, "junk.start.json.rejected"].sort()
        )
        mkdirSync(LocalJobs.paths(stateDir).jobs, { recursive: true })
        writeFileSync(at.job("bad#g1"), "not json")
        const exit = yield* Effect.exit(client.status("bad#g1"))
        expect(exit).toEqual(Exit.fail(new AgentRunner.AgentJobsUnavailable()))
      })
    ))
})

describe("RunnerJobs layers", () => {
  const saved = process.env[RunnerJobs.CONFIG_VARIABLE]
  afterEach(() => {
    if (saved === undefined) delete process.env[RunnerJobs.CONFIG_VARIABLE]
    else process.env[RunnerJobs.CONFIG_VARIABLE] = saved
  })
  const statusThrough = (layer: Layer.Layer<AgentRunner.AgentJobs, unknown>) =>
    Effect.runPromiseExit(AgentRunner.AgentJobs.use((jobs) => jobs.status("k#g1")).pipe(Effect.provide(layer)))

  test("with no runner configured, the layer builds and every operation is unavailable", async () => {
    delete process.env[RunnerJobs.CONFIG_VARIABLE]
    expect(await statusThrough(RunnerJobs.layerFromEnvironment))
      .toEqual(Exit.fail(new AgentRunner.AgentJobsUnavailable()))
  })

  test("a runner.json that names an origin is refused: its jobs are the hosted store's", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-jobs-origin-"))
    try {
      const path = join(root, "runner.json")
      writeFileSync(
        path,
        JSON.stringify({
          name: "r",
          origin: "https://example.test",
          capacity: 1,
          stateDir: join(root, "state"),
          repositories: {},
          profiles: { p: { argv: ["agent"] } }
        })
      )
      const exit = await statusThrough(RunnerJobs.layer(path))
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toMatch(/no origin|runner\.json/)
      process.env[RunnerJobs.CONFIG_VARIABLE] = path
      expect(await statusThrough(RunnerJobs.layerFromEnvironment))
        .toEqual(Exit.fail(new AgentRunner.AgentJobsUnavailable()))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("an external agent step on another engine, worked by a real runner daemon", () => {
  let lanes: Lanes.Lanes
  beforeEach(() => {
    lanes = Lanes.make()
  })
  afterEach(() => lanes.close())

  const Session = ExternalAgent.make("runner-jobs/test/Session", {
    payload: { base: Schema.String },
    task: ({ base }) => ({
      agent: { name: "issue-sweep", labels: [], profile: "test-agent", maxHours: 1, restarts: 1 },
      repository: Lanes.REPOSITORY,
      base,
      system: [],
      prompt: "add the line `alpha` to `NOTES.md`",
      limits: { files: 10, bytes: 1_000_000 }
    })
  })
  const Caller = Flow.make("runner-jobs/test/Caller", {
    payload: { base: Schema.String },
    success: ExternalAgent.Result,
    error: Session.errorSchema,
    body: ({ base }) => Session.call({ base })
  })

  test("the step's job is queued through files, run by the daemon, and its change comes back", async () => {
    const daemon = lanes.daemon()
    const engine = Layer.mergeAll(Session.toLayer(), Interpreter.layer(Caller)).pipe(
      Layer.provideMerge(RunnerJobs.layer(lanes.configPath)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const exit = await Effect.runPromiseExit(
      Caller.execute({ base: lanes.mirror.base }, { executionId: "issue-7" }).pipe(Effect.provide(engine))
    )
    expect(Exit.isSuccess(exit), `${JSON.stringify(exit)}\n${daemon.log()}`).toBe(true)
    const result = (exit as Exit.Success<ExternalAgent.Result>).value
    expect(result.generation).toBe(1)
    const notes = result.changes.additions.find((addition) => addition.path === "NOTES.md")
    expect(Buffer.from(notes!.contents, "base64").toString()).toContain("alpha")
    expect(lanes.jobs().map((row) => [row.generation, row.status])).toEqual([[1, "done"]])
    expect(readdirSync(RunnerJobs.paths(lanes.stateDir).dir)).toEqual([])
  }, 180_000)
})
