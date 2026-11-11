/**
 * A local lane's daemon stopped mid-job, by SIGKILL or SIGTERM, and started again: the lane's run, the agent's
 * session and the job all go on with no `runs resume`. Real `smthrs runner serve` processes, a real jj mirror and the
 * deterministic ACP test agent.
 */
import { Effect } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

let lanes: Lanes.Lanes
beforeEach(() => {
  lanes = Lanes.make()
})
afterEach(() => lanes.close())

test.each(["SIGKILL", "SIGTERM"] as const)(
  "a daemon stopped mid-job (%s) and started again finishes the lane: no resume, the session resumed, one job",
  async (signal) => {
    const { request } = await Effect.runPromise(RunnerCmd.start({
      brief: lanes.brief("add the line `alpha` to `NOTES.md`\nrun `sleep 3`\nadd the line `beta` to `NOTES.md`"),
      config: lanes.configPath,
      profile: "test-agent",
      repository: Lanes.REPOSITORY,
      standing: false,
      maxHours: 1,
      restarts: 1
    }))
    const first = lanes.daemon()
    const runId = await lanes.admitted(request)
    await Lanes.until(
      () =>
        lanes.checkouts().some((name) => {
          const notes = join(lanes.stateDir, "work", name, "NOTES.md")
          return existsSync(notes) && readFileSync(notes, "utf8") === "alpha\n"
        }),
      90_000,
      "agent wrote alpha"
    )
    // The prompt's event is in the spool: an update still in the agent's pipe when a runner dies never reached it.
    await Lanes.until(
      () =>
        readdirSync(join(lanes.stateDir, "spool")).some((name) =>
          readFileSync(join(lanes.stateDir, "spool", name), "utf8").includes("user_message_chunk")
        ),
      60_000,
      "prompt spooled"
    )
    const [agent] = lanes.agentPids()
    first.child.kill(signal)
    await Lanes.until(() => first.child.exitCode !== null || first.child.signalCode !== null, 30_000, "daemon stopped")
    await Lanes.until(() => !Lanes.alive(agent!), 30_000, "agent gone")
    const second = lanes.daemon()
    await Lanes.until(
      async () => (await lanes.statusOf(runId)) === "completed",
      150_000,
      `run completed; first daemon:\n${first.log()}\nsecond daemon:\n${second.log()}`
    )
    const jobs = lanes.jobs()
    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job).toMatchObject({ status: "done", generation: 1, runId })
    if (job?.outcome?._tag !== "Done") return
    expect(job.outcome.changes.additions.map((file) => [file.path, Buffer.from(file.contents, "base64").toString()]))
      .toEqual([["NOTES.md", "alpha\nbeta\n"]])
    // The second daemon loaded the agent's session and told it to continue; the transcript runs on, one seq each.
    const events = lanes.transcript(job.key)
    expect(events.map((event) => event.seq)).toEqual(events.map((_, n) => n))
    expect(
      events.filter((event) => event.kind === "user_message_chunk")
        .map((event) => String(event.update.content.text).split("\n")[0])
    ).toEqual(["add the line `alpha` to `NOTES.md`", "Continue"])
    await Lanes.until(() => lanes.checkouts().length === 0, 60_000, "checkout removed")
    expect(lanes.workspaces()).toEqual(["default"])
  },
  400_000
)
