/**
 * Local lanes: `smthrs runner start` and `smthrs runner serve` with a `runner.json` that names no `origin`, a real jj
 * mirror and the deterministic ACP test agent from `@smthrs/agent`'s fixtures. `runner start` runs as the real
 * executable and in this process; the daemon runs in this process, on its own journals; the lane's run is read through
 * the real `smthrs runs` commands on the lanes root.
 */
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Cause, Effect, Fiber, Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Config from "../src/runner/Config.ts"
import * as Lane from "../src/runner/Lane.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

let lanes: Lanes.Lanes
let serving: Fiber.Fiber<unknown, unknown> | undefined

const serve = () => {
  serving = Effect.runFork(
    RunnerCmd.serve(lanes.configPath).pipe(
      Effect.tapCause((cause) => Effect.sync(() => console.error("serve ended", Cause.pretty(cause))))
    )
  )
}

const startOptions = (brief: string, changes: Partial<RunnerCmd.StartOptions> = {}): RunnerCmd.StartOptions => ({
  brief,
  config: lanes.configPath,
  profile: "test-agent",
  repository: Lanes.REPOSITORY,
  standing: false,
  maxHours: 1,
  restarts: 1,
  ...changes
})

/** `RunnerCmd.start`'s refusal message, or the request it queued. */
const started = (options: RunnerCmd.StartOptions) =>
  Effect.runPromise(RunnerCmd.start(options).pipe(Effect.catch((error) => Effect.succeed(error.message))))

beforeEach(() => {
  lanes = Lanes.make()
})

afterEach(async () => {
  if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
  serving = undefined
  await lanes.close()
})

