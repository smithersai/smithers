/**
 * `smthrs runner` against a real peer: a loopback HTTP host (fixtures/runner/host.ts), a real jj mirror, and the
 * deterministic ACP test agent from `@smthrs/agent`'s fixtures as the profile's command. The serve loop runs in this
 * process, on its own SQLite journal, except where the case is the process itself: the token command, and a runner
 * killed mid-job and started again.
 */
import * as Transcript from "@smthrs/agent/Transcript"
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"
import { Cause, Effect, Exit, Fiber, Logger } from "effect"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { devNull, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Config from "../src/runner/Config.ts"
import * as Serve from "../src/runner/Serve.vibe"
import * as Tree from "../src/runner/Tree.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Host from "./fixtures/runner/host.ts"

const AGENT = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
const BIN = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
const REPOSITORY = "github/acme/app"

let root = ""
let agentState = ""
let host: Awaited<ReturnType<typeof Host.start>>
let mirror: ReturnType<typeof Host.mirror>
let configPath = ""
let stateDir = ""
let serving: Fiber.Fiber<unknown, unknown> | undefined
const children: Array<ChildProcess> = []

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** SIGKILL to `child`'s whole process group, then waits, for at most 10 s, until no process of it is left. */
const stopGroup = async (child: ChildProcess) => {
  const group = -child.pid!
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(group, name)
      return true
    } catch {
      return false
    }
  }
  signal("SIGKILL")
  const deadline = Date.now() + 10_000
  while (signal(0) && Date.now() < deadline) await sleep(20)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pids = (prefix: string) =>
  readdirSync(agentState).filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length, -4)))
const until = async (condition: () => boolean, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await sleep(50)
  }
}
const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8")
const checkouts = () => existsSync(join(stateDir, "work")) ? readdirSync(join(stateDir, "work")) : []

/** Writes runner.json with the test agent as `test-agent`, and `profiles` beside it. */
const configure = (
  profiles: Record<string, Partial<Config.Profile>> = {},
  overrides: { readonly capacity?: number; readonly idleExitSeconds?: number } = {}
) => {
  const agent = { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } }
  const config = {
    origin: host.origin,
    name: "test-runner",
    capacity: 2,
    stateDir,
    heartbeatSeconds: 1,
    pollSeconds: 1,
    // This suite is about jobs, not the machine running it: a busy test machine mustn't hold its claims.
    admission: { loadPerCpu: 1000, diskFloorGb: 0 },
    repositories: { [REPOSITORY]: { mirror: mirror.path } },
    profiles: {
      "test-agent": agent,
      ...Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...agent, ...profile }]))
    },
    ...overrides
  }
  writeFileSync(configPath, JSON.stringify(config))
}

const serveInProcess = () => {
  serving = Effect.runFork(
    RunnerCmd.serve(configPath).pipe(
      Effect.tapCause((cause) => Effect.sync(() => console.error("serve ended", Cause.pretty(cause))))
    )
  )
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "runner-"))
  agentState = join(root, "agent-state")
  stateDir = join(root, "state")
  configPath = join(root, "runner.json")
  const made = await Effect.runPromise(Config.makeToken(stateDir))
  const token = readFileSync(made.file, "utf8").trim()
  host = await Host.start(token)
  mirror = Host.mirror(root)
  execFileSync("mkdir", ["-p", agentState])
})

afterEach(async () => {
  if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
  serving = undefined
  // Each runner process leads a process group with the jj commands it runs: all of it is gone before its directory
  // is deleted, or a command still writing there fails the delete (ENOTEMPTY).
  await Promise.all(children.splice(0).map(stopGroup))
  await host.close()
  for (const pid of [...pids("agent-"), ...pids("detached-")]) if (alive(pid)) process.kill(pid, "SIGKILL")
  for (const name of readdirSync(agentState).filter((each) => each.startsWith("orphan-"))) {
    const pid = Number(readFileSync(join(agentState, name), "utf8").trim())
    if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL")
  }
  rmSync(root, { recursive: true, force: true })
})

