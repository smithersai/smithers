/** Wrapped harnesses: the vendor argv, the stream fold, and worker runs end to end on stand-in binaries. */
import * as AgentBudget from "@smthrs/agent/Budget"
import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Budget from "../src/budget.ts"
import * as Context from "../src/context.ts"
import * as Host from "../src/host.ts"
import * as Log from "../src/log.ts"
import { Workspace } from "../src/workspace.ts"
import * as Wrapped from "../src/wrapped.ts"

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const saved = { ...process.env }
afterEach(() => {
  for (const key of ["PATH", "FAKE_VENDOR_LOG", "FAKE_VENDOR_PAUSE"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
/** The stand-in vendors on PATH, logging each launch's argv and stdin prompt to a fresh file. */
const vendors = (pause: string): string => {
  const log = join(mkdtempSync(join(tmpdir(), "tui-vendor-")), "argv.log")
  process.env.PATH = `${join(import.meta.dir, "fixtures", "vendor")}:${saved.PATH}`
  process.env.FAKE_VENDOR_LOG = log
  process.env.FAKE_VENDOR_PAUSE = pause
  return log
}
const host = (memory?: Host.Host["memory"]): Host.Host => ({
  cwd: mkdtempSync(join(tmpdir(), "tui-wrapped-")),
  judged: false,
  dispose: async () => {},
  ...(memory === undefined ? {} : { memory }),
  run: () => {
    throw new Error("a wrapped worker never runs the cell harness")
  }
})
const workspaceOn = (on: Host.Host) =>
  new Workspace({ host: on, workerSeat: "worker:test", history: () => [], persist: () => {} })
const until = async (check: () => boolean, tries = 150) => {
  for (let at = 0; at < tries && !check(); at++) await tick(20)
}
const launch = (overrides: Partial<Wrapped.Launch> = {}): Wrapped.Launch => ({
  vendor: "claude",
  prompt: "Fix it.",
  cwd: "/repo",
  brief: "BRIEF",
  session: "s-1",
  resume: false,
  approve: "all",
  ...overrides
})

describe("vendor argv", () => {
  it("encodes Codex instructions as TOML-safe text on headless and interactive runs", () => {
    const brief = "say \"hello\"\n\u007f🦄"
    const expected = "developer_instructions=\"say \\\"hello\\\"\\n\\u007f🦄\""
    expect(Wrapped.headless(launch({ vendor: "codex", brief })).args).toContain(expected)
    expect(Wrapped.interactive("codex", "s-1", "/repo", brief, "all").args).toContain(expected)
  })

  it.each(["\ud800", "\udfff"])("refuses malformed Unicode %j in Codex instructions", (brief) => {
    expect(() => Wrapped.headless(launch({ vendor: "codex", brief }))).toThrow(RangeError)
    expect(() => Wrapped.interactive("codex", "s-1", "/repo", brief, "all")).toThrow("malformed Unicode")
  })

  it("starts Claude Code headless on the chosen session with the brief, and resumes it with the same brief", () => {
    expect(Wrapped.headless(launch()).args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      "BRIEF",
      "--session-id",
      "s-1",
      "--permission-mode",
      "bypassPermissions"
    ])
    const resumed = Wrapped.headless(launch({ resume: true, approve: "ask" })).args
    expect(resumed).toContain("BRIEF")
    expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "s-1"])
    // Headless it cannot ask: anything short of `all` only reads.
    expect(resumed.at(-1)).toBe("plan")
  })

  it("starts Codex with developer instructions and resumes its thread, reading the prompt from stdin", () => {
    expect(Wrapped.headless(launch({ vendor: "codex", session: undefined, brief: "say \"hi\"" }))).toEqual({
      command: "codex",
      args: [
        "exec",
        "-C",
        "/repo",
        "--json",
        "--skip-git-repo-check",
        "-c",
        "developer_instructions=\"say \\\"hi\\\"\"",
        "--dangerously-bypass-approvals-and-sandbox",
        "-"
      ]
    })
    const denied = Wrapped.headless(launch({ vendor: "codex", resume: true, approve: "deny" })).args
    expect(denied.slice(0, 3)).toEqual(["exec", "resume", "s-1"])
    expect(denied.slice(-3)).toEqual(["-s", "read-only", "-"])
  })

  it("never puts the prompt in argv, so a prompt shaped like a flag stays text", () => {
    for (const vendor of Wrapped.vendors) {
      const prompt = "--dangerously-skip-permissions"
      expect(Wrapped.headless(launch({ vendor, prompt, approve: "deny" })).args).not.toContain(prompt)
    }
  })

  it("takes over on the vendor's own TUI with the same brief (the 0.x resume table)", () => {
    expect(Wrapped.interactive("claude", "s-1", "/repo", "BRIEF", "ask")).toEqual({
      command: "claude",
      args: ["--resume", "s-1", "--append-system-prompt", "BRIEF"]
    })
    expect(Wrapped.interactive("codex", "s-1", "/repo", "BRIEF", "all")).toEqual({
      command: "codex",
      args: [
        "resume",
        "s-1",
        "-C",
        "/repo",
        "-c",
        "developer_instructions=\"BRIEF\"",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    })
  })
})

describe("stream fold", () => {
  it("draws Claude Code's rows in its own glyphs and reads its session, usage and answer", () => {
    expect(Wrapped.fold("claude", "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-1\"}")).toEqual({
      rows: [],
      announce: "s-1"
    })
    expect(Wrapped.fold(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Checking.\nMore." }, {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun test" }
          }],
          usage: { input_tokens: 4, cache_read_input_tokens: 90, cache_creation_input_tokens: 6, output_tokens: 2 }
        }
      })
    )).toEqual({
      settled: true,
      rows: [{ glyph: "⏺", text: "Checking." }, { glyph: "⏺", text: "Bash(bun test)" }],
      usage: { input: 100, output: 2, cached: 90 }
    })
    expect(
      Wrapped.fold(
        "claude",
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: "a\nb\nc" }] }
        })
      ).rows
    ).toEqual([{ glyph: "  ⎿", text: "a (+2 lines)" }])
    expect(Wrapped.fold("claude", "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}").answer).toBe(
      "done"
    )
    expect(Wrapped.fold("claude", "{\"type\":\"result\",\"subtype\":\"error_max_turns\",\"is_error\":true}").error)
      .toBe("error_max_turns")
    expect(Wrapped.fold("claude", "not json")).toEqual({ rows: [] })
  })

  it("prices a Claude Code call by the model it names, and leaves an unpriced one without USD", () => {
    const assistant = (model: string) =>
      Wrapped.fold(
        "claude",
        JSON.stringify({
          type: "assistant",
          message: {
            model,
            content: [],
            usage: { input_tokens: 4, cache_read_input_tokens: 90, cache_creation_input_tokens: 6, output_tokens: 2 }
          }
        })
      ).usage
    // claude-sonnet-5: 4 × $2 + 90 cache reads × $0.2 + 6 cache writes × $2.5 + 2 out × $10 per million.
    expect(assistant("claude-sonnet-5")).toEqual({ input: 100, output: 2, cached: 90, usd: 0.000061 })
    expect(assistant("fixture-model")).toEqual({ input: 100, output: 2, cached: 90 })
  })

  it("draws Codex's rows in its own glyphs and reads its thread, usage and answer", () => {
    // Codex names its thread first; only a completed turn makes it resumable.
    expect(Wrapped.fold("codex", "{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}")).toEqual({
      rows: [],
      announce: "t-1"
    })
    expect(Wrapped.fold("codex", "{\"type\":\"turn.completed\",\"usage\":{}}").settled).toBe(true)
    expect(
      Wrapped.fold(
        "codex",
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "bun test", aggregated_output: "ok\n", exit_code: 0 }
        })
      ).rows
    ).toEqual([{ glyph: "•", text: "Ran bun test" }, { glyph: "  └", text: "ok" }])
    expect(
      Wrapped.fold("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }))
    )
      .toEqual({ rows: [{ glyph: "•", text: "Done." }], answer: "Done." })
    expect(
      Wrapped.fold(
        "codex",
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5, reasoning_output_tokens: 3 }
        })
      ).usage
    ).toEqual({ input: 100, output: 8, cached: 80 })
  })
})