describe("smthrs runner, its own host", () => {
  test(
    "a one-shot lane is a run in runs list while it works, ends completed, and its checkout is removed",
    async () => {
      lanes.configure({
        workstreams: { alpha: { title: "Alpha", tasks: [{ id: "notes", title: "Write the notes" }] } }
      })
      const queued = await lanes.smthrs([
        "runner",
        "start",
        lanes.brief("talk for 20 seconds\nadd the line `alpha` to `NOTES.md`"),
        "--config",
        lanes.configPath,
        "--profile",
        "test-agent",
        "--repository",
        Lanes.REPOSITORY,
        "--workstream",
        "alpha",
        "--task",
        "notes",
        "--format",
        "json"
      ])
      expect(queued.code, queued.stdout + queued.stderr).toBe(0)
      const { request, base, standing } = JSON.parse(queued.stdout) as Awaited<ReturnType<typeof started>> & object
      expect([base, standing]).toEqual([lanes.mirror.base, false])
      serve()
      const runId = await lanes.admitted(request)
      await Lanes.until(() => !existsSync(LaneIntake.paths(lanes.stateDir).request(request)), 10_000, "request gone")
      // While its agent works in its checkout, the lane is an open run: parked between its step's probes.
      await Lanes.until(() => lanes.checkouts().length > 0, 60_000, "checkout made")
      expect(["running", "parked"]).toContain(await lanes.statusOf(runId))
      // runner status reads the task's state from the lane's run: doing while it works, done once it completed.
      const notes = await lanes.workstreams()
      expect(notes).toMatchObject([{ id: "alpha", status: "active", progress: { done: 0, total: 1 } }])
      expect(notes[0]!.tasks[0]).toMatchObject({
        id: "notes",
        status: "doing",
        owners: [{ request, runId, profile: "test-agent", standing: false }]
      })
      await Lanes.until(async () => (await lanes.statusOf(runId)) === "completed", 120_000, "run completed")
      expect(await lanes.workstreams()).toMatchObject([{
        status: "done",
        progress: { done: 1, total: 1 },
        tasks: [{ id: "notes", status: "done", owners: [{ runId, status: "completed" }] }]
      }])
      await Lanes.until(() => lanes.checkouts().length === 0, 60_000, "checkout removed")
      expect(lanes.workspaces()).toEqual(["default"])
      for (const pid of lanes.agentPids()) await Lanes.until(() => !Lanes.alive(pid), 10_000, "agent gone")
      const [job] = lanes.jobs()
      expect(job).toMatchObject({ status: "done", generation: 1, runId })
      expect(job!.task?.prompt).toBe("talk for 20 seconds\nadd the line `alpha` to `NOTES.md`")
      const events = lanes.transcript(job!.key)
      expect(events.map((event) => event.seq)).toEqual(events.map((_, n) => n))
      expect(events.at(-1)?.kind).toBe("_smithers/end")
      // A request that doesn't decode, and one whose id was admitted already, are set aside; one the daemon can't read
      // is tried again.
      const at = LaneIntake.paths(lanes.stateDir)
      writeFileSync(at.request("00000000-0000-4000-8000-000000000000"), "{")
      writeFileSync(
        at.request(request),
        JSON.stringify({ id: request, input: laneInput() })
      )
      mkdirSync(at.request("ffffffff-0000-4000-8000-000000000000"))
      await Lanes.until(
        () => existsSync(`${at.request("00000000-0000-4000-8000-000000000000")}.rejected`),
        60_000,
        "undecodable request set aside"
      )
      await Lanes.until(() => existsSync(`${at.request(request)}.rejected`), 60_000, "reused request set aside")
      expect(existsSync(at.request("ffffffff-0000-4000-8000-000000000000"))).toBe(true)
    },
    300_000
  )

  test(
    "a standing lane runs round after round in one run from main as it moves; runs cancel stops its agent and removes its checkout",
    async () => {
      // Queued while no daemon runs: admitted when one starts.
      const { request } = await Effect.runPromise(
        RunnerCmd.start(
          startOptions(lanes.brief("add the line `alpha` to `NOTES.md`\nrun `sleep 150`"), { standing: true })
        )
      )
      serve()
      const runId = await lanes.admitted(request)
      // main moves while the first round works: the second round starts from where it is then.
      await Lanes.until(() => lanes.jobs().some((job) => job.status === "claimed"), 120_000, "first round claimed")
      const moved = lanes.advanceMain()
      // The second round's agent is at work in a checkout of its own. A cancel reaches it at its step's next probe, up
      // to 30 s apart, so each round's agent works long enough for that.
      await Lanes.until(
        () =>
          lanes.jobs().filter((job) => job.status === "claimed" && job.generation === 1).length === 1 &&
          lanes.jobs().filter((job) => job.status === "done").length >= 1,
        600_000,
        "second round working"
      )
      const rounds = lanes.jobs()
      expect(new Set(rounds.map((job) => job.runId))).toEqual(new Set([runId]))
      expect(new Set(rounds.map((job) => job.origin)).size).toBe(rounds.length)
      expect(rounds.map((job) => [job.status, job.task?.base]).sort()).toEqual([
        ["claimed", moved],
        ["done", lanes.mirror.base]
      ])
      expect(rounds.every((job) => job.task?.prompt === "add the line `alpha` to `NOTES.md`\nrun `sleep 150`")).toBe(
        true
      )
      // A cancelled run's receipt exits 130.
      const cancelled = await lanes.smthrs(["runs", "cancel", runId, "--root", lanes.stateDir, "--json"])
      expect(JSON.parse(cancelled.stdout), cancelled.stderr).toMatchObject({ _tag: "Terminal", status: "cancelled" })
      await Lanes.until(async () => (await lanes.statusOf(runId)) === "cancelled", 120_000, "run cancelled")
      for (const pid of lanes.agentPids()) await Lanes.until(() => !Lanes.alive(pid), 60_000, "agent gone")
      await Lanes.until(() => lanes.jobs().every((job) => job.status !== "claimed" && job.status !== "queued"), 60_000)
      expect(lanes.jobs().filter((job) => job.status === "cancelled")).toMatchObject([
        { outcome: { _tag: "Cancelled", processTreeGone: true } }
      ])
      await Lanes.until(() => lanes.checkouts().length === 0, 60_000, "checkouts removed")
      expect(lanes.workspaces()).toEqual(["default"])
    },
    900_000
  )

  test("runs steer reaches the lane's agent in its turn, and the steer reads delivered", async () => {
    const { request } = await Effect.runPromise(
      RunnerCmd.start(startOptions(lanes.brief("run `sleep 40`\nadd the line `alpha` to `NOTES.md`")))
    )
    serve()
    const runId = await lanes.admitted(request)
    await Lanes.until(() => lanes.jobs().some((job) => job.status === "claimed"), 60_000, "job claimed")
    await Lanes.until(() => lanes.agentPids().length > 0, 60_000, "agent started")
    const steered = await lanes.smthrs([
      "runs",
      "steer",
      runId,
      "--message",
      "add the line `steered` to `S.md`",
      "--root",
      lanes.stateDir,
      "--json"
    ])
    expect(steered.code, steered.stdout + steered.stderr).toBe(0)
    await Lanes.until(() => existsSync(join(lanes.agentState, "steered.log")), 90_000, "agent took the steer")
    await Lanes.until(async () => (await lanes.statusOf(runId)) === "completed", 120_000, "run completed")
    const [job] = lanes.jobs()
    if (job?.outcome?._tag !== "Done") throw new Error(`job ended ${JSON.stringify(job?.outcome)}`)
    expect(job.outcome.changes.additions.map((file) => [file.path, Buffer.from(file.contents, "base64").toString()]))
      .toEqual([["NOTES.md", "alpha\n"], ["S.md", "steered\n"]])
    expect(lanes.transcript(job.key).some((event) => event.kind === "_smithers/steer")).toBe(true)
    // Delivered: the run has nothing pending.
    const listed = (await lanes.runs(["list"])) as {
      readonly items: ReadonlyArray<{ readonly runId: string; readonly steering?: { readonly pending: number } }>
    }
    expect(listed.items.find((item) => item.runId === runId)?.steering).toEqual({ pending: 0 })
  }, 300_000)

  test("runner start refuses what the daemon couldn't run, and queues the rest with the base resolved", async () => {
    const brief = lanes.brief("add the line `alpha` to `NOTES.md`")
    expect(await started(startOptions(brief, { profile: "other" }))).toBe("no profile other in runner.json")
    expect(await started(startOptions(brief, { repository: "other" }))).toBe("no repository other in runner.json")
    expect(await started(startOptions(join(lanes.root, "missing.md")))).toBe("the brief file can't be read")
    expect(await started(startOptions(lanes.brief(" \n")))).toBe("the brief file is empty")
    expect(await started(startOptions(brief, { base: "nothing-here" })))
      .toBe("--base nothing-here names no single commit in the mirror")
    expect(await started(startOptions(brief, { maxHours: 13 }))).toBe("--max-hours is 1 to 12 and --restarts 0 to 5")
    expect(await started(startOptions(brief, { workstream: "alpha" }))).toBe("--workstream and --task go together")
    expect(await started(startOptions(brief, { task: "notes" }))).toBe("--workstream and --task go together")
    expect(await started(startOptions(brief, { title: "Notes" }))).toBe("--title needs --workstream and --task")
    expect(await started(startOptions(brief, { workstream: "alpha", task: "notes" })))
      .toBe("no workstream alpha in runner.json")
    lanes.configure({ workstreams: { alpha: { title: "Alpha" } } })
    for (const bad of [{ task: "Notes" }, { task: "notes", title: "" }]) {
      expect(await started(startOptions(brief, { workstream: "alpha", ...bad })))
        .toBe("--task is lowercase letters, digits and -, and --title is not empty")
    }
    const task = await started(startOptions(brief, { workstream: "alpha", task: "notes", title: "Write the notes" }))
    expect(
      JSON.parse(
        readFileSync(LaneIntake.paths(lanes.stateDir).request((task as { readonly request: string }).request), "utf8")
      )
        .input.task
    ).toEqual({ workstream: "alpha", id: "notes", title: "Write the notes" })
    const queued = await started(startOptions(brief, { base: lanes.mirror.base, standing: true }))
    expect(queued).toMatchObject({ base: lanes.mirror.base, standing: true })
    const id = (queued as { readonly request: string }).request
    expect(JSON.parse(readFileSync(LaneIntake.paths(lanes.stateDir).request(id), "utf8"))).toEqual({
      id,
      input: { ...laneInput(), standing: true, follow: lanes.mirror.base }
    })
    lanes.configure({ origin: "https://smithers.example" })
    expect(await started(startOptions(brief))).toBe("runner start needs a runner.json with no origin")
    lanes.configure({ stateDir: join(LaneIntake.paths(lanes.stateDir).request(id), "under-a-file") })
    expect(await started(startOptions(brief))).toBe("the lane request can't be written")
  })
})