describe("smthrs runner serve", () => {
  test(
    "settles Done with the files the agent changed, its last words and usage, then forgets the checkout",
    async () => {
      configure()
      const row = host.enqueue(Host.task({
        base: mirror.base,
        prompt: "add the line `alpha` to `NOTES.md`\nadd the line `two` to `docs/b.md`\nlate update"
      }))
      serveInProcess()
      const outcome = await host.settled(row)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag !== "Done") return
      expect(outcome.changes.deletions).toEqual([])
      expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
        ["NOTES.md", "alpha\n"],
        ["docs/b.md", "two\n"]
      ])
      expect(outcome.summary).toContain("Late note.")
      expect(outcome.usage).toEqual({ contextTokens: 1234, costUsd: 0 })
      expect(row.claims).toBe(1)
      await until(() => checkouts().length === 0)
      for (const pid of pids("agent-")) await until(() => !alive(pid))
    },
    90_000
  )

  test(
    "sends the agent's transcript once and in order, scrubbed and bounded, without its configuration, then its end",
    async () => {
      configure()
      const row = host.enqueue(Host.task({
        base: mirror.base,
        prompt: "leak sk-abcdefgh12345 from me@example.org\nadd the line `alpha` to `NOTES.md`\nsay 40 KiB"
      }))
      serveInProcess()
      expect((await host.settled(row))._tag).toBe("Done")
      const { events, contiguous } = await host.transcribed(row)
      expect(contiguous).toBe(true)
      const kinds = events.map((event) => event.kind)
      expect(kinds[0]).toBe("user_message_chunk")
      expect(kinds).toContain("tool_call")
      expect(kinds).toContain("tool_call_update")
      expect(kinds).not.toContain("available_commands_update")
      expect(events.find((event) => event.kind === Transcript.KINDS.turn)?.update).toEqual({ stopReason: "end_turn" })
      expect(events.at(-1)).toMatchObject({ kind: Transcript.KINDS.end, update: { outcome: "done" } })
      const wire = JSON.stringify(events)
      expect(wire).not.toContain("sk-abcdefgh12345")
      expect(wire).not.toContain("me@example.org")
      const big = events.filter((event) => /^k+$/.test(String((event.update.content as { text?: string })?.text)))
      expect(big.length).toBeGreaterThanOrEqual(3)
      expect(big.map((event) => (event.update.content as { text: string }).text).join("")).toBe("k".repeat(40 * 1024))
      for (const event of events) {
        expect(Buffer.byteLength(JSON.stringify(event.update))).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
        expect(event.at).toBeGreaterThan(0)
      }
      // The spool is deleted once the host has everything.
      await until(() => readdirSync(join(stateDir, "spool")).length === 0)
    },
    90_000
  )

  test(
    "a host that can't take events for a minute gets every one once it answers, contiguous, at about one post a second",
    async () => {
      configure()
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "talk for 75 seconds" }))
      const blockedAt = Date.now()
      host.blockEvents(60_000)
      serveInProcess()
      expect((await host.settled(row, 150_000))._tag).toBe("Done")
      const { events, contiguous } = await host.transcribed(row)
      expect(contiguous).toBe(true)
      expect(row.refusedPosts).toBeGreaterThan(0)
      const words = events.flatMap((event) => {
        const text = (event.update.content as { text?: string } | undefined)?.text ?? ""
        const match = /^word (\d+) $/.exec(text)
        return match === null ? [] : [Number(match[1])]
      })
      expect(words.length).toBeGreaterThan(200)
      expect(words).toEqual(words.map((_, n) => n))
      // The minute's backlog arrived within 10 s of the host answering again, and later events within 3 s.
      const unblocked = blockedAt + 60_000
      const late = events.map((event) => ({ at: event.at, lag: row.received.get(event.seq)! - event.at }))
      expect(Math.max(...late.filter((event) => event.at < unblocked).map((event) => event.at + event.lag)))
        .toBeLessThan(
          unblocked + 10_000
        )
      const after = late.filter((event) => event.at > unblocked + 10_000).map((event) => event.lag)
      expect(after.length).toBeGreaterThan(20)
      expect(Math.max(...after)).toBeLessThanOrEqual(3000)
      // About 15 s of live talk after the block, a post a second, plus the backlog and the drain.
      expect(row.posts).toBeLessThanOrEqual(40)
    },
    180_000
  )

  test("ten jobs at once: each transcript arrives whole and in order while its agent works", async () => {
    configure()
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { capacity: number }
    writeFileSync(configPath, JSON.stringify({ ...config, capacity: 10 }))
    const rows = Array.from(
      { length: 10 },
      () =>
        host.enqueue(Host.task({ base: mirror.base, prompt: "talk for 8 seconds\nadd the line `alpha` to `NOTES.md`" }))
    )
    serveInProcess()
    const settledAt = new Map<Host.Row, number>()
    await Promise.all(rows.map(async (row) => {
      // A job that ends otherwise says how: its outcome, and the last of its transcript the host has.
      const outcome = await host.settled(row, 150_000)
      const tail = Host.transcriptOf(row).events.slice(-6).map((event) => [event.seq, event.kind, event.update])
      expect(outcome, `${row.key}: ${JSON.stringify(outcome)}; transcript tail ${JSON.stringify(tail)}`)
        .toMatchObject({ _tag: "Done" })
      settledAt.set(row, Date.now())
    }))
    const lags: Array<number> = []
    const firsts: Array<number> = []
    for (const row of rows) {
      const { events, contiguous } = await host.transcribed(row)
      expect(contiguous).toBe(true)
      expect(events.length).toBeGreaterThan(30)
      // Live, not at the end: most of the talk reached the host before the job settled.
      const before = [...row.received.values()].filter((at) => at < settledAt.get(row)!).length
      expect(before).toBeGreaterThan(events.length / 2)
      firsts.push(Math.min(...row.received.values()) - row.claimedAt!)
      for (const event of events) lags.push(row.received.get(event.seq)! - event.at)
    }
    // The measurement, for the record: on a shared test host these numbers say as much about its load as the runner.
    // e2e/agent-runner.spec.ts holds a deployment to FINAL.md's 30 s and 3 s.
    lags.sort((a, b) => a - b)
    firsts.sort((a, b) => a - b)
    const at = (values: ReadonlyArray<number>, p: number) =>
      values[Math.min(values.length - 1, Math.floor(values.length * p))]
    console.info(
      `runner transcript over 10 jobs: claim to first event p50 ${at(firsts, 0.5)} ms, max ${firsts.at(-1)} ms; ` +
        `event lag over ${lags.length} events p50 ${at(lags, 0.5)} ms, p95 ${at(lags, 0.95)} ms, max ${lags.at(-1)} ms`
    )
  }, 240_000)

  test(
    "each heartbeat tells the host the hook's account, the tree's CPU time and the agent's usage; each claim the machine",
    async () => {
      const hook = join(root, "pick.sh")
      writeFileSync(hook, "#!/bin/sh\necho account=acct-1\n", { mode: 0o755 })
      configure({ picked: { prestart: [hook] } })
      const row = host.enqueue(
        Host.task({ profile: "picked", base: mirror.base, prompt: "run `busy 4`\nadd the line `a` to `A.md`" })
      )
      serveInProcess()
      expect((await host.settled(row))._tag).toBe("Done")
      const beat = row.beats.find((each) => each.usage !== undefined)
      expect(beat, "a heartbeat after the agent reported usage").toBeDefined()
      expect(beat).toMatchObject({ key: row.key, claim: row.claim, account: "acct-1", usage: { contextTokens: 1234 } })
      expect(row.beats.every((each) => each.cpuSeconds === undefined || each.cpuSeconds >= 0)).toBe(true)
      // The busy child's CPU counts toward the tree's, after it exited too (ps counts whole seconds on Linux).
      expect(Math.max(...row.beats.map((each) => each.cpuSeconds ?? 0))).toBeGreaterThanOrEqual(1)
      const machine = host.machines.find((each) => each !== undefined)
      expect(machine?.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(machine?.load1).toBeGreaterThanOrEqual(0)
    },
    90_000
  )

  test("reads ps CPU times in each form it prints", () => {
    expect(Tree.cpuOf("00:00:03")).toBe(3)
    expect(Tree.cpuOf("1:02.50")).toBe(62.5)
    expect(Tree.cpuOf("2-01:00:00")).toBe(2 * 86_400 + 3600)
    expect(Tree.cpuOf("-")).toBe(0)
    expect(Tree.cpuOf("x-1:00")).toBe(0)
  })

  test("a cancel stops the agent's whole tree, a detached command included, and settles Cancelled", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "run `sleep 60` detached" }))
    serveInProcess()
    await until(() => pids("detached-").length === 1)
    const [sleeper] = pids("detached-")
    row.cancel = true
    const outcome = await host.settled(row)
    expect(outcome).toEqual({ _tag: "Cancelled", processTreeGone: true })
    expect(alive(sleeper!)).toBe(false)
    // The transcript marks the stop once, then the end.
    const marks = (await host.transcribed(row)).events.map((event) => event.kind)
      .filter((kind) => kind === Transcript.KINDS.cancel || kind === Transcript.KINDS.end)
    expect(marks).toEqual([Transcript.KINDS.cancel, Transcript.KINDS.end])
  }, 90_000)

  test("a steer reaches the turn in flight through the agent's steering, once, and its change is settled", async () => {
    configure()
    const row = host.enqueue(Host.task({
      base: mirror.base,
      prompt: "run `sleep 3`\nadd the line `alpha` to `NOTES.md`"
    }))
    // A host that keeps handing the steer out: the runner hands it to the agent once all the same.
    row.promote = false
    serveInProcess()
    await until(() => row.state === "claimed")
    row.steers = [{ id: "steer-1", text: "add the line `steered` to `NOTES.md`" }]
    const outcome = await host.settled(row)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
      ["NOTES.md", "alpha\nsteered\n"]
    ])
    expect(existsSync(join(agentState, "steered.log"))).toBe(true)
    // Delivered once the agent answered after it, and acknowledged on every heartbeat while the host lists it.
    expect(row.delivered.length).toBeGreaterThan(0)
    expect(new Set(row.delivered)).toEqual(new Set(["steer-1"]))
    // The transcript marks the steer once, as it reached the turn in flight.
    const steers = (await host.transcribed(row)).events.filter((event) => event.kind === Transcript.KINDS.steer)
    expect(steers.map((event) => event.update)).toEqual([{ id: "steer-1", mode: "steering" }])
  }, 90_000)

  test("a steer the agent read that no heartbeat got recorded is reported on the settlement", async () => {
    configure()
    const row = host.enqueue(
      Host.task({ base: mirror.base, prompt: "run `sleep 3`\nadd the line `alpha` to `NOTES.md`" })
    )
    // A host whose heartbeat answers never record a delivery, as a job that ends between two heartbeats sees.
    row.heartbeatAcks = false
    serveInProcess()
    await until(() => row.state === "claimed")
    row.steers = [{ id: "steer-late", text: "add the line `late` to `NOTES.md`" }]
    const outcome = await host.settled(row)
    expect(outcome._tag).toBe("Done")
    expect(row.delivered).toEqual(["steer-late"])
  }, 90_000)

  test("an agent without steering is cancelled, then prompted with the steer, and carries on", async () => {
    configure({ plain: { env: { ACP_TEST_AGENT_STATE: agentState, ACP_TEST_AGENT_NO_STEER: "1" } } })
    const row = host.enqueue(Host.task({
      profile: "plain",
      base: mirror.base,
      prompt: "run `sleep 3`\nadd the line `alpha` to `NOTES.md`"
    }))
    serveInProcess()
    await until(() => row.state === "claimed")
    row.steers = [{ id: "steer-2", text: "add the line `steered` to `NOTES.md`" }]
    const outcome = await host.settled(row)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
      ["NOTES.md", "alpha\nsteered\n"]
    ])
    expect(row.delivered).toEqual(["steer-2"])
    expect(row.steers).toEqual([])
    // The transcript says the turn was cancelled, then marks the steer before the agent's answer to it.
    const { events } = await host.transcribed(row)
    const kinds = events.map((event) => event.kind)
    const steer = kinds.indexOf(Transcript.KINDS.steer)
    expect(events[steer]?.update).toMatchObject({ id: "steer-2", mode: "cancel_prompt" })
    expect(events.slice(0, steer).filter((event) => event.kind === Transcript.KINDS.turn).map((event) => event.update))
      .toEqual([{ stopReason: "cancelled" }])
    expect(kinds.slice(steer + 1)).toContain(Transcript.KINDS.turn)
  }, 90_000)

  test("a profile that steers by prompt cancels the turn and prompts, though its agent takes steering", async () => {
    configure({ prompted: { steering: "prompt" } })
    const row = host.enqueue(Host.task({
      profile: "prompted",
      base: mirror.base,
      prompt: "run `sleep 3`\nadd the line `alpha` to `NOTES.md`"
    }))
    serveInProcess()
    await until(() => row.state === "claimed")
    row.steers = [{ id: "steer-p", text: "add the line `steered` to `NOTES.md`" }]
    const outcome = await host.settled(row)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
      ["NOTES.md", "alpha\nsteered\n"]
    ])
    expect(row.delivered).toContain("steer-p")
    // Never over `_session/steering`.
    expect(existsSync(join(agentState, "steered.log"))).toBe(false)
  }, 90_000)

  test("a steer after the turn ended starts the next turn before the change is collected", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `alpha` to `NOTES.md`" }))
    serveInProcess()
    const notes = () => {
      const [work] = checkouts().filter((name) => !name.endsWith(".acp.json"))
      return work === undefined ? "" : (() => {
        try {
          return readFileSync(join(stateDir, "work", work, "NOTES.md"), "utf8")
        } catch {
          return ""
        }
      })()
    }
    await until(() => notes() === "alpha\n")
    row.steers = [{ id: "steer-3", text: "add the line `later` to `NOTES.md`" }]
    const outcome = await host.settled(row)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
      ["NOTES.md", "alpha\nlater\n"]
    ])
    expect(row.delivered).toEqual(["steer-3"])
  }, 90_000)

  test(
    "a cancel that orphans a command started deep in the tree, after its parent was seen, still ends it",
    async () => {
      configure()
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "run `sleep 60` through a helper" }))
      serveInProcess()
      const orphans = () =>
        readdirSync(agentState).filter((name) => name.startsWith("orphan-")).map((name) =>
          Number(readFileSync(join(agentState, name), "utf8").trim())
        ).filter((pid) => pid > 0)
      await until(() => orphans().length === 1)
      const [sleeper] = orphans()
      row.cancel = true
      expect(await host.settled(row)).toEqual({ _tag: "Cancelled", processTreeGone: true })
      expect(alive(sleeper!)).toBe(false)
    },
    90_000
  )

  test(
    "a refusal the profile retries settles Retryable and keeps the checkout; one it doesn't fails agent",
    async () => {
      configure({ retrying: { retryOn: ["refusal"] } })
      const retried = host.enqueue(Host.task({ profile: "retrying", base: mirror.base, prompt: "refuse" }))
      const failed = host.enqueue(Host.task({ base: mirror.base, prompt: "refuse" }))
      serveInProcess()
      expect(await host.settled(retried)).toEqual({ _tag: "Retryable" })
      expect(await host.settled(failed)).toEqual({ _tag: "Failed", reason: "agent" })
      await until(() => checkouts().filter((name) => !name.endsWith(".acp.json")).length === 1)
      await sleep(500)
      expect(checkouts().filter((name) => !name.endsWith(".acp.json"))).toHaveLength(1)
    },
    90_000
  )

  test("an error answer to the prompt is retryable when the profile says so, else refused", async () => {
    configure({ retrying: { retryOn: ["error"] } })
    const retried = host.enqueue(Host.task({ profile: "retrying", base: mirror.base, prompt: "fail the prompt" }))
    const refused = host.enqueue(Host.task({ base: mirror.base, prompt: "fail the prompt" }))
    serveInProcess()
    expect(await host.settled(retried)).toEqual({ _tag: "Retryable" })
    expect(await host.settled(refused)).toEqual({ _tag: "Failed", reason: "refused" })
  }, 90_000)

  test("an agent that exits mid-turn fails agent, or is retryable when the profile says so", async () => {
    configure({ retrying: { retryOn: ["exit"] } })
    const retried = host.enqueue(Host.task({ profile: "retrying", base: mirror.base, prompt: "exit" }))
    const failed = host.enqueue(Host.task({ base: mirror.base, prompt: "exit" }))
    serveInProcess()
    expect(await host.settled(retried)).toEqual({ _tag: "Retryable" })
    expect(await host.settled(failed)).toEqual({ _tag: "Failed", reason: "agent" })
  }, 90_000)

  test("stopping during prestart ends its helper processes before the runner scope closes", async () => {
    const childFile = join(agentState, "prestart-child")
    const hook = join(root, "prestart.mjs")
    writeFileSync(
      hook,
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(childFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `
    )
    configure({ hooked: { prestart: [process.execPath, hook] } })
    host.enqueue(Host.task({ profile: "hooked", base: mirror.base, prompt: "unused" }))
    serveInProcess()
    await until(() => existsSync(childFile))
    const pid = Number(readFileSync(childFile, "utf8"))
    try {
      expect(alive(pid)).toBe(true)
      await Effect.runPromise(Fiber.interrupt(serving!))
      serving = undefined
      const tree = Tree.watch(pid)
      await Effect.runPromise(tree.observe)
      expect(await Effect.runPromise(tree.gone)).toBe(true)
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  })

  test.each(["stdout", "stderr"])("prestart refuses output exceeding one MiB on %s", async (pipe) => {
    configure({ noisy: { prestart: [process.execPath, "-e", `process.${pipe}.write('x'.repeat(1024 * 1024 + 1))`] } })
    const row = host.enqueue(Host.task({ profile: "noisy", base: mirror.base, prompt: "unused" }))
    serveInProcess()
    expect(await host.settled(row)).toEqual({ _tag: "Failed", reason: "refused" })
    expect(pids("agent-")).toEqual([])
  })

  test(
    "prestart's environment reaches the agent and is scrubbed from what it says; a failing prestart refuses",
    async () => {
      const hook = (script: string) => [process.execPath, "-e", script]
      configure({
        hooked: { prestart: hook("console.log('HOOK_VALUE=hook-secret-value'); console.log('account=acct-7')") },
        broken: { prestart: hook("process.exit(2)") }
      })
      const said = host.enqueue(Host.task({
        profile: "hooked",
        base: mirror.base,
        prompt: "say env HOOK_VALUE\nleak ghp_abcdefghijklmnop\nleak someone@example.com"
      }))
      const refused = host.enqueue(
        Host.task({ profile: "broken", base: mirror.base, prompt: "add the line `x` to `x`" })
      )
      serveInProcess()
      const outcome = await host.settled(said)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag === "Done") {
        expect(outcome.summary).not.toContain("hook-secret-value")
        expect(outcome.summary).not.toContain("ghp_")
        expect(outcome.summary).not.toContain("someone@example.com")
        expect(outcome.summary).toContain(Transcript.REDACTED)
      }
      expect(await host.settled(refused)).toEqual({ _tag: "Failed", reason: "refused" })
    },
    90_000
  )

  test("an unknown repository fails workspace; a change past the limits fails too_large", async () => {
    configure()
    const unknown = host.enqueue(Host.task({ repository: "github/acme/other", base: mirror.base, prompt: "refuse" }))
    const large = host.enqueue(Host.task({
      base: mirror.base,
      prompt: "add the line `a` to `a.md`\nadd the line `b` to `b.md`",
      limits: { files: 1, bytes: 1024 }
    }))
    serveInProcess()
    expect(await host.settled(unknown)).toEqual({ _tag: "Failed", reason: "workspace" })
    expect(await host.settled(large)).toEqual({ _tag: "Failed", reason: "too_large" })
  }, 90_000)

  test("a claim the host no longer holds stops the agent and settles nothing", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "run `sleep 60`" }))
    serveInProcess()
    await until(() => pids("agent-").length === 1)
    const [agent] = pids("agent-")
    await until(() => row.heartbeats > 0)
    row.held = false
    await until(() => !alive(agent!))
    await sleep(2000)
    expect(row.state).toBe("claimed")
  }, 90_000)

  test("a reclaimed job whose checkout is gone after an agent was about to run in it fails machine_lost", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      origin: "todo:lost"
    })
    // As if an earlier runner process claimed it, started its agent, and its machine lost the checkout.
    row.state = "claimed"
    row.claim = "11111111-2222-4333-8444-555555555555"
    const checkout = Workspace.of(stateDir, "todo:lost")
    mkdirSync(dirname(checkout.started), { recursive: true })
    writeFileSync(checkout.started, `${row.key}\n`)
    serveInProcess()
    expect(await host.settled(row)).toEqual({ _tag: "Failed", reason: "machine_lost" })
  }, 90_000)

  // Decision 0148: the credential is asked for only when the mirror must fetch. A host or GitHub that can't issue one
  // now makes the job retryable, with the host's wait; a refusal fails the workspace; a 404 fetches as before.
  test("a job whose base the mirror has never asks for a credential", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }))
    host.credential.status = 503
    serveInProcess()
    expect((await host.settled(row))._tag).toBe("Done")
    expect(host.credential.asks).toBe(0)
  }, 90_000)

  /**
   * A commit the mirror lacks, on a git repository the mirror fetches as `origin` without a credential (the host's
   * `404`): its id.
   */
  const upstream = () => {
    const path = join(root, "upstream")
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }
    const git = (args: Array<string>) => execFileSync("git", args, { cwd: path, env, encoding: "utf8" }).trim()
    execFileSync("git", ["init", "-q", "-b", "main", path], { env })
    writeFileSync(join(path, "README.md"), "upstream\n")
    git(["add", "README.md"])
    git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "upstream"])
    execFileSync("jj", ["-R", mirror.path, "git", "remote", "add", "origin", path, ...Host.jjFlags], {
      env: { ...process.env, JJ_CONFIG: join(root, "jj-config") },
      stdio: "ignore"
    })
    return git(["rev-parse", "HEAD"])
  }

  // Astra's review of 5fc33348: a mint GitHub couldn't make before the checkout existed settled the generation
  // Retryable, and the next generation, finding no checkout, failed machine_lost. The same claim waits the host's wait
  // and makes the checkout; the agent's restarts and generations are untouched.
  test(
    "a fetch whose credential the host can't issue now waits on the same claim, then runs the job to Done",
    async () => {
      configure()
      const later = upstream()
      host.credential.sequence.push({ status: 503, retryAfter: 1 }, { status: 429, retryAfter: 1 })
      const row = host.enqueue(Host.task({ base: later, prompt: "add the line `x` to `x`" }), { origin: "todo:later" })
      serveInProcess()
      const outcome = await host.settled(row)
      expect(outcome._tag).toBe("Done")
      expect(host.credential.asks).toBe(3)
      expect(row.claims).toBe(1)
      expect(existsSync(Workspace.of(stateDir, "todo:later").provisioning)).toBe(false)
    },
    90_000
  )

  test(
    "a credential the host can't issue before the deadline fails timeout; a stop while it waits settles Cancelled",
    async () => {
      configure()
      host.credential.status = 503
      host.credential.retryAfter = 7200
      // A wait past the deadline is cut to half the time left, and the job times out only once the deadline passed.
      const deadline = Date.now() + 5000
      const late = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), { deadline })
      serveInProcess()
      expect(await host.settled(late)).toEqual({ _tag: "Failed", reason: "timeout" })
      expect(Date.now()).toBeGreaterThanOrEqual(deadline - 1000)
      expect(host.credential.asks).toBeGreaterThan(1)
      host.credential.asks = 0
      host.credential.retryAfter = 600
      const stopped = host.enqueue(Host.task({ base: "e".repeat(40), prompt: "refuse" }), {
        deadline: Date.now() + 3_600_000
      })
      await until(() => host.credential.asks === 1)
      stopped.cancel = true
      expect(await host.settled(stopped)).toEqual({ _tag: "Cancelled", processTreeGone: true })
    },
    90_000
  )

  // Astra's review of 40f86793: a wait the host asked for that ran past the deadline timed the job out at once, though
  // the deadline was a minute off.
  test(
    "a credential whose wait would run past the deadline is asked for again in time, and the job runs to Done",
    async () => {
      configure()
      const later = upstream()
      host.credential.sequence.push({ status: 503, retryAfter: 90 })
      const row = host.enqueue(Host.task({ base: later, prompt: "add the line `x` to `x`" }), {
        deadline: Date.now() + 40_000
      })
      serveInProcess()
      expect((await host.settled(row, 60_000))._tag).toBe("Done")
      expect(host.credential.asks).toBe(2)
    },
    90_000
  )

  test("a credential refused for the job fails workspace without fetching", async () => {
    configure()
    host.credential.status = 409
    const refused = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }))
    serveInProcess()
    expect(await host.settled(refused)).toEqual({ _tag: "Failed", reason: "workspace" })
    expect(host.credential.asks).toBe(1)
  }, 90_000)

  test(
    "a reclaimed job whose checkout was still being made when the runner stopped makes it and runs to Done",
    async () => {
      configure()
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
        origin: "todo:made"
      })
      row.state = "claimed"
      row.claim = "11111111-2222-4333-8444-555555555555"
      const checkout = Workspace.of(stateDir, "todo:made")
      mkdirSync(dirname(checkout.provisioning), { recursive: true })
      writeFileSync(checkout.provisioning, `${row.key}\n`)
      serveInProcess()
      expect((await host.settled(row))._tag).toBe("Done")
      expect(existsSync(checkout.provisioning)).toBe(false)
    },
    90_000
  )

  test("a runner the host refuses 403 logs that it needs re-registration, and keeps asking", async () => {
    configure()
    host.refusal.claim = 403
    const lines: Array<string> = []
    const logger = Logger.make((options) => void lines.push(JSON.stringify(Logger.formatStructured.log(options))))
    serving = Effect.runFork(
      RunnerCmd.serve(configPath).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    )
    await until(() =>
      host.claimRequests.length === 0 && lines.filter((line) => line.includes("not_authorized")).length >= 2
    )
    expect(lines.find((line) => line.includes("not_authorized"))).toContain(
      JSON.stringify(Serve.NOT_AUTHORIZED_HINT).slice(1, -1)
    )
  }, 90_000)

  // Astra's review of f42f8b6b: a heartbeat refused for want of authorization ended the job Cancelled, and a refused
  // settlement deleted its checkout, so the claim handed back after re-registration found its execution complete and
  // its work gone. Both now suspend the job; it resumes with its edits.
  const ALL = ["claim", "heartbeat", "settle", "events", "gitCredential"] as const
  test("a runner refused 403 mid-job suspends it, keeps its edits, and finishes it once registered again", async () => {
    configure()
    const row = host.enqueue(
      Host.task({
        base: mirror.base,
        prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 4`\nadd the line `beta` to `NOTES.md`"
      }),
      { origin: "todo:suspended" }
    )
    serveInProcess()
    const checkout = Workspace.of(stateDir, "todo:suspended")
    const notes = join(checkout.dir, "NOTES.md")
    await until(() => existsSync(notes) && readFileSync(notes, "utf8") === "alpha\n", 60_000)
    const [agent] = pids("agent-")
    // Migration 0093: every route refused until the runner is registered again.
    for (const route of ALL) host.refusal.notAuthorized.add(route)
    await until(() => host.refusal.refused.heartbeat > 0 && !alive(agent!), 30_000)
    await sleep(2000)
    expect(row.state).toBe("claimed")
    expect(readFileSync(notes, "utf8")).toBe("alpha\n")
    expect(existsSync(checkout.checkpoint)).toBe(true)
    host.refusal.notAuthorized.clear()
    const outcome = await host.settled(row, 90_000)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([[
      "NOTES.md",
      "alpha\nbeta\n"
    ]])
    expect(row.claims).toBe(1)
  }, 180_000)

  test(
    "a settlement refused 403 keeps the checkout and the outcome, and settles once the runner is registered again",
    async () => {
      configure()
      host.refusal.notAuthorized.add("settle")
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
        origin: "todo:unsettled"
      })
      serveInProcess()
      await until(() => host.refusal.refused.settle > 0, 60_000)
      await sleep(2000)
      const checkout = Workspace.of(stateDir, "todo:unsettled")
      expect(row.state).toBe("claimed")
      expect(readFileSync(join(checkout.dir, "x"), "utf8")).toBe("x\n")
      host.refusal.notAuthorized.clear()
      const outcome = await host.settled(row, 90_000)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag !== "Done") return
      expect(outcome.changes.additions.map((file) => file.path)).toEqual(["x"])
      await until(() => !existsSync(checkout.dir))
    },
    180_000
  )

  // Astra's review of 97bfda68: a suspended job waited only for authorization, so a deadline, a stop or a claim the
  // host ended never ended it, and it held the runner's capacity for good.
  test(
    "a job suspended past its deadline ends timeout, and one the host stopped holding frees its capacity",
    async () => {
      configure({}, { capacity: 1 })
      const late = host.enqueue(
        Host.task({
          base: mirror.base,
          prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 60`"
        }),
        { origin: "todo:late", deadline: Date.now() + 15_000 }
      )
      serveInProcess()
      const notes = join(Workspace.of(stateDir, "todo:late").dir, "NOTES.md")
      await until(() => existsSync(notes), 60_000)
      for (const route of ALL) host.refusal.notAuthorized.add(route)
      // Still refused past the deadline: the work ends, and its settlement is asked for.
      await until(() => host.refusal.refused.settle > 0, 60_000)
      host.refusal.notAuthorized.clear()
      expect(await host.settled(late, 60_000)).toEqual({ _tag: "Failed", reason: "timeout" })
      // Suspended again, and the host stops holding the job meanwhile (its hours ran out there): once the runner is
      // registered again, the heartbeat that says so ends the work, and the runner's one slot takes the next job.
      const held = host.enqueue(
        Host.task({
          base: mirror.base,
          prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 60`"
        }),
        { origin: "todo:held" }
      )
      const heldNotes = join(Workspace.of(stateDir, "todo:held").dir, "NOTES.md")
      await until(() => existsSync(heldNotes), 60_000)
      for (const route of ALL) host.refusal.notAuthorized.add(route)
      await until(() => host.refusal.refused.heartbeat > 0)
      await sleep(1500)
      held.held = false
      host.refusal.notAuthorized.clear()
      const next = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }))
      expect((await host.settled(next, 90_000))._tag).toBe("Done")
    },
    240_000
  )

  test("a settlement refused past the job's hours gives up, frees its capacity, and an idle runner exits", async () => {
    configure({}, { capacity: 1, idleExitSeconds: 5 })
    for (const route of ["heartbeat", "settle", "events"] as const) host.refusal.notAuthorized.add(route)
    // Its deadline, and the grace the host gives a settlement, both long past.
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      deadline: Date.now() - 11 * 60_000
    })
    serveInProcess()
    await until(() => host.refusal.refused.settle > 0, 30_000)
    const exited = await Promise.race([
      Effect.runPromise(Fiber.await(serving!)).then(() => true),
      sleep(30_000).then(() => false)
    ])
    expect(exited).toBe(true)
    // The host's claim route ended it `timeout` itself (with no probe), and never handed it back.
    expect(row.outcome).toEqual({ _tag: "Failed", reason: "timeout" })
  }, 90_000)

  // Astra's review of cef761ee: a runner whose token was rotated got 401 on every heartbeat, so a Stop couldn't reach
  // its suspended job, which held its slot to the deadline.
  test("a Stop reaches a runner whose token was rotated, which ends the suspended job and frees its slot", async () => {
    configure({}, { capacity: 1, idleExitSeconds: 5 })
    const row = host.enqueue(
      Host.task({
        base: mirror.base,
        prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 60`"
      }),
      { origin: "todo:rotated-stop" }
    )
    serveInProcess()
    const notes = join(Workspace.of(stateDir, "todo:rotated-stop").dir, "NOTES.md")
    await until(() => existsSync(notes), 60_000)
    const [agent] = pids("agent-")
    host.rotate(randomBytes(32).toString("base64url"))
    await until(() => !alive(agent!), 30_000)
    row.cancel = true
    expect(await host.settled(row, 30_000)).toEqual({ _tag: "Cancelled", processTreeGone: false })
    const exited = await Promise.race([
      Effect.runPromise(Fiber.await(serving!)).then(() => true),
      sleep(40_000).then(() => false)
    ])
    expect(exited).toBe(true)
  }, 120_000)

  // Astra's review of cef761ee: a provisioning attempt itself ignored a Stop, the claim lost and the deadline, so a
  // credentialed fetch that stalled held the slot for up to ten minutes.
  test("a Stop while a credentialed fetch stalls ends the job at once, and the fetch is killed", async () => {
    configure()
    const connections: Array<{ closed: boolean }> = []
    const stalled = createServer((request) => {
      const seen = { closed: false }
      connections.push(seen)
      request.socket.on("close", () => (seen.closed = true))
    })
    await new Promise<void>((done) => stalled.listen(0, "127.0.0.1", done))
    try {
      const remote = `http://127.0.0.1:${(stalled.address() as { port: number }).port}/private.git`
      host.credential.sequence.push({
        status: 200,
        issue: { remote, username: "x-access-token", password: "ghs_stalled", expiresAt: Date.now() + 3_600_000 }
      })
      const row = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), { origin: "todo:stalled" })
      serveInProcess()
      await until(() => connections.length > 0, 60_000)
      row.cancel = true
      expect(await host.settled(row, 30_000)).toEqual({ _tag: "Cancelled", processTreeGone: true })
      await until(() => connections.every((each) => each.closed), 15_000)
    } finally {
      stalled.closeAllConnections()
      stalled.close()
    }
  }, 120_000)

  /**
   * A git remote over HTTP on loopback that takes each connection and never answers, made the mirror's `origin`: the
   * route-off fetch (`jj git fetch`, no credential) stalls on it. Each connection says when it closed.
   */
  const stallingOrigin = async () => {
    const connections: Array<{ closed: boolean }> = []
    const server = createServer((request) => {
      const seen = { closed: false }
      connections.push(seen)
      request.socket.on("close", () => (seen.closed = true))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/stalled.git`
    execFileSync("jj", ["-R", mirror.path, "git", "remote", "add", "origin", url, ...Host.jjFlags], {
      env: { ...process.env, JJ_CONFIG: join(root, "jj-config") },
      stdio: "ignore"
    })
    const close = () => {
      server.closeAllConnections()
      server.close()
    }
    return { connections, close, allClosed: () => connections.length > 0 && connections.every((each) => each.closed) }
  }

  // Astra's review of ad7d1be9: the route-off fetch and the store's import ran in the runner's process group, so a Stop
  // left their helpers alive (holding the connection) while the job said its tree was gone.
  test("a Stop while the route-off fetch stalls ends the job, and its whole process tree is gone first", async () => {
    configure()
    const origin = await stallingOrigin()
    try {
      const row = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), { origin: "todo:route-off" })
      serveInProcess()
      await until(() => origin.connections.length > 0, 60_000)
      row.cancel = true
      expect(await host.settled(row, 30_000)).toEqual({ _tag: "Cancelled", processTreeGone: true })
      expect(origin.allClosed()).toBe(true)
    } finally {
      origin.close()
    }
  }, 120_000)

  test("a fetch that stalls gives way to the claim lost and to the deadline, its process tree gone", async () => {
    configure()
    const origin = await stallingOrigin()
    try {
      // The claim lost: the host stops holding it, and the runner's slot takes the next job.
      const lost = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), { origin: "todo:lost-claim" })
      serveInProcess()
      await until(() => origin.connections.length === 1, 60_000)
      lost.held = false
      await until(() => origin.allClosed(), 30_000)
      // The deadline: it passes while the fetch stalls, and the job ends timeout.
      const late = host.enqueue(Host.task({ base: "e".repeat(40), prompt: "refuse" }), {
        origin: "todo:late-fetch",
        deadline: Date.now() + 8000
      })
      expect(await host.settled(late, 60_000)).toEqual({ _tag: "Failed", reason: "timeout" })
      await until(() => origin.allClosed(), 15_000)
      expect(lost.state).toBe("claimed")
    } finally {
      origin.close()
    }
  }, 150_000)

  test("a job waiting for a mirror another job's stalled fetch holds gives way to a Stop at once", async () => {
    configure()
    const origin = await stallingOrigin()
    try {
      const holding = host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), {
        origin: "todo:holding-gate"
      })
      serveInProcess()
      await until(() => origin.connections.length === 1, 60_000)
      // Its base is in the mirror, but the mirror's gate is held by the stalled fetch.
      const waiting = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
        origin: "todo:waiting-gate"
      })
      await until(() => waiting.state === "claimed" && waiting.heartbeats > 0, 30_000)
      waiting.cancel = true
      expect(await host.settled(waiting, 15_000)).toEqual({ _tag: "Cancelled", processTreeGone: true })
      expect(holding.state).toBe("claimed")
      holding.cancel = true
      expect(await host.settled(holding, 30_000)).toMatchObject({ _tag: "Cancelled" })
      expect(origin.allClosed()).toBe(true)
    } finally {
      origin.close()
    }
  }, 150_000)

  // Astra's review of 5ac18ab4: an ordinary Stop, heard on a heartbeat the host took, was read as the host having ended
  // the job, so a settlement refused just after gave up and deleted the work.
  test(
    "a Stop the host asked for, then a refused settlement, keeps the outcome and settles once registered again",
    async () => {
      configure()
      host.refusal.notAuthorized.add("settle")
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "run `sleep 60`" }), {
        origin: "todo:stop-then-refused"
      })
      serveInProcess()
      await until(() => pids("agent-").length === 1 && row.heartbeats > 0, 60_000)
      row.cancel = true
      await until(() => host.refusal.refused.settle > 0, 60_000)
      await sleep(3000)
      expect(row.state).toBe("claimed")
      expect(existsSync(Workspace.of(stateDir, "todo:stop-then-refused").dir)).toBe(true)
      host.refusal.notAuthorized.clear()
      expect(await host.settled(row, 60_000)).toMatchObject({ _tag: "Cancelled", processTreeGone: true })
    },
    120_000
  )

  // Astra's review of 99f0dc17: a Stop couldn't reach a suspended job while the refusal lasted, so it held its slot to
  // its deadline.
  test("a Stop while the host still refuses the runner ends the suspended job and frees its slot", async () => {
    configure({}, { capacity: 1, idleExitSeconds: 5 })
    const row = host.enqueue(
      Host.task({
        base: mirror.base,
        prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 60`"
      }),
      { origin: "todo:stop-suspended" }
    )
    serveInProcess()
    const notes = join(Workspace.of(stateDir, "todo:stop-suspended").dir, "NOTES.md")
    await until(() => existsSync(notes), 60_000)
    const [agent] = pids("agent-")
    for (const route of ALL) host.refusal.notAuthorized.add(route)
    await until(() => host.refusal.refused.heartbeat > 0 && !alive(agent!), 30_000)
    row.cancel = true
    expect(await host.settled(row, 30_000)).toEqual({ _tag: "Cancelled", processTreeGone: false })
    const exited = await Promise.race([
      Effect.runPromise(Fiber.await(serving!)).then(() => true),
      sleep(40_000).then(() => false)
    ])
    expect(exited).toBe(true)
  }, 120_000)

  // Astra's review of f42f8b6b: a failed provisioning removed its mark at once, so a runner stopped before the failure
  // was journaled took the partial directory for a checkout.
  test("a provisioning that fails keeps its mark and partial directory until the settlement forgets them", async () => {
    configure()
    const jj = join(root, "jj-fails-in-workspace-add")
    writeFileSync(
      jj,
      `#!/bin/sh\ncase " $* " in *" workspace add "*)\n  dir=""; prev=""\n` +
        `  for arg; do if [ "$prev" = "-r" ]; then next=1; elif [ -n "$next" ] && [ -z "$dir" ]; then dir="$arg"; fi; prev="$arg"; done\n` +
        `  mkdir -p "$dir" && echo partial > "$dir/PARTIAL"; exit 1;;\n` +
        `esac\nexec "${resolveJjBinary().path}" "$@"\n`
    )
    chmodSync(jj, 0o755)
    host.hold.settleMs = 4000
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      origin: "todo:failed"
    })
    const checkout = Workspace.of(stateDir, "todo:failed")
    const child = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, SMITHERS_JJ_PATH: jj }
    })
    children.push(child)
    await until(() => existsSync(join(checkout.dir, "PARTIAL")), 60_000)
    await sleep(1500)
    expect(existsSync(checkout.provisioning)).toBe(true)
    expect(await host.settled(row, 60_000)).toEqual({ _tag: "Failed", reason: "workspace" })
    await until(() => !existsSync(checkout.provisioning) && !existsSync(checkout.dir))
  }, 180_000)

  // Astra's review of f42f8b6b: a machine that lost the mark's removal but kept the record that the agent was about to
  // run would discard a checkout holding the agent's work.
  test("a checkout with both its mark and its started record is kept, edits and all, never discarded", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      origin: "todo:both"
    })
    row.state = "claimed"
    row.claim = "11111111-2222-4333-8444-555555555555"
    const checkout = Workspace.of(stateDir, "todo:both")
    await Effect.runPromise(Workspace.create(mirror.path, mirror.base, checkout))
    writeFileSync(join(checkout.dir, "EDIT.md"), "the agent's\n")
    writeFileSync(checkout.provisioning, `${row.key}\n`)
    mkdirSync(dirname(checkout.started), { recursive: true })
    writeFileSync(checkout.started, `${row.key}\n`)
    serveInProcess()
    const outcome = await host.settled(row, 90_000)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => file.path).sort()).toEqual(["EDIT.md", "x"])
  }, 180_000)

  test("a deadline already past fails timeout", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "run `sleep 60`" }), {
      deadline: Date.now() + 1500
    })
    serveInProcess()
    expect(await host.settled(row)).toEqual({ _tag: "Failed", reason: "timeout" })
  }, 90_000)
})

