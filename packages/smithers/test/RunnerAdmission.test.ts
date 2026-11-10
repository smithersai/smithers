/**
 * Half-load admission (decision 0144): a runner claims only while its host is under half load and over its disk
 * floor. The readings are injected, so each case is the machine it names, not the machine running the test.
 */
import { Effect, Fiber } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.vibe"
import * as Admission from "../src/runner/Admission.ts"
import * as Config from "../src/runner/Config.ts"
import type * as Machine from "../src/runner/Machine.ts"
import * as Host from "./fixtures/runner/host.ts"

const policy: Admission.Policy = { loadPerCpu: 0.5, diskFloorGb: 40, jobLoad: 1 }
const reading = (load1: number, more: Partial<Machine.Reading> = {}): Machine.Reading => ({
  cpus: 48,
  load1,
  diskFreeGb: 200,
  ...more
})

describe("admission", () => {
  test("holds a host at or over half its CPUs, and admits one under", () => {
    expect(Admission.decide(policy, Admission.initial, reading(30), 0).held).toBe("load 30/24")
    expect(Admission.decide(policy, Admission.initial, reading(24), 0).held).toBe("load 24/24")
    expect(Admission.decide(policy, Admission.initial, reading(23.9), 0).held).toBeUndefined()
    expect(Admission.decide(policy, Admission.initial, reading(207), 0).held).toBe("load 207/24")
  })

  test("the limit is the configured share of the CPUs", () => {
    expect(Admission.decide({ ...policy, loadPerCpu: 1 }, Admission.initial, reading(30), 0).held).toBeUndefined()
    expect(Admission.decide({ ...policy, loadPerCpu: 0.25 }, Admission.initial, reading(13), 0).held).toBe("load 13/12")
  })

  test("holds under the disk floor before it reads the load", () => {
    expect(Admission.decide(policy, Admission.initial, reading(1, { diskFreeGb: 31.4 }), 0).held).toBe("disk 31G/40G")
    expect(Admission.decide(policy, Admission.initial, reading(1, { diskFreeGb: 40 }), 0).held).toBeUndefined()
  })

  test("a fact the machine can't read doesn't hold it", () => {
    expect(Admission.decide(policy, Admission.initial, { cpus: 48 }, 0).held).toBeUndefined()
  })

  test("one spike doesn't hold a host that was under, and one dip doesn't free a host that was over", () => {
    let state = Admission.initial
    for (let t = 0; t <= 60_000; t += 2000) state = Admission.decide(policy, state, reading(12), t).state
    const spike = Admission.decide(policy, state, reading(60), 62_000)
    expect(spike.held).toBeUndefined()
    state = Admission.initial
    for (let t = 0; t <= 60_000; t += 2000) state = Admission.decide(policy, state, reading(40), t).state
    expect(Admission.decide(policy, state, reading(5), 62_000).held).toMatch(/^load \d+(\.\d)?\/24$/)
    // A load that stays over holds the host within a minute.
    state = Admission.initial
    for (let t = 0; t <= 60_000; t += 2000) state = Admission.decide(policy, state, reading(12), t).state
    let held: string | undefined
    for (let t = 62_000; t <= 122_000; t += 2000) ({ state, held } = Admission.decide(policy, state, reading(40), t))
    expect(held).toMatch(/^load/)
  })

  test("counts the jobs it just claimed until their load can show, so a host at 0.49 takes one, not ten", () => {
    let state = Admission.decide(policy, Admission.initial, reading(23.5), 0).state
    let admitted = 0
    for (let t = 0; t < 10_000; t += 1000) {
      const decision = Admission.decide(policy, state, reading(23.5), t)
      state = decision.state
      if (decision.held === undefined) {
        admitted++
        state = Admission.claimed(state, t)
      }
    }
    expect(admitted).toBe(1)
    expect(Admission.decide(policy, state, reading(23.5), 10_000).held).toBe("load 24.4/24")
    // Its credit is gone once the load had time to show it.
    expect(Admission.decide(policy, state, reading(23.5), Admission.RAMP_SECONDS * 1000).held).toBeUndefined()
  })
})

const AGENT = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
const REPOSITORY = "github/acme/app"

describe("smthrs runner serve, admitting by load", () => {
  let root = ""
  let configPath = ""
  let host: Awaited<ReturnType<typeof Host.start>>
  let mirror: ReturnType<typeof Host.mirror>
  let serving: Fiber.Fiber<unknown, unknown> | undefined
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
  const until = async (condition: () => boolean, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not met in time")
      await sleep(50)
    }
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "runner-admission-"))
    const stateDir = join(root, "state")
    const agentState = join(root, "agent-state")
    execFileSync("mkdir", ["-p", agentState])
    const made = await Effect.runPromise(Config.makeToken(stateDir))
    host = await Host.start(readFileSync(made.file, "utf8").trim())
    mirror = Host.mirror(root)
    configPath = join(root, "runner.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        origin: host.origin,
        name: "test-runner",
        capacity: 10,
        stateDir,
        heartbeatSeconds: 1,
        pollSeconds: 1,
        repositories: { [REPOSITORY]: { mirror: mirror.path } },
        profiles: { "test-agent": { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } } }
      })
    )
  })

  afterEach(async () => {
    if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
    serving = undefined
    await host.close()
    rmSync(root, { recursive: true, force: true })
  })

  test("a host over half load claims nothing and says why; once under, it claims and settles", async () => {
    let load = 31
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `alpha` to `NOTES.md`" }))
    serving = Effect.runFork(RunnerCmd.serve(configPath, { read: () => reading(load) }))
    await until(() => host.machines.filter((each) => each?.held !== undefined).length >= 3)
    expect(row.state).toBe("queued")
    expect(host.machines.at(-1)).toMatchObject({ load1: 31, held: "load 31/24" })
    expect(host.claimRequests.at(-1)?.free).toBe(0)
    load = 3
    expect((await host.settled(row))._tag).toBe("Done")
    expect(host.machines.at(-1)?.held).toBeUndefined()
  }, 90_000)

  test("ten queued jobs on a host at 0.49 land one at a time", async () => {
    const rows = Array.from(
      { length: 10 },
      (_, index) =>
        host.enqueue(
          Host.task({ base: mirror.base, prompt: `run \`sleep 30\`\nadd the line \`${index}\` to \`N.md\`` })
        )
    )
    serving = Effect.runFork(RunnerCmd.serve(configPath, { read: () => reading(23.5) }))
    await until(() => rows.some((each) => each.state === "claimed"))
    await sleep(4000)
    expect(rows.filter((each) => each.state !== "queued")).toHaveLength(1)
    expect(host.machines.at(-1)?.held).toMatch(/^load 24\.\d\/24$/)
  }, 60_000)

  test(
    "with idleExitSeconds, a runner with no job for that long ends; one with a job keeps serving until it settles",
    async () => {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      writeFileSync(configPath, JSON.stringify({ ...config, idleExitSeconds: 2 }))
      const row = host.enqueue(
        Host.task({ base: mirror.base, prompt: "run `sleep 4`\nadd the line `alpha` to `NOTES.md`" })
      )
      const startedAt = Date.now()
      const exit = await Effect.runPromise(Effect.exit(RunnerCmd.serve(configPath, { read: () => reading(1) })))
      expect(exit._tag).toBe("Success")
      expect(row.state).toBe("settled")
      // It served the 4 s job, then 2 s with none.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6000)
      expect(Date.now() - startedAt).toBeLessThan(30_000)
    },
    60_000
  )
})