describe("runner/Lane/Base", () => {
  const Round = Flow.make("test/Lane/Base", {
    description: "Resolve a standing lane's next base.",
    payload: Schema.Struct({ repository: Schema.String, follow: Schema.String, last: Schema.String }),
    success: Schema.String,
    body: Node.capture({ base: Lane.Base.name }, (payload) => Lane.Base.call(payload))
  })

  test(
    "resolves the followed revision as it moved; keeps the last base when it names no commit or no mirror",
    async () => {
      const moved = lanes.advanceMain()
      const bases = await Effect.runPromise(
        Effect.gen(function*() {
          const config = yield* Config.load(lanes.configPath)
          const engine = NodeRuntime.layerHost(
            { filename: join(lanes.root, "base.db"), workspaceRoot: lanes.root, owner: { hostId: "runner-test" } },
            Interpreter.layerWithImplementations(Round, Lane.baseLayer(config))
          )
          const base = (follow: string, repository: string = Lanes.REPOSITORY) =>
            Round.execute({ repository, follow, last: lanes.mirror.base }, {
              executionId: `base-${follow}-${repository}`
            })
              .pipe(Effect.provide(engine))
          return [yield* base("main"), yield* base("nothing-here"), yield* base("main", "gone")]
        }).pipe(Effect.scoped)
      )
      expect(bases).toEqual([moved, lanes.mirror.base, lanes.mirror.base])
    },
    120_000
  )
})

/** The lane input `runner start` writes for the one-line brief at the mirror's base. */
const laneInput = () => ({
  brief: "add the line `alpha` to `NOTES.md`",
  profile: "test-agent",
  repository: Lanes.REPOSITORY,
  base: lanes.mirror.base,
  limits: RunnerCmd.LANE_LIMITS,
  maxHours: 1,
  restarts: 1,
  standing: false
})