describe("smthrs runner, as processes", () => {
  const runner = (args: ReadonlyArray<string>) => {
    // Its own process group, which afterEach stops whole.
    const child = spawn(process.execPath, [BIN, "runner", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    })
    children.push(child)
    return child
  }

  // Astra's review of f7b3de5f and 281a40d4: a provisioning command runs in a process group of its own, so killing the
  // runner left it running (a stalled fetch holding its connection) with nobody to end it.
  test(
    "a runner killed while a fetch stalls is started again and ends the orphaned fetch before anything else",
    async () => {
      configure()
      const connections: Array<{ closed: boolean }> = []
      const server = createServer((request) => {
        const seen = { closed: false }
        connections.push(seen)
        request.socket.on("close", () => (seen.closed = true))
      })
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/stalled.git`
        execFileSync("jj", ["-R", mirror.path, "git", "remote", "add", "origin", url, ...Host.jjFlags], {
          env: { ...process.env, JJ_CONFIG: join(root, "jj-config") },
          stdio: "ignore"
        })
        host.enqueue(Host.task({ base: "f".repeat(40), prompt: "refuse" }), { origin: "todo:orphan" })
        const first = runner(["serve", "--config", configPath])
        await until(() => connections.length > 0, 60_000)
        // Only the runner's own process: its fetch, in a group of its own, is orphaned.
        first.kill("SIGKILL")
        await new Promise((done) => first.once("exit", done))
        await new Promise((done) => setTimeout(done, 1_000))
        expect(connections.some((each) => !each.closed)).toBe(true)
        runner(["serve", "--config", configPath])
        await until(() => connections.slice(0, 1).every((each) => each.closed), 30_000)
      } finally {
        server.closeAllConnections()
        server.close()
      }
    },
    120_000
  )

  test("a runner killed mid-job is started again, reclaims the job and finishes it under the same claim", async () => {
    configure()
    const row = host.enqueue(Host.task({
      base: mirror.base,
      prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 3`\nadd the line `beta` to `NOTES.md`"
    }))
    const first = runner(["serve", "--config", configPath])
    await until(() =>
      checkouts().some((name) => {
        const notes = join(stateDir, "work", name, "NOTES.md")
        return existsSync(notes) && readFileSync(notes, "utf8") === "alpha\n"
      }), 60_000)
    // The prompt's event is in the spool: an update still in the agent's pipe when a runner dies never reached it.
    await until(
      () =>
        readdirSync(join(stateDir, "spool")).some((name) =>
          readFileSync(join(stateDir, "spool", name), "utf8").includes("You are a test.")
        ),
      60_000
    )
    const [agent] = pids("agent-")
    first.kill("SIGKILL")
    await until(() => !alive(agent!))
    expect(row.state).toBe("claimed")
    const claim = row.claim
    runner(["serve", "--config", configPath])
    const outcome = await host.settled(row, 90_000)
    expect(outcome._tag).toBe("Done")
    if (outcome._tag !== "Done") return
    expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([
      ["NOTES.md", "alpha\nbeta\n"]
    ])
    expect(row.claim).toBe(claim)
    expect(row.claims).toBe(1)
    // The transcript runs on from where the first runner's spool stopped: one seq each, and none of the history the
    // agent replayed while it loaded the session.
    const { events, contiguous } = await host.transcribed(row)
    expect(contiguous).toBe(true)
    const prompts = events.filter((event) => event.kind === "user_message_chunk")
    expect(prompts.map((event) => (event.update.content as { text: string }).text.split("\n")[0])).toEqual([
      "You are a test.",
      "Continue"
    ])
  }, 180_000)

  // Astra's review of 4cd69527: a runner killed after the host recorded its claim, before it wrote anything for the job,
  // failed machine_lost on the claim handed back, though no agent had run.
  test(
    "a runner killed after its claim was recorded, before it heard it, is started again and runs the job to Done",
    async () => {
      configure()
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }))
      host.hold.claimMs = 60_000
      const first = runner(["serve", "--config", configPath])
      await until(() => row.state === "claimed")
      await stopGroup(first)
      host.hold.claimMs = 0
      expect(checkouts()).toEqual([])
      runner(["serve", "--config", configPath])
      const outcome = await host.settled(row, 90_000)
      expect(outcome._tag).toBe("Done")
      expect(row.claims).toBe(1)
    },
    180_000
  )

  // Astra's review of 4cd69527: a runner killed while `jj workspace add` was making the checkout left a directory, and
  // the claim handed back took it for a checkout and ran the agent in it.
  test(
    "a runner killed while it made the checkout discards the partial one when started again, and runs to Done",
    async () => {
      configure()
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
        origin: "todo:partial"
      })
      const reached = join(root, "workspace-add-reached")
      const jj = join(root, "jj-stalls-in-workspace-add")
      // `jj workspace add` that writes part of its checkout, says so, and never finishes; any other command is jj's own.
      writeFileSync(
        jj,
        `#!/bin/sh\ncase " $* " in *" workspace add "*)\n  dir=""; prev=""\n` +
          `  for arg; do if [ "$prev" = "-r" ]; then next=1; elif [ -n "$next" ] && [ -z "$dir" ]; then dir="$arg"; fi; prev="$arg"; done\n` +
          `  mkdir -p "$dir" && echo partial > "$dir/PARTIAL" && touch "${reached}"; exec sleep 600;;\n` +
          `esac\nexec "${resolveJjBinary().path}" "$@"\n`
      )
      chmodSync(jj, 0o755)
      const first = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, SMITHERS_JJ_PATH: jj }
      })
      children.push(first)
      await until(() => existsSync(reached), 60_000)
      const checkout = Workspace.of(stateDir, "todo:partial")
      expect(existsSync(join(checkout.dir, "PARTIAL"))).toBe(true)
      expect(existsSync(checkout.provisioning)).toBe(true)
      await stopGroup(first)
      runner(["serve", "--config", configPath])
      const outcome = await host.settled(row, 90_000)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag !== "Done") return
      expect(outcome.changes.additions.map((file) => file.path)).toEqual(["x"])
      expect(row.claims).toBe(1)
    },
    180_000
  )

  // Astra's review of 97bfda68: a rotated token's 401 read as a claim lost, so the work ended Cancelled, the settlement
  // deleted the checkout, and the runner started again with the new token found its execution complete.
  test(
    "a token rotated while the agent works suspends the job; started again with the new token, it finishes it",
    async () => {
      configure()
      const row = host.enqueue(
        Host.task({
          base: mirror.base,
          prompt: "add the line `alpha` to `NOTES.md`\nrun `sleep 4`\nadd the line `beta` to `NOTES.md`"
        }),
        { origin: "todo:rotated" }
      )
      const first = runner(["serve", "--config", configPath])
      const notes = join(Workspace.of(stateDir, "todo:rotated").dir, "NOTES.md")
      await until(() => existsSync(notes) && readFileSync(notes, "utf8") === "alpha\n", 60_000)
      const [agent] = pids("agent-")
      const rotated = randomBytes(32).toString("base64url")
      host.rotate(rotated)
      await until(() => !alive(agent!), 30_000)
      await sleep(2000)
      expect(row.state).toBe("claimed")
      expect(readFileSync(notes, "utf8")).toBe("alpha\n")
      await stopGroup(first)
      writeFileSync(Config.tokenFile(stateDir), `${rotated}\n`, { mode: 0o600 })
      runner(["serve", "--config", configPath])
      const outcome = await host.settled(row, 90_000)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag !== "Done") return
      expect(outcome.changes.additions.map((file) => [file.path, decode(file.contents)])).toEqual([[
        "NOTES.md",
        "alpha\nbeta\n"
      ]])
      expect(row.claims).toBe(1)
    },
    180_000
  )

  test(
    "a token rotated while the job settles keeps its outcome; started again with the new token, it settles",
    async () => {
      configure()
      host.refusal.notAuthorized.add("settle")
      const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
        origin: "todo:settling"
      })
      const first = runner(["serve", "--config", configPath])
      await until(() => host.refusal.refused.settle > 0, 60_000)
      const rotated = randomBytes(32).toString("base64url")
      host.rotate(rotated)
      host.refusal.notAuthorized.clear()
      await sleep(4000)
      expect(row.state).toBe("claimed")
      expect(readFileSync(join(Workspace.of(stateDir, "todo:settling").dir, "x"), "utf8")).toBe("x\n")
      await stopGroup(first)
      writeFileSync(Config.tokenFile(stateDir), `${rotated}\n`, { mode: 0o600 })
      runner(["serve", "--config", configPath])
      const outcome = await host.settled(row, 90_000)
      expect(outcome._tag).toBe("Done")
      if (outcome._tag !== "Done") return
      expect(outcome.changes.additions.map((file) => file.path)).toEqual(["x"])
    },
    180_000
  )

  // Astra's review of f2ebe829: discarding an incomplete checkout ran before the controlled attempt, outside its race
  // with a Stop, the claim lost and the deadline, and in the runner's own process group.
  test("a Stop while an incomplete checkout's discard stalls ends the job at once", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      origin: "todo:discarding"
    })
    row.state = "claimed"
    row.claim = "11111111-2222-4333-8444-555555555555"
    const checkout = Workspace.of(stateDir, "todo:discarding")
    mkdirSync(checkout.dir, { recursive: true })
    writeFileSync(join(checkout.dir, "PARTIAL"), "partial\n")
    writeFileSync(checkout.provisioning, `${row.key}\n`)
    const reached = join(root, "forget-reached")
    const jj = join(root, "jj-stalls-in-forget")
    writeFileSync(
      jj,
      `#!/bin/sh\ncase " $* " in *" workspace forget "*) touch "${reached}"; exec sleep 600;; esac\nexec "${resolveJjBinary().path}" "$@"\n`
    )
    chmodSync(jj, 0o755)
    const child = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, SMITHERS_JJ_PATH: jj }
    })
    children.push(child)
    await until(() => existsSync(reached), 60_000)
    row.cancel = true
    expect(await host.settled(row, 20_000)).toEqual({ _tag: "Cancelled", processTreeGone: true })
  }, 120_000)

  // Astra's review of f2ebe829: a job's settled checkout was removed inside the job, so the job held its slot while
  // the removal waited on the mirror.
  test("a settled job frees its slot at once while its checkout's removal stalls", async () => {
    configure({}, { capacity: 1 })
    const reached = join(root, "forget-reached")
    const jj = join(root, "jj-stalls-in-forget")
    writeFileSync(
      jj,
      `#!/bin/sh\ncase " $* " in *" workspace forget "*) touch "${reached}"; exec sleep 600;; esac\nexec "${resolveJjBinary().path}" "$@"\n`
    )
    chmodSync(jj, 0o755)
    const done = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }), {
      origin: "todo:settles"
    })
    const child = spawn(process.execPath, [BIN, "runner", "serve", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, SMITHERS_JJ_PATH: jj }
    })
    children.push(child)
    expect((await host.settled(done, 60_000))._tag).toBe("Done")
    await until(() => existsSync(reached), 30_000)
    // The removal stalls holding the mirror; the runner's one slot is free all the same: the next job is claimed.
    const next = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `y` to `y`" }), {
      origin: "todo:next-slot"
    })
    await until(() => next.state === "claimed", 15_000)
    expect(existsSync(join(stateDir, "removals", `${Workspace.of(stateDir, "todo:settles").name}.json`))).toBe(true)
  }, 120_000)

  test("token writes a 0600 token and prints only its SHA-256; a second token needs --rotate", async () => {
    const state = join(root, "token-state")
    const made = execFileSync(process.execPath, [BIN, "runner", "token", "--state", state], { encoding: "utf8" })
    const token = readFileSync(Config.tokenFile(state), "utf8").trim()
    expect(made.match(/[0-9a-f]{64}/)?.[0]).toBe(Config.sha256(token))
    expect(made).not.toContain(token)
    expect(statSync(Config.tokenFile(state)).mode & 0o777).toBe(0o600)
    expect(() => execFileSync(process.execPath, [BIN, "runner", "token", "--state", state], { stdio: "pipe" }))
      .toThrow()
    const rotated = execFileSync(process.execPath, [BIN, "runner", "token", "--state", state, "--rotate"], {
      encoding: "utf8"
    })
    expect(rotated.match(/[0-9a-f]{64}/)?.[0]).toBe(Config.sha256(readFileSync(Config.tokenFile(state), "utf8").trim()))
    expect(rotated).not.toBe(made)
  }, 60_000)
})