it("runs a Claude Code worker on its session with memory and the shared brief, and continues it after a take-over", async () => {
  const log = vendors("0.4")
  const on = host(async (task) => ({ text: `REMEMBER for ${task}`, kept: 7, withheld: 4 }))
  const workspace = workspaceOn(on)
  workspace.request({ id: "c", title: "fix session", prompt: "Fix the session.", harness: "claude", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  await until(() => tab().harness?.session !== undefined)
  const session = tab().harness!.session!
  expect(session).toMatch(/^[0-9a-f-]{36}$/)
  expect(workspace.hijack("c", "you")).toBe(true)
  const tui = await workspace.handedOver("c")
  const brief = readFileSync(tab().harness!.brief!, "utf8")
  // A temporary directory is in no repository, and the brief says so.
  expect(brief).toBe(`${SmithersPlugin.brief}\n\n${Context.noVcsRule}\n\nREMEMBER for Fix the session.`)
  expect(tui).toEqual({
    command: "claude",
    args: ["--resume", session, "--append-system-prompt", brief, "--permission-mode", "bypassPermissions"]
  })
  expect(tab().status).toBe("running")
  workspace.release("c")
  await until(() => tab().status === "done")
  expect(tab()).toMatchObject({ status: "done", answer: "Refreshed the cookie before retry." })
  expect(tab().drivers).toHaveLength(1)
  const notes = workspace.transcript("c").items.filter((item) => item.kind === "note").map((item) => item.text)
  expect(notes).toContain("→ memory 7 in · 4 withheld")
  expect(notes).toContain("⏺ Read(src/session.ts)")
  expect(notes).toContain("  ⎿ line one (+2 lines)")
  // The stopped run never reached its first call; the resumed one made two, one repeated per block.
  expect(workspace.transcript("c").usage).toMatchObject({ input: 200, cached: 180 })
  // claude-sonnet-5 per call: 10 × $2 + 90 cached × $0.2 + 5 out × $10 per million.
  expect(workspace.transcript("c").usage.usd).toBeCloseTo(0.000176, 12)
  const argv = readFileSync(log, "utf8").trim().split("\n")
  expect(argv[0]).toContain(`--session-id ${session}`)
  expect(argv[0]).toContain("<<< Fix the session.")
  expect(argv[1]).toContain(`--resume ${session}`)
  expect(argv[1]).toContain(`<<< ${Wrapped.continuePrompt}`)
  // The same bytes on every launch of the session.
  for (const line of argv) expect(line).toContain(`--append-system-prompt ${brief.replaceAll("\n", " ")}`)
})

it("continues a finished Claude Code worker with the person's prompt on its existing session", async () => {
  const log = vendors("0")
  const workspace = workspaceOn(host())
  workspace.request({ id: "c", title: "Fix", prompt: "Find the cause.", harness: "claude", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  await until(() => tab().status === "done")
  const session = tab().harness!.session!
  const brief = tab().harness!.brief!
  const file = tab().file
  expect(workspace.continue("c", "Correct the cache key.")).toEqual({ id: "c", status: "requested" })
  await until(() => tab().status === "done" && readFileSync(log, "utf8").trim().split("\n").length === 2)
  expect(tab()).toMatchObject({ file, harness: { vendor: "claude", session, brief } })
  const argv = readFileSync(log, "utf8").trim().split("\n")
  expect(argv[0]).toContain(`--session-id ${session}`)
  expect(argv[0]).toContain("<<< Find the cause.")
  expect(argv[1]).toContain(`--resume ${session}`)
  expect(argv[1]).toContain("<<< Correct the cache key.")
  expect(argv[1]).not.toContain(`<<< ${Wrapped.continuePrompt}`)
  workspace.dispose()
})

it("resends a wrapped follow-up after its vendor failed to launch", async () => {
  const log = vendors("0")
  const vendorPath = process.env.PATH!
  const workspace = workspaceOn(host())
  workspace.request({ id: "c", title: "Fix", prompt: "Find the cause.", harness: "claude", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  await until(() => tab().status === "done")
  const session = tab().harness!.session!
  process.env.PATH = mkdtempSync(join(tmpdir(), "tui-no-vendor-"))
  workspace.continue("c", "Correct the cache key.")
  await until(() => tab().status === "failed")
  expect(tab().status).toBe("failed")
  process.env.PATH = vendorPath
  workspace.retry("c", "user")
  await until(() => tab().status === "done")
  expect(tab().status).toBe("done")
  const argv = readFileSync(log, "utf8").trim().split("\n")
  expect(argv).toHaveLength(2)
  expect(argv[1]).toContain(`--resume ${session}`)
  expect(argv[1]).toContain("<<< Correct the cache key.")
  expect(argv[1]).not.toContain(`<<< ${Wrapped.continuePrompt}`)
  workspace.dispose()
})

it("hands a Codex worker over only after its turn completes, then resumes its thread", async () => {
  const log = vendors("0.3")
  const on = host()
  const workspace = workspaceOn(on)
  workspace.request({ id: "x", title: "fix queue", prompt: "Fix the queue.", harness: "codex", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  // Codex can be taken over once it names its thread; the hand-over waits for its turn.
  let taken = false
  await until(() => (taken = workspace.hijack("x", "you")))
  expect(taken).toBe(true)
  const notes = () => workspace.transcript("x").items.filter((item) => item.kind === "note").map((item) => item.text)
  const tui = await workspace.handedOver("x")
  // The turn ran to its end before the terminal was handed over.
  expect(notes()).toContain("• Fixed the flaky queue.")
  expect(notes()).toContain("→ memory unavailable")
  expect(tui.args.slice(0, 4)).toEqual(["resume", tab().harness!.session!, "-C", on.cwd])
  workspace.release("x")
  await until(() => tab().status === "done")
  expect(tab()).toMatchObject({ status: "done", answer: "Fixed the flaky queue." })
  const argv = readFileSync(log, "utf8").trim().split("\n")
  expect(argv[0]!.startsWith("exec -C")).toBe(true)
  expect(argv[1]!.startsWith(`exec resume ${tab().harness!.session}`)).toBe(true)
  expect(workspace.transcript("x").usage).toMatchObject({ input: 200, cached: 160 })
})

it("drops a take-over stopped before its hand-over, so a retry runs once to its end", async () => {
  const log = vendors("0.5")
  const workspace = workspaceOn(host())
  workspace.request({ id: "x", title: "fix queue", prompt: "Fix the queue.", harness: "codex", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  // Codex can be taken over once it names its thread; the hand-over waits for its turn.
  let taken = false
  await until(() => (taken = workspace.hijack("x", "you")))
  expect(taken).toBe(true)
  const handover = workspace.handedOver("x")
  workspace.cancel("x")
  await expect(handover).rejects.toThrow("stopped before it was handed over")
  await until(() => tab().status === "cancelled")
  expect(tab().status).toBe("cancelled")
  workspace.retry("x", "user")
  await until(() => tab().status === "done")
  expect(tab().status).toBe("done")
  await tick(300)
  // The first run, then one resumed run: no loop.
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
})

it("keeps the session's brief bytes across a retry, even when memory would now answer differently", async () => {
  vendors("0.5")
  let calls = 0
  const workspace = workspaceOn(host(async () => ({ text: `memory ${++calls}`, kept: 1, withheld: 0 })))
  workspace.request({ id: "c", title: "t", prompt: "Do it.", harness: "claude", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  await until(() => tab().harness?.session !== undefined)
  const file = tab().harness!.brief!
  const first = readFileSync(file, "utf8")
  expect(first).toContain("memory 1")
  workspace.cancel("c")
  await until(() => tab().status === "cancelled")
  workspace.retry("c", "user")
  await until(() => tab().status === "done", 500)
  expect(tab().status).toBe("done")
  expect(tab().harness!.brief).toBe(file)
  expect(readFileSync(file, "utf8")).toBe(first)
  expect(calls).toBe(1)
}, 15_000)

it("ends a wrapped worker's take-over on restart and continues it headless on its session", async () => {
  // Still running when the first process goes away.
  const log = vendors("1")
  const on = host()
  const first = workspaceOn(on)
  first.request({ id: "c", title: "t", prompt: "Do it.", harness: "claude", by: "user" })
  const tab = (workspace: Workspace) => workspace.snapshot().tabs[0]!
  await until(() => tab(first).harness?.session !== undefined)
  const saved = { ...tab(first), status: "running" as const, driver: { by: "you", from: 1, messages: 0 } }
  first.dispose()
  const second = new Workspace({
    host: on,
    workerSeat: "worker:test",
    history: () => [],
    persist: () => {},
    restored: { tabs: [saved], panels: [] }
  })
  await until(() => tab(second).status === "done", 500)
  expect(tab(second).driver).toBeUndefined()
  expect(tab(second).drivers).toHaveLength(1)
  expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toContain(`--resume ${saved.harness!.session}`)
}, 15_000)

it("withdraws a take-over released before its hand-over, so the vendor's TUI never runs beside the headless run", async () => {
  const log = vendors("0.3")
  const workspace = workspaceOn(host())
  workspace.request({ id: "x", title: "fix queue", prompt: "Fix the queue.", harness: "codex", by: "user" })
  const tab = () => workspace.snapshot().tabs[0]!
  let taken = false
  await until(() => (taken = workspace.hijack("x", "you")))
  expect(taken).toBe(true)
  const handover = workspace.handedOver("x")
  expect(workspace.release("x")).toBe(true)
  await expect(handover).rejects.toThrow("released before it was handed over")
  await until(() => tab().status === "done")
  expect(tab()).toMatchObject({ status: "done", answer: "Fixed the flaky queue." })
  // One headless run, never a resumed one or the TUI.
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
})

it("titles wrapped workers from the prompt at a word boundary without asking another provider", async () => {
  vendors("0")
  const asked: Array<string> = []
  const on: Host.Host = { ...host(), describe: async ({ seat }) => (asked.push(seat), "title") }
  const workspace = new Workspace({ host: on, workerSeat: "openai:gpt-6-sol", history: () => [], persist: () => {} })
  const prompt =
    "Investigate the stale cache key in the worker continuation path and verify every persisted session message."
  workspace.request({ id: "c", title: "t", prompt, harness: "claude", by: "user" })
  await until(() => workspace.snapshot().tabs[0]!.status === "done")
  const description = workspace.snapshot().tabs[0]!.description!
  expect(description.length).toBeLessThanOrEqual(80)
  expect(prompt.startsWith(description)).toBe(true)
  expect(prompt[description.length]).toBe(" ")
  expect(asked).toEqual([])
  workspace.dispose()
})

/** A real host's caps over `ledger`, with no memory flow: what a wrapped worker's run answers to. */
const cappedHost = (budget: AgentBudget.Policy, ledger: AgentBudget.Ledger): Host.Host => {
  const { memory: _memory, ...on } = Host.make({
    cwd: mkdtempSync(join(tmpdir(), "tui-wrapped-cap-")),
    environment: {},
    approvals: "all",
    budget,
    ledger
  })
  return on
}
const today = () => new Date().toISOString().slice(0, 10)

it("stops a Claude Code worker at its run cap, charges its calls to the day, and resumes it under a raised cap", async () => {
  const log = vendors("0.5")
  const ledger = AgentBudget.memoryLedger()
  const on = cappedHost({ tokens: { max: 200, onExceeded: "fail" }, daily: { max: 5000 } }, ledger)
  const alerts: Array<string> = []
  const stop = Log.subscribe((message) => alerts.push(message))
  try {
    const workspace = workspaceOn(on)
    workspace.request({ id: "c", title: "fix session", prompt: "Fix the session.", harness: "claude", by: "user" })
    const tab = () => workspace.snapshot().tabs[0]!
    await until(() => tab().status === "failed")
    // Each call is 105 tokens, so a second would pass 200: the vendor is stopped after its first.
    expect(tab().failure?.headline).toBe("Token budget reached")
    expect(Budget.capped(tab().failure)).toBe(true)
    expect(await Effect.runPromise(ledger.total(today()))).toBe(105)
    expect(workspace.transcript("c").usage).toMatchObject({ input: 100, output: 5 })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatch(/^Run token cap reached: 105 of 200 tokens used by worker tui-[0-9a-f]{8}-1\./)
    const session = tab().harness!.session!
    // Twice the cap is a new run's allowance: both of the resumed run's calls fit in 400.
    workspace.raiseCap("c", { times: 2 })
    await until(() => tab().status === "done")
    expect(tab()).toMatchObject({ status: "done", answer: "Refreshed the cookie before retry." })
    expect(await Effect.runPromise(ledger.total(today()))).toBe(315)
    expect(alerts).toHaveLength(1)
    const argv = readFileSync(log, "utf8").trim().split("\n")
    expect(argv).toHaveLength(2)
    expect(argv[1]).toContain(`--resume ${session}`)
  } finally {
    stop()
    await on.dispose()
  }
})

it("charges a Codex worker's turn to the day, and starts no vendor once the day's cap is spent", async () => {
  const log = vendors("0")
  const ledger = AgentBudget.memoryLedger()
  const on = cappedHost({ daily: { max: 108 } }, ledger)
  const alerts: Array<string> = []
  const stop = Log.subscribe((message) => alerts.push(message))
  try {
    const workspace = workspaceOn(on)
    workspace.request({ id: "x", title: "fix queue", prompt: "Fix the queue.", harness: "codex", by: "user" })
    const tab = (index: number) => workspace.snapshot().tabs[index]!
    await until(() => tab(0).status === "done")
    // The turn that spent the day had already answered: it is charged, 100 in and 8 out, and stays done.
    expect(tab(0)).toMatchObject({ status: "done", answer: "Fixed the flaky queue." })
    expect(await Effect.runPromise(ledger.total(today()))).toBe(108)
    for (const harness of ["codex", "claude"] as const) {
      workspace.request({ id: harness, title: "next", prompt: "Next.", harness, by: "user" })
    }
    await until(() => tab(1).status === "failed" && tab(2).status === "failed")
    for (const index of [1, 2]) {
      expect(tab(index).failure).toMatchObject({
        headline: "Daily token cap reached",
        line: "108 of 108 tokens used today."
      })
    }
    expect(alerts[0]).toMatch(/^Daily token cap reached: 108 of 108 tokens used today, stopped at worker tui-/)
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
  } finally {
    stop()
    await on.dispose()
  }
})

it("fails a wrapped worker whose spend cannot be recorded, and stops its vendor", async () => {
  const log = vendors("0.5")
  const memory = AgentBudget.memoryLedger()
  const on = cappedHost({ daily: { max: 5000 } }, {
    ...memory,
    record: () => Effect.fail(new Error("the spend file is read-only"))
  })
  try {
    const workspace = workspaceOn(on)
    workspace.request({ id: "c", title: "fix session", prompt: "Fix the session.", harness: "claude", by: "user" })
    const tab = () => workspace.snapshot().tabs[0]!
    await until(() => tab().status === "failed")
    expect(tab().detail).toContain("the spend file is read-only")
    const notes = workspace.transcript("c").items.filter((item) => item.kind === "note").map((item) => item.text)
    expect(notes).not.toContain("⏺ Refreshed the cookie before retry.")
    expect(existsSync(log)).toBe(true)
  } finally {
    await on.dispose()
  }
})
