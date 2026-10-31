/**
 * `smthrs runner` against a real peer: a loopback HTTP host (fixtures/runner/host.ts), a real jj mirror, and the
 * deterministic ACP test agent from `@smthrs/agent`'s fixtures as the profile's command. The serve loop runs in this
 * process, on its own SQLite journal, except where the case is the process itself: the token command, and a runner
 * killed mid-job and started again.
 */
import * as Transcript from "@smthrs/agent/Transcript"
import { Cause, Effect, Exit, Fiber } from "effect"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Config from "../src/runner/Config.ts"
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
const configure = (profiles: Record<string, Partial<Config.Profile>> = {}) => {
  const agent = { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } }
  const config = {
    origin: host.origin,
    name: "test-runner",
    capacity: 2,
    stateDir,
    heartbeatSeconds: 1,
    pollSeconds: 1,
    repositories: { [REPOSITORY]: { mirror: mirror.path } },
    profiles: {
      "test-agent": agent,
      ...Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...agent, ...profile }]))
    }
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
  for (const child of children.splice(0)) child.kill("SIGKILL")
  await host.close()
  for (const pid of [...pids("agent-"), ...pids("detached-")]) if (alive(pid)) process.kill(pid, "SIGKILL")
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
      expect((await host.settled(row, 150_000))._tag).toBe("Done")
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
  }, 90_000)

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

  test("a reclaimed job whose checkout is gone fails machine_lost", async () => {
    configure()
    const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `x` to `x`" }))
    // As if an earlier runner process claimed it and its machine lost the checkout.
    row.state = "claimed"
    row.claim = "11111111-2222-4333-8444-555555555555"
    serveInProcess()
    expect(await host.settled(row)).toEqual({ _tag: "Failed", reason: "machine_lost" })
  }, 90_000)

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
    const child = spawn(process.execPath, [BIN, "runner", ...args], { stdio: ["ignore", "pipe", "pipe"] })
    children.push(child)
    return child
  }

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
    expect(checked).toMatchObject({ capacity: 4, heartbeatSeconds: 10, pollSeconds: 2, stateDir: "/home/r/runner" })
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
