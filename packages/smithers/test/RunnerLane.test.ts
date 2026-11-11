/**
 * Local lanes: `smthrs runner start` and `smthrs runner serve` with a `runner.json` that names no `origin`, a real jj
 * mirror and the deterministic ACP test agent from `@smthrs/agent`'s fixtures. `runner start` runs as the real
 * executable and in this process; the daemon runs in this process, on its own journals; the lane's run is read through
 * the real `smthrs runs` commands on the lanes root.
 */
import { Cause, Effect, Fiber } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
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
      await Lanes.until(async () => (await lanes.statusOf(runId)) === "completed", 120_000, "run completed")
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

  test("runner start refuses what the daemon couldn't run, and queues the rest with the base resolved", async () => {
    const brief = lanes.brief("add the line `alpha` to `NOTES.md`")
    expect(await started(startOptions(brief, { profile: "other" }))).toBe("no profile other in runner.json")
    expect(await started(startOptions(brief, { repository: "other" }))).toBe("no repository other in runner.json")
    expect(await started(startOptions(join(lanes.root, "missing.md")))).toBe("the brief file can't be read")
    expect(await started(startOptions(lanes.brief(" \n")))).toBe("the brief file is empty")
    expect(await started(startOptions(brief, { base: "nothing-here" })))
      .toBe("--base nothing-here names no single commit in the mirror")
    expect(await started(startOptions(brief, { maxHours: 13 }))).toBe("--max-hours is 1 to 12 and --restarts 0 to 5")
    const queued = await started(startOptions(brief, { base: lanes.mirror.base, standing: true }))
    expect(queued).toMatchObject({ base: lanes.mirror.base, standing: true })
    const id = (queued as { readonly request: string }).request
    expect(JSON.parse(readFileSync(LaneIntake.paths(lanes.stateDir).request(id), "utf8"))).toEqual({
      id,
      input: { ...laneInput(), standing: true }
    })
    lanes.configure({ origin: "https://smithers.example" })
    expect(await started(startOptions(brief))).toBe("runner start needs a runner.json with no origin")
    lanes.configure({ stateDir: join(LaneIntake.paths(lanes.stateDir).request(id), "under-a-file") })
    expect(await started(startOptions(brief))).toBe("the lane request can't be written")
  })
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
