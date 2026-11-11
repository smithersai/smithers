/**
 * A runner started again while its host can't be reached yet: the runner's journal wakes a job's execution before the
 * claim loop has the job back. A real runner process with the loopback host fixture, a real jj mirror and the
 * deterministic ACP test agent; and `runner/Job` on a journal in this process, woken with no control.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { NodeRuntime } from "@smthrs/platform-node"
import { Deferred, Exit, Fiber, Latch, Layer, Logger, Queue } from "effect"
import { Effect } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as Config from "../src/runner/Config.ts"
import * as Host from "../src/runner/Host.ts"
import * as Job from "../src/runner/Job.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import type * as Session from "../src/runner/Session.ts"
import * as HostFixture from "./fixtures/runner/host.ts"

const AGENT = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
const BIN = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))

let root = ""
let agentState = ""
let stateDir = ""
let configPath = ""
let host: Awaited<ReturnType<typeof HostFixture.start>>
const children: Array<ChildProcess> = []

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const until = async (condition: () => boolean, timeoutMs = 60_000, what = "condition") => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`)
    await sleep(50)
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const agentPids = () =>
  readdirSync(agentState).filter((name) => name.startsWith("agent-")).map((name) => Number(name.slice(6, -4)))

const runner = () => {
  const child = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let log = ""
  child.stdout!.on("data", (chunk) => (log += chunk))
  child.stderr!.on("data", (chunk) => (log += chunk))
  children.push(child)
  return { child, log: () => log }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "runner-restart-"))
  agentState = join(root, "agent-state")
  stateDir = join(root, "state")
  configPath = join(root, "runner.json")
  mkdirSync(agentState)
  const made = await Effect.runPromise(Config.makeToken(stateDir))
  host = await HostFixture.start(readFileSync(made.file, "utf8").trim())
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      // Gone already.
    }
  }
  for (const pid of agentPids()) if (alive(pid)) process.kill(pid, "SIGKILL")
  await host.close()
  rmSync(root, { recursive: true, force: true })
})

test(
  "a runner started again while its host can't be reached finishes the job it held once the host answers",
  async () => {
    const mirror = HostFixture.mirror(root)
    writeFileSync(
      configPath,
      JSON.stringify({
        origin: host.origin,
        name: "test-runner",
        stateDir,
        heartbeatSeconds: 1,
        pollSeconds: 1,
        admission: { loadPerCpu: 1000, diskFloorGb: 0 },
        repositories: { "github/acme/app": { mirror: mirror.path } },
        profiles: { "test-agent": { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } } }
      })
    )
    const row = host.enqueue(HostFixture.task({
      base: mirror.base,
      prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 3`\nadd the line `beta` to `NOTES.md`"
    }))
    const first = runner()
    const work = join(stateDir, "work")
    await until(
      () =>
        existsSync(work) && readdirSync(work).some((name) => {
          const notes = join(work, name, "NOTES.md")
          return existsSync(notes) && readFileSync(notes, "utf8") === "alpha\n"
        }),
      90_000,
      "agent wrote alpha"
    )
    const [agent] = agentPids()
    first.child.kill("SIGKILL")
    await until(() => !alive(agent!), 30_000, "agent gone")
    // The host can't be reached: the restarted runner's claims fail, and its journal's sweep finds the job's execution,
    // whose owner died, before the claim loop has the job back.
    host.refusal.claim = 503
    const second = runner()
    // The journal's sweep takes the execution back once its dead owner's lease is stale.
    await until(() => second.log().includes("flow.run.claimed"), 120_000, "execution woken by the sweep")
    host.refusal.claim = undefined
    const outcome = await host.settled(row, 120_000).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${second.log()}`)
    })
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, Buffer.from(file.contents, "base64").toString()]))
      .toEqual([["NOTES.md", "alpha\nbeta\n"]])
    expect(row.claims).toBe(1)
  },
  300_000
)

describe("runner/Job woken with no control", () => {
  /** `runner/Job` on a journal under `stateDir`, settling with a local store, and the job its payload names. */
  const woken = (deadline: number, controls: Map<string, Session.Control>) =>
    Effect.gen(function*() {
      const config = yield* Config.check({ name: "test-runner", stateDir, repositories: {}, profiles: {} })
      const store = yield* LocalJobs.make(stateDir)
      const engine = NodeRuntime.layerHost(
        { filename: join(stateDir, "engine.db"), workspaceRoot: stateDir, owner: { hostId: "runner-test" } },
        Job.registration(config, controls).pipe(Layer.provide(Layer.succeed(Host.Host, store.host)))
      )
      const payload: Session.JobPayload = {
        key: "woken#g1",
        claim: "claim-1",
        generation: 1,
        task: HostFixture.task({ base: "a".repeat(40), prompt: "unused" }),
        deadline
      }
      return { engine, payload }
    }).pipe(Effect.provide(NodeServices.layer))

  test("ends timeout once the host has ended the job, and its settlement is dropped", async () => {
    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const { engine, payload } = yield* woken(Date.now() - Job.SETTLE_GRACE_MS - 1, new Map())
        return yield* Job.RunnerJob.execute(payload, { executionId: payload.key }).pipe(Effect.provide(engine))
      }).pipe(Effect.scoped)
    )
    expect(settled).toEqual({ recorded: false, outcome: "failed:timeout" })
  }, 60_000)

  test("runs under the control the claim loop makes once it has the job back", async () => {
    const controls = new Map<string, Session.Control>()
    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const { engine, payload } = yield* woken(Date.now() + 60_000, controls)
        // The work says it waits for its control; only then does the claim loop's control arrive.
        const awaiting = yield* Deferred.make<void>()
        const logger = Logger.make((options) => {
          if (JSON.stringify(Logger.formatStructured.log(options)).includes("awaiting_claim")) {
            Deferred.doneUnsafe(awaiting, Exit.void)
          }
        })
        const execution = yield* Job.RunnerJob.execute(payload, { executionId: payload.key }).pipe(
          Effect.provide(engine),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          Effect.forkChild
        )
        yield* Deferred.await(awaiting)
        controls.set(payload.key, {
          cancel: yield* Deferred.make<void>(),
          dropped: yield* Deferred.make<void>(),
          authorization: { suspended: yield* Deferred.make<void>(), latch: yield* Latch.make(true) },
          hostEnded: yield* Deferred.make<void>(),
          reclaimed: true,
          steers: yield* Queue.unbounded<AgentRunner.Steer>(),
          delivered: new Set(),
          stats: {}
        })
        return yield* Fiber.join(execution)
      }).pipe(Effect.scoped)
    )
    // Its repository isn't in this runner's configuration: the work ran, under the control, and failed `workspace`.
    expect(settled).toEqual({ recorded: false, outcome: "failed:workspace" })
  }, 60_000)
})