describe("runner configuration", () => {
  const base = {
    origin: "https://smithers.example",
    name: "nyc-01",
    repositories: { [REPOSITORY]: { mirror: "/srv/mirrors/app" } },
    profiles: { "my-agent": { argv: ["my-agent", "--acp"] } }
  }
  const check = (config: Partial<Config.Config>) =>
    Effect.runPromiseExit(Config.check({ ...base, ...config }, "/home/r"))

  test("fills the defaults and expands the state directory", async () => {
    const checked = await Effect.runPromise(Config.check({ ...base, stateDir: "~/runner" }, "/home/r"))
    expect(checked).toMatchObject({
      capacity: 4,
      heartbeatSeconds: 10,
      pollSeconds: 2,
      stateDir: "/home/r/runner",
      admission: { loadPerCpu: 0.5, diskFloorGb: 40, jobLoad: 1 }
    })
    const own = await Effect.runPromise(Config.check({ ...base, admission: { loadPerCpu: 0.75 } }, "/home/r"))
    expect(own.admission).toEqual({ loadPerCpu: 0.75, diskFloorGb: 40, jobLoad: 1 })
    expect((await Effect.runPromise(Config.check(base, "/home/r"))).stateDir).toBe("/home/r/.smithers/runner")
  })

  test("refuses plain http off this machine, an origin with a path, and a relative mirror", async () => {
    expect(Exit.isSuccess(await check({ origin: "http://localhost:8787" }))).toBe(true)
    for (
      const config of [
        { origin: "http://smithers.example" },
        { origin: "https://smithers.example/app" },
        { origin: "not a url" },
        { repositories: { [REPOSITORY]: { mirror: "mirrors/app" } } }
      ]
    ) {
      expect(Exit.isFailure(await check(config))).toBe(true)
    }
  })

  test("load refuses a missing file and one that isn't a runner.json; readToken refuses a missing or empty token", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(Config.load(join(root, "absent.json"))))).toBe(true)
    writeFileSync(join(root, "bad.json"), "{}")
    expect(Exit.isFailure(await Effect.runPromiseExit(Config.load(join(root, "bad.json"))))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(Config.readToken(join(root, "nowhere"))))).toBe(true)
    const empty = join(root, "empty")
    await Effect.runPromise(Config.makeToken(empty))
    writeFileSync(Config.tokenFile(empty), "\n")
    expect(Exit.isFailure(await Effect.runPromiseExit(Config.readToken(empty)))).toBe(true)
  })
})
