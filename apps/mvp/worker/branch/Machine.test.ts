// What a branch's machine does for its tools and lifecycle (worker/branch/Machine.ts,
// docs/features/sandbox-tools.md#the-machine), over a `Box` whose sessions are real local processes in a scratch git
// clone and whose storage is in memory: the stand-in for the Cloudflare container and its Durable Object storage
// (worker/BranchSandboxes.ts), whose real container the e2e suite drives. `@smthrs/sandbox`'s `SandboxTools` run their
// real scripts and real git here. The box maps the container's `/home` onto a scratch directory, and it answers its
// root commands, provisioning a person's user and the idle probe, from the test, because they need root, tmux and
// Linux's /proc; this host has none of them.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Exit, Fiber, Logger, Metric } from "effect"
import { TestClock } from "effect/testing"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { SANDBOX_USER } from "../../src/features/terminal/contract.ts"
import * as Box from "../test/box.ts"
import * as Machine from "./Machine.ts"
import { provisionArgv, userOf } from "./Users.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-machine-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

/** The branch's repository: one commit of README.md, `base`. */
const origin = join(root, "origin")
mkdirSync(origin)
git(origin, "init", "-q", "-b", "main")
writeFileSync(join(origin, "README.md"), "hello\n")
git(origin, "add", ".")
git(origin, "commit", "-q", "-m", "base")
const base = git(origin, "rev-parse", "HEAD")

let machines = 0
/** A fresh machine's checkout: a clone of the branch, as a wake makes one. Empty with `clone: false`. */
const checkout = (clone = true) => {
  const workdir = join(root, `machine-${++machines}`)
  if (clone) execFileSync("git", ["clone", "-q", origin, workdir])
  else mkdirSync(workdir)
  return workdir
}

interface BoxOptions extends Omit<Box.BoxOptions, "workdir" | "homes"> {
  readonly workdir?: string
}

/** A machine's box over its checkout (a fresh clone unless given), recording every root command, session and stop. */
const boxOf = (options: BoxOptions = {}) => {
  const workdir = options.workdir ?? checkout()
  return Box.boxAt({ ...options, workdir, homes: join(root, `homes-${machines}`) })
}

const { memory } = Box

/** Runs `effect` with a logger and metric registry of its own: its result, log lines and the checkpoints it counted. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const value = await Effect.runPromise(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const counted = (op: string, outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(Machine.checkpoints, { op, outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  const decisions = (outcome: string, reason: string) => Effect.runSync(
    Metric.value(Metric.withAttributes(Machine.sleepDecisions, { outcome, reason })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  ).count
  return { value, lines, counted, decisions }
}

const PERSON = "person-a"
const USER = userOf(PERSON)
let calls = 0
const tool = (box: Machine.Box<never>, call: Parameters<typeof Machine.tool>[1]["call"], generation = 1, callId = `c-${++calls}`) =>
  Machine.tool(box, { ownerId: PERSON, callId, call, generation })

/** The checkpoint record the object's storage holds. */
const saved = (map: Map<string, unknown>) =>
  map.get("checkpoint") as { generation: number; head: string; seq: number; pieces: number; bytes: number; bundleBytes?: number }

describe("tool", () => {
  test("base-relative status includes agent commits and pending edits, and excludes reverted work", async () => {
    const machine = boxOf()
    writeFileSync(join(machine.workdir, "slept.txt"), "committed\n")
    git(machine.workdir, "add", ".")
    git(machine.workdir, "commit", "-m", "agent commit")
    const status = () => Effect.runPromise(tool(machine.box, { tool: "status", base }))
    expect(await status()).toMatchObject({ _tag: "Done", result: { entries: [{ path: "slept.txt", index: "A" }] } })
    writeFileSync(join(machine.workdir, "README.md"), "pending\n")
    expect(await status()).toMatchObject({ _tag: "Done", result: { entries: [
      { path: "README.md", index: "M" }, { path: "slept.txt", index: "A" },
    ] } })
    git(machine.workdir, "reset", "--hard", base)
    expect(await status()).toMatchObject({ _tag: "Done", result: { entries: [] } })
  })

  test("runs a call as the person's own user, made first, and saves the working copy after a write or a run only", async () => {
    const machine = boxOf()
    await Effect.runPromise(Machine.restore(machine.box, 1))

    const wrote = await observed(tool(machine.box, { tool: "write", path: "hello.txt", content: "hi\n" }))
    expect(wrote.value).toEqual({ _tag: "Done", result: { tool: "write", path: "hello.txt", bytes: 3 }, generation: 1 })
    expect(machine.runs).toEqual([{ argv: provisionArgv(USER), user: "root" }])
    expect(machine.sessions).toEqual([USER, SANDBOX_USER])
    expect(wrote.counted("save", "saved")).toBe(1)
    expect(saved(machine.map)).toMatchObject({ generation: 1, head: git(machine.workdir, "rev-parse", "HEAD"), pieces: 1 })
    expect(machine.map.get("activeAt")).toEqual(expect.any(Number))

    const read = await observed(tool(machine.box, { tool: "read", path: "hello.txt" }))
    expect(read.value).toMatchObject({ _tag: "Done", result: { tool: "read", content: "hi\n" } })
    expect(read.counted("save", "saved")).toBe(0)

    const ran = await observed(tool(machine.box, { tool: "run", command: "echo ran >> runs.log; cat runs.log" }, 1, "run-1"))
    expect(ran.value).toMatchObject({ _tag: "Done", result: { tool: "run", exitCode: 0, stdout: "ran\n" } })
    expect(ran.counted("save", "saved")).toBe(1)
    // The command's fence and result are in the person's own home, outside the checkout.
    expect(existsSync(join(machine.homes, USER, ".smithers", "calls", "run-1", "exit"))).toBe(true)
    expect(Machine.callsDirectory(USER)).toBe(`/home/${USER}/.smithers/calls`)
  })

  test("a refusal, a lost command, a failed provision and a failing session are their outcomes; a broken host is logged", async () => {
    const machine = boxOf()
    expect(await Effect.runPromise(tool(machine.box, { tool: "read", path: "../outside" }))).toEqual({
      _tag: "Refused",
      reason: "path",
    })
    // An earlier attempt started this command and never recorded how it ended.
    mkdirSync(join(machine.homes, USER, ".smithers", "calls", "started"), { recursive: true })
    expect(await Effect.runPromise(tool(machine.box, { tool: "run", command: "touch ran" }, 1, "started"))).toEqual({
      _tag: "Lost",
    })
    expect(existsSync(join(machine.workdir, "ran"))).toBe(false)

    const unprovisioned = boxOf({ root: () => Effect.succeed(1) })
    expect(await Effect.runPromise(tool(unprovisioned.box, { tool: "status" }))).toEqual({ _tag: "Unavailable" })
    expect(unprovisioned.sessions).toEqual([])

    const failing = boxOf({ downFor: [USER] })
    expect(await Effect.runPromise(tool(failing.box, { tool: "status" }))).toEqual({ _tag: "Unavailable" })

    const broken = boxOf({ root: () => Effect.fail(new Error("container gone")) })
    const logged = await observed(tool(broken.box, { tool: "status" }))
    expect(logged.value).toEqual({ _tag: "Unavailable" })
    expect(logged.lines).toMatchObject([{ message: "sandbox.object.tool", level: "WARN" }])
    expect(logged.lines[0]!.annotations).toHaveProperty("errorCode")
  })
})

/** Runs one command operation on `box` as `PERSON`, on generation `generation` (`null`: the machine isn't running). */
const command = (box: Machine.Box<never>, request: Parameters<typeof Machine.command>[1]["request"], generation: number | null = 1) =>
  Machine.command(box, { ownerId: PERSON, request, generation: generation ?? undefined })

/** Observes `key` until its command finished. */
const finished = async (box: Machine.Box<never>, key: string) => {
  for (let tries = 0; tries < 400; tries++) {
    const outcome = await Effect.runPromise(command(box, { op: "observe", key }))
    if (outcome._tag !== "Observed" || outcome.observed.state !== "running") return outcome
    await Effect.runPromise(Effect.sleep("25 millis"))
  }
  throw new Error("the command never finished")
}

describe("command", () => {
  test("starts a command detached as the person's own user, once per key, then observes, collects and cancels it", async () => {
    const machine = boxOf()
    await Effect.runPromise(Machine.restore(machine.box, 1))
    const call = { tool: "run", command: "echo ran >> runs.log; sleep 1; echo done" } as const
    const started = await Effect.runPromise(command(machine.box, { op: "start", key: "job#g1", call }))
    expect(started).toEqual({
      _tag: "Started",
      started: { pid: expect.any(Number), startedAt: expect.any(Number) },
      generation: 1,
    })
    expect(machine.runs).toEqual([{ argv: provisionArgv(USER), user: "root" }])
    expect(machine.map.get("run:job#g1")).toEqual({ generation: 1, at: expect.any(Number) })
    expect(machine.map.get("activeAt")).toEqual(expect.any(Number))
    // Asked again, the same key answers the same handle and starts nothing.
    expect(await Effect.runPromise(command(machine.box, { op: "start", key: "job#g1", call }))).toEqual(started)
    expect(await finished(machine.box, "job#g1")).toEqual({
      _tag: "Observed",
      observed: { state: "finished", exitCode: 0, timedOut: false },
    })
    const collected = await observed(command(machine.box, { op: "collect", key: "job#g1" }))
    expect(collected.value).toMatchObject({ _tag: "Collected", result: { exitCode: 0, stdout: "done\n" } })
    expect(collected.lines.at(-1)).toMatchObject({
      message: "sandbox.object.command",
      level: "INFO",
      annotations: { op: "collect", outcome: "Collected", durationMs: expect.any(Number) },
    })
    // A collected command changed the working copy, which is saved as a tool call's is.
    expect(collected.counted("save", "saved")).toBe(1)
    expect(await Effect.runPromise(command(machine.box, { op: "cancel", key: "job#g1" }))).toEqual({ _tag: "Cancelled" })
    expect(readFileSync(join(machine.workdir, "runs.log"), "utf8")).toBe("ran\n")
    // Its pid, exit and output are in the person's own home, outside the checkout.
    expect(existsSync(join(machine.homes, USER, ".smithers", "calls", "command-job_23g1", "exit"))).toBe(true)
  })

  test("a command another generation started, or one whose machine stopped, is gone, and never starts again", async () => {
    const store = memory()
    const first = boxOf({ store })
    const call = { tool: "run", command: "echo ran >> runs.log" } as const
    await Effect.runPromise(command(first.box, { op: "start", key: "gone#g1", call }))
    // A new machine under the same object: the command is gone with the first.
    const second = boxOf({ store })
    expect(await Effect.runPromise(command(second.box, { op: "start", key: "gone#g1", call }, 2))).toEqual({ _tag: "Lost" })
    expect(await Effect.runPromise(command(second.box, { op: "observe", key: "gone#g1" }, 2))).toEqual({
      _tag: "Observed",
      observed: { state: "lost" },
    })
    // A stopped machine (no generation running) answers every command gone, and a key it never started too.
    expect(await Effect.runPromise(command(second.box, { op: "collect", key: "gone#g1" }, null))).toEqual({
      _tag: "Lost",
    })
    expect(await Effect.runPromise(command(second.box, { op: "cancel", key: "never#g1" }, null))).toEqual({
      _tag: "Cancelled",
    })
    expect(await Effect.runPromise(command(second.box, { op: "start", key: "never#g1", call }, null))).toEqual({
      _tag: "Lost",
    })
    expect(existsSync(join(second.workdir, "runs.log"))).toBe(false)
    expect(second.sessions).toEqual([])
  })

  test("a key cancelled before its start reached the machine never starts; nor does a command its call ran as a tool", async () => {
    const machine = boxOf()
    const call = { tool: "run", command: "echo ran >> runs.log" } as const
    // An abandon that came first: the start still on its way finds the key gone.
    expect(await Effect.runPromise(command(machine.box, { op: "cancel", key: "abandoned#g1" }))).toEqual({
      _tag: "Cancelled",
    })
    expect(machine.map.get("run:abandoned#g1")).toEqual({ generation: 0, at: expect.any(Number) })
    expect(await Effect.runPromise(command(machine.box, { op: "start", key: "abandoned#g1", call }))).toEqual({
      _tag: "Lost",
    })
    // An abandon that comes while the start provisions the person's user, as the object takes requests between execs.
    const raced: { box?: Machine.Box<never> } = {}
    const racing = boxOf({
      root: () => Effect.as(command(raced.box!, { op: "cancel", key: "raced#g1" }), 0),
    })
    raced.box = racing.box
    expect(await Effect.runPromise(command(racing.box, { op: "start", key: "raced#g1", call }))).toEqual({ _tag: "Lost" })
    expect(existsSync(join(racing.workdir, "runs.log"))).toBe(false)
    // A tool call whose command an earlier attempt ran as a tool call: its job never runs it again.
    await Effect.runPromise(tool(machine.box, call, 1, "call-1"))
    expect(await Effect.runPromise(command(machine.box, { op: "start", key: "job#g1", call, callId: "call-1" }))).toEqual({
      _tag: "Lost",
    })
    // A call that never ran as a tool call starts its job.
    expect(await Effect.runPromise(command(machine.box, { op: "start", key: "job-2#g1", call, callId: "call-2" })))
      .toMatchObject({ _tag: "Started" })
    expect(await finished(machine.box, "job-2#g1")).toMatchObject({ observed: { state: "finished" } })
    expect(readFileSync(join(machine.workdir, "runs.log"), "utf8")).toBe("ran\nran\n")
  })

  test("a refusal, a lost command, a failed provision and a failing session are their outcomes; a broken host is logged", async () => {
    const machine = boxOf()
    const run = { tool: "run", command: "touch ran" } as const
    expect(await Effect.runPromise(command(machine.box, { op: "start", key: "out#g1", call: { ...run, cwd: "../x" } })))
      .toEqual({ _tag: "Refused", reason: "path" })
    // Started on this generation, but nothing recorded how it ended.
    machine.map.set("run:silent#g1", { generation: 1, at: Date.now() })
    expect(await Effect.runPromise(command(machine.box, { op: "collect", key: "silent#g1" }))).toEqual({ _tag: "Lost" })

    const unprovisioned = boxOf({ root: () => Effect.succeed(1) })
    expect(await Effect.runPromise(command(unprovisioned.box, { op: "start", key: "k#g1", call: run }))).toEqual({
      _tag: "Unavailable",
    })
    expect(unprovisioned.sessions).toEqual([])

    // The person's session fails: the provider's code, so the engine knows whether trying again can help.
    const failing = boxOf({ downFor: [USER] })
    expect(await Effect.runPromise(command(failing.box, { op: "start", key: "k#g1", call: run }))).toEqual({
      _tag: "ToolUnavailable",
      code: "unavailable",
    })
    // A script step that failed names its exit code: the calls directory is a file.
    const blocked = boxOf()
    mkdirSync(join(blocked.homes, USER, ".smithers"), { recursive: true })
    writeFileSync(join(blocked.homes, USER, ".smithers", "calls"), "")
    expect(await Effect.runPromise(command(blocked.box, { op: "start", key: "k#g1", call: run }))).toEqual({
      _tag: "ToolUnavailable",
      code: "unknown",
      exitCode: 125,
    })

    const broken = boxOf({ root: () => Effect.fail(new Error("container gone")) })
    const logged = await observed(command(broken.box, { op: "start", key: "k#g1", call: run }))
    expect(logged.value).toEqual({ _tag: "Unavailable" })
    // The failure by its code, then the operation's line: what it answered and how long it took, never the command.
    expect(logged.lines).toMatchObject([
      { message: "sandbox.object.command", level: "WARN" },
      { message: "sandbox.object.command", level: "INFO", annotations: { op: "start", outcome: "Unavailable" } },
    ])
    expect(logged.lines[0]!.annotations).toMatchObject({ op: "start", stage: "provision", errorCode: expect.any(String) })
    expect(logged.lines[1]!.annotations).toHaveProperty("durationMs", expect.any(Number))
    expect(JSON.stringify(logged.lines)).not.toContain("touch ran")

    // An exec whose exit never comes answers Unavailable once COMMAND_EXEC_MS passed, so the job asks again, and its
    // line names the stage it hung in.
    for (const [stage, hung] of [
      ["provision", boxOf({ root: () => Effect.never })],
      ["script", boxOf({ hungFor: [USER] })],
    ] as const) {
      const timedOut = await observed(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(command(hung.box, { op: "start", key: "k#g1", call: run }))
        yield* TestClock.adjust(Machine.COMMAND_EXEC_MS)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())))
      expect(timedOut.value).toEqual({ _tag: "Unavailable" })
      expect(timedOut.lines[0]).toMatchObject({
        message: "sandbox.object.command",
        level: "WARN",
        annotations: { op: "start", stage, errorCode: "timeout" },
      })
    }
  })
})

describe("tool across machines", () => {
  test("a command a restarted machine's earlier generation started is lost, never run again; the same generation reads its result", async () => {
    const store = memory()
    const first = boxOf({ store })
    const call = { tool: "run", command: "echo ran >> runs.log; cat runs.log" } as const
    const ran = await Effect.runPromise(tool(first.box, call, 1, "across"))
    expect(ran).toMatchObject({ _tag: "Done", result: { stdout: "ran\n" }, generation: 1 })
    expect(store.map.get("run:across")).toEqual({ generation: 1, at: expect.any(Number) })
    // The same generation again answers what the box recorded.
    expect(await Effect.runPromise(tool(first.box, call, 1, "across"))).toEqual(ran)
    // A new machine (a fresh disk with no fence) under the same object: the command is lost, and nothing runs.
    const second = boxOf({ store })
    expect(await Effect.runPromise(tool(second.box, call, 2, "across"))).toEqual({ _tag: "Lost" })
    expect(existsSync(join(second.workdir, "runs.log"))).toBe(false)
    // Reads and writes carry no generation fence: they repeat safely.
    expect(await Effect.runPromise(tool(second.box, { tool: "read", path: "README.md" }, 2, "across-read"))).toMatchObject({
      _tag: "Done",
    })
    expect(store.map.has("run:across-read")).toBe(false)
  })
})

describe("command records", () => {
  test("a new command drops the records older than a day, and keeps the ones a retry may still ask for", async () => {
    const now = Date.now()
    const recent = { generation: 1, at: now - 60_000 }
    const store = memory({
      // A day and a minute old, a bare generation from before records were dated, and a minute old.
      "run:expired": { generation: 1, at: now - Machine.RUN_RECORD_MS - 60_000 },
      "run:undated": 1,
      "run:recent": recent,
      checkpoint: { generation: 1, head: base, seq: 1, pieces: 0, bytes: 0 },
    })
    const machine = boxOf({ store })
    await Effect.runPromise(tool(machine.box, { tool: "run", command: "true" }, 2, "fresh"))
    expect([...store.map.keys()].filter((key) => key.startsWith("run:")).sort()).toEqual(["run:fresh", "run:recent"])
    expect(store.map.get("run:fresh")).toEqual({ generation: 2, at: expect.any(Number) })
    // Other state stays.
    expect(store.map.has("checkpoint")).toBe(true)
    // The kept record still makes its command lost on a later generation, and a read records nothing.
    expect(await Effect.runPromise(tool(machine.box, { tool: "run", command: "true" }, 2, "recent"))).toEqual({ _tag: "Lost" })
    expect(store.map.get("run:recent")).toEqual(recent)
  })

  test("a bare generation from before records were dated still settles its command lost on another generation", async () => {
    const machine = boxOf({ store: memory({ "run:legacy": 1 }) })
    expect(await Effect.runPromise(tool(machine.box, { tool: "run", command: "touch ran" }, 2, "legacy"))).toEqual({
      _tag: "Lost",
    })
    expect(existsSync(join(machine.workdir, "ran"))).toBe(false)
  })
})

describe("save", () => {
  test("skipped until the generation's restore ran, or without a checkout; failed when the machine can't answer", async () => {
    const unrestored = boxOf()
    writeFileSync(join(unrestored.workdir, "new.txt"), "new\n")
    expect(await Effect.runPromise(Machine.save(unrestored.box, 2))).toBe("skipped")
    expect(unrestored.map.has("checkpoint")).toBe(false)

    const empty = boxOf({ workdir: checkout(false), store: memory({ restored: 1 }) })
    const skipped = await observed(Machine.save(empty.box, 1))
    expect(skipped.value).toBe("skipped")
    expect(skipped.counted("save", "skipped")).toBe(1)
    expect(skipped.lines).toMatchObject([{ message: "sandbox.checkpoint.save", level: "WARN", annotations: { outcome: "skipped" } }])

    const failing = boxOf({ store: memory({ restored: 1 }), downFor: [SANDBOX_USER] })
    const failed = await observed(Machine.save(failing.box, 1))
    expect(failed.value).toBe("failed")
    expect(failed.counted("save", "failed")).toBe(1)
    expect(failing.map.has("checkpoint")).toBe(false)
  })

  test("a working copy over the checkpoint limit isn't saved, and the last checkpoint stays", async () => {
    const machine = boxOf({ store: memory({ restored: 1 }) })
    writeFileSync(join(machine.workdir, "small.txt"), "small\n")
    expect(await Effect.runPromise(Machine.save(machine.box, 1))).toBe("saved")
    const before = saved(machine.map)
    writeFileSync(join(machine.workdir, "huge.bin"), new Uint8Array(8 * 1024 * 1024 + 1).fill(7))
    const large = await observed(Machine.save(machine.box, 1))
    expect(large.value).toBe("too_large")
    expect(large.counted("save", "too_large")).toBe(1)
    expect(saved(machine.map)).toEqual(before)
  }, 60_000)

  test("splits a large patch into pieces, and drops the pieces a smaller one no longer needs", async () => {
    const machine = boxOf({ store: memory({ restored: 1 }) })
    writeFileSync(join(machine.workdir, "big.txt"), "line of text\n".repeat(Math.ceil((2.5 * Machine.CHUNK_BYTES) / 13)))
    expect(await Effect.runPromise(Machine.save(machine.box, 1))).toBe("saved")
    expect(saved(machine.map)).toMatchObject({ seq: 1, pieces: 3 })
    expect([0, 1, 2].map((index) => (machine.map.get(`checkpoint:1:${index}`) as Uint8Array).byteLength)).toEqual([
      Machine.CHUNK_BYTES,
      Machine.CHUNK_BYTES,
      saved(machine.map).bytes - 2 * Machine.CHUNK_BYTES,
    ])

    rmSync(join(machine.workdir, "big.txt"))
    writeFileSync(join(machine.workdir, "small.txt"), "small\n")
    expect(await Effect.runPromise(Machine.save(machine.box, 1))).toBe("saved")
    expect(saved(machine.map)).toMatchObject({ seq: 2, pieces: 1 })
    expect([...machine.map.keys()].filter((key) => key.startsWith("checkpoint:"))).toEqual(["checkpoint:2:0"])
  })

  test("a save that stops part way leaves the last checkpoint whole, and the next generation restores that one", async () => {
    const first = boxOf({ store: memory({ restored: 1 }) })
    writeFileSync(join(first.workdir, "kept.txt"), "saved before\n")
    expect(await Effect.runPromise(Machine.save(first.box, 1))).toBe("saved")
    const kept = saved(first.map)

    // The object restarts while it writes the next checkpoint's third piece.
    writeFileSync(join(first.workdir, "big.txt"), "line of text\n".repeat(Math.ceil((2.5 * Machine.CHUNK_BYTES) / 13)))
    const stopping: Machine.Box<never> = {
      ...first.box,
      storage: {
        ...first.box.storage,
        put: (key, value) =>
          key === "checkpoint:2:2" ? Effect.die(new Error("object restarted")) : first.box.storage.put(key, value),
      },
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(Machine.save(stopping, 1)))).toBe(true)
    expect(saved(first.map)).toEqual(kept)
    expect(first.map.has("checkpoint:1:0")).toBe(true)

    // A smaller retry must also reclaim the surplus pieces of the interrupted save.
    rmSync(join(first.workdir, "big.txt"))
    expect(await Effect.runPromise(Machine.save(first.box, 1))).toBe("saved")
    expect([...first.map.keys()].filter((key) => key.startsWith("checkpoint:"))).toEqual(["checkpoint:3:0"])
    const second = boxOf({ store: first.store })
    expect(await Effect.runPromise(Machine.restore(second.box, 2))).toBe("restored")
    expect(readFileSync(join(second.workdir, "kept.txt"), "utf8")).toBe("saved before\n")
    expect(existsSync(join(second.workdir, "big.txt"))).toBe(false)
  })
})

describe("restore", () => {
  test("puts an earlier generation's checkpoint back on the next generation's fresh clone, once", async () => {
    const first = boxOf()
    expect(await Effect.runPromise(Machine.restore(first.box, 1))).toBe("none")
    await Effect.runPromise(tool(first.box, { tool: "write", path: "notes/todo.txt", content: "kept\n" }))
    await Effect.runPromise(tool(first.box, { tool: "run", command: "printf 'changed\\n' > README.md" }))

    // The branch moved on since; the machine restarts from a fresh clone of it, its storage kept.
    writeFileSync(join(origin, "later.txt"), "later\n")
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "later")
    const second = boxOf({ store: first.store })
    const restored = await observed(Machine.restore(second.box, 2))

    expect(restored.value).toBe("restored")
    expect(restored.counted("restore", "restored")).toBe(1)
    expect(restored.lines).toMatchObject([{ message: "sandbox.checkpoint.restore", level: "INFO", annotations: { outcome: "restored" } }])
    expect(git(second.workdir, "rev-parse", "HEAD")).toBe(base)
    expect(readFileSync(join(second.workdir, "notes/todo.txt"), "utf8")).toBe("kept\n")
    expect(readFileSync(join(second.workdir, "README.md"), "utf8")).toBe("changed\n")
    expect(second.sessions).toEqual([SANDBOX_USER])

    // Once per generation: the next wake of the same generation changes nothing.
    writeFileSync(join(second.workdir, "README.md"), "edited since\n")
    expect(await Effect.runPromise(Machine.restore(second.box, 2))).toBe("done")
    expect(readFileSync(join(second.workdir, "README.md"), "utf8")).toBe("edited since\n")
  })

  test("its own generation's checkpoint is nothing to restore; one that can't go back is kept aside, never lost", async () => {
    const same = boxOf({ store: memory({ checkpoint: { generation: 3, head: base, seq: 1, pieces: 0, bytes: 0 } }) })
    expect(await Effect.runPromise(Machine.restore(same.box, 3))).toBe("none")
    expect(same.map.get("restored")).toBe(3)
    expect(same.sessions).toEqual([])

    const gone = { generation: 1, head: "0".repeat(40), seq: 4, pieces: 1, bytes: 3 }
    const missing = boxOf({ store: memory({ checkpoint: gone, "checkpoint:4:0": new Uint8Array([1, 2, 3]) }) })
    const notFound = await observed(Machine.restore(missing.box, 2))
    expect(notFound.value).toBe("not_found")
    expect(notFound.counted("restore", "not_found")).toBe(1)
    expect(notFound.lines).toMatchObject([{ level: "WARN", annotations: { outcome: "not_found" } }])
    expect(missing.map.get("restored")).toBe(2)
    // Kept aside, pieces and all: the next save takes a sequence after it, so it can't overwrite or delete them.
    expect(missing.map.get("stranded:4")).toEqual(gone)
    expect(missing.map.has("checkpoint")).toBe(false)
    writeFileSync(join(missing.workdir, "since.txt"), "since\n")
    expect(await Effect.runPromise(Machine.save(missing.box, 2))).toBe("saved")
    expect(saved(missing.map)).toMatchObject({ generation: 2, seq: 5 })
    expect(missing.map.get("checkpoint:4:0")).toEqual(new Uint8Array([1, 2, 3]))
    expect(missing.map.get("stranded:4")).toEqual(gone)

    // A record whose piece was lost: the patch is all zeros, and git refuses it.
    const lost = { generation: 1, head: base, seq: 1, pieces: 1, bytes: 64 }
    const broken = boxOf({ store: memory({ checkpoint: lost }) })
    expect(await Effect.runPromise(Machine.restore(broken.box, 2))).toBe("failed")
    expect(broken.map.get("restored")).toBe(2)
    expect(broken.map.get("stranded:1")).toEqual(lost)
    expect(git(broken.workdir, "status", "--porcelain")).toBe("")
  })

  test("a machine that doesn't answer fails the restore and records nothing, so a save can't replace the checkpoint", async () => {
    const first = boxOf({ store: memory({ restored: 1 }) })
    writeFileSync(join(first.workdir, "kept.txt"), "kept\n")
    expect(await Effect.runPromise(Machine.save(first.box, 1))).toBe("saved")
    const kept = saved(first.map)

    const down = boxOf({ store: first.store, downFor: [SANDBOX_USER] })
    const failed = await observed(Effect.flip(Machine.restore(down.box, 2)))
    expect(failed.value).toMatchObject({ _tag: "@smthrs/sandbox/SandboxTools/ToolUnavailable", code: "unavailable" })
    expect(failed.counted("restore", "unavailable")).toBe(1)
    expect(down.map.get("restored")).toBe(1)
    // Not restored yet: the save is skipped, and the checkpoint stays for the next wake.
    expect(await Effect.runPromise(Machine.save(down.box, 2))).toBe("skipped")
    expect(saved(down.map)).toEqual(kept)

    const second = boxOf({ store: first.store })
    expect(await Effect.runPromise(Machine.restore(second.box, 2))).toBe("restored")
    expect(readFileSync(join(second.workdir, "kept.txt"), "utf8")).toBe("kept\n")
  })

  test("a commit made in the machine, which the branch doesn't have, comes back on the next generation", async () => {
    const first = boxOf({ store: memory({ restored: 1 }) })
    writeFileSync(join(first.workdir, "local.txt"), "committed here\n")
    git(first.workdir, "add", "local.txt")
    git(first.workdir, "commit", "-q", "-m", "local")
    writeFileSync(join(first.workdir, "after.txt"), "after\n")
    expect(await Effect.runPromise(Machine.save(first.box, 1))).toBe("saved")
    expect(saved(first.map).bundleBytes).toBeGreaterThan(0)

    const second = boxOf({ store: first.store })
    expect(await Effect.runPromise(Machine.restore(second.box, 2))).toBe("restored")
    expect(git(second.workdir, "log", "-1", "--format=%s")).toBe("local")
    expect(readFileSync(join(second.workdir, "local.txt"), "utf8")).toBe("committed here\n")
    expect(readFileSync(join(second.workdir, "after.txt"), "utf8")).toBe("after\n")
  })
})

describe("sleepIfIdle", () => {
  const PROBE_SECONDS = "90"
  const isProbe = (argv: ReadonlyArray<string>) => argv[3] === "probe"

  test.each([
    [3, "terminal_input"], [4, "process"], [1, "probe_failed"],
  ])("records why probe exit %s keeps a machine awake without content", async (exitCode, reason) => {
    const machine = boxOf({ store: memory({ generation: 3 }), root: () => Effect.succeed(exitCode) })
    const result = await observed(Machine.sleepIfIdle(machine.box, 3, 1_000))
    expect(result.value).toBe("busy")
    expect(result.lines.find((line) => line.message === "sandbox.object.sleep")?.annotations).toMatchObject({
      generation: 3, idleMs: 1_000, outcome: "busy", reason, exitCode, phase: "before_save",
    })
    expect(machine.state.destroyed).toBe(0)
    expect(result.decisions("busy", reason)).toBe(1)
    expect(JSON.stringify(result.lines)).not.toContain(machine.workdir)
  })

  test("a generation that isn't running any more is gone, and nothing is asked of it", async () => {
    const other = boxOf({ store: memory({ generation: 4 }) })
    expect(await Effect.runPromise(Machine.sleepIfIdle(other.box, 3, 1_000))).toBe("gone")
    const stopped = boxOf({ store: memory({ generation: 3 }) })
    stopped.state.running = false
    expect(await Effect.runPromise(Machine.sleepIfIdle(stopped.box, 3, 1_000))).toBe("gone")
    expect([...other.runs, ...stopped.runs]).toEqual([])
  })

  test("busy while used within the idle time, while the probe finds work, or when its checkpoint can't be saved", async () => {
    const recent = boxOf({ store: memory({ generation: 3 }) })
    await Effect.runPromise(Machine.touch(recent.box))
    expect(await Effect.runPromise(Machine.sleepIfIdle(recent.box, 3, 60_000))).toBe("busy")
    expect(recent.runs).toEqual([])

    const working = boxOf({ store: memory({ generation: 3 }), root: (argv) => Effect.succeed(isProbe(argv) ? 3 : 0) })
    expect(await Effect.runPromise(Machine.sleepIfIdle(working.box, 3, 89_001))).toBe("busy")
    expect(working.runs).toHaveLength(1)
    expect(working.runs[0]!.user).toBe("root")
    expect(working.runs[0]!.argv.slice(0, 2)).toEqual(["sh", "-c"])
    expect(working.runs[0]!.argv.slice(3)).toEqual(["probe", PROBE_SECONDS])
    expect(working.state.destroyed).toBe(0)

    const unsaved = boxOf({ store: memory({ generation: 3, restored: 3 }), downFor: [SANDBOX_USER] })
    expect(await Effect.runPromise(Machine.sleepIfIdle(unsaved.box, 3, 1_000))).toBe("busy")
    expect(unsaved.state.destroyed).toBe(0)
  })

  test("idle, it saves the working copy and stops the machine; a generation not restored yet stops without saving", async () => {
    const idle = boxOf({ store: memory({ generation: 3, restored: 3 }) })
    writeFileSync(join(idle.workdir, "unsaved.txt"), "typed in a terminal\n")
    expect(await Effect.runPromise(Machine.sleepIfIdle(idle.box, 3, 1_000))).toBe("slept")
    expect(idle.state).toEqual({ running: false, destroyed: 1 })
    expect(saved(idle.map)).toMatchObject({ generation: 3, head: git(idle.workdir, "rev-parse", "HEAD"), pieces: 1 })

    const fresh = boxOf({ store: memory({ generation: 3 }) })
    expect(await Effect.runPromise(Machine.sleepIfIdle(fresh.box, 3, 1_000))).toBe("slept")
    expect(fresh.state.destroyed).toBe(1)
    expect(fresh.map.has("checkpoint")).toBe(false)
  })

  test("a save a closed terminal left due runs at the next ask, busy or not, and only once", async () => {
    const machine = boxOf({ store: memory({ generation: 3, restored: 3 }) })
    writeFileSync(join(machine.workdir, "typed.txt"), "typed in a terminal\n")
    await Effect.runPromise(Machine.saveLater(machine.box))
    expect(machine.map.get("saveDue")).toBe(true)
    expect(machine.map.has("checkpoint")).toBe(false)
    // Used just now, so the machine stays awake; the save runs anyway, in the ask.
    expect(await Effect.runPromise(Machine.sleepIfIdle(machine.box, 3, 60_000))).toBe("busy")
    expect(saved(machine.map)).toMatchObject({ generation: 3, seq: 1 })
    expect(machine.map.has("saveDue")).toBe(false)
    // Nothing due: the next ask saves nothing.
    expect(await Effect.runPromise(Machine.sleepIfIdle(machine.box, 3, 60_000))).toBe("busy")
    expect(saved(machine.map)).toMatchObject({ seq: 1 })
    expect(machine.state).toEqual({ running: true, destroyed: 0 })
  })

  test("a call that comes while it saves keeps the machine awake", async () => {
    const machine = boxOf({ store: memory({ generation: 3, restored: 3, activeAt: 1 }) })
    // The call is admitted (and touches the machine) while the checkpoint is being written.
    const racing: Machine.Box<never> = {
      ...machine.box,
      storage: {
        ...machine.box.storage,
        put: (key, value) =>
          key === "checkpoint"
            ? Effect.andThen(machine.box.storage.put(key, value), Machine.touch(machine.box))
            : machine.box.storage.put(key, value),
      },
    }
    writeFileSync(join(machine.workdir, "typed.txt"), "typed\n")
    expect(await Effect.runPromise(Machine.sleepIfIdle(racing, 3, 1_000))).toBe("busy")
    expect(machine.state).toEqual({ running: true, destroyed: 0 })
    expect(saved(machine.map)).toMatchObject({ generation: 3 })
  })

  test("terminal input that comes while it saves keeps the machine awake: it probes again before it stops", async () => {
    let probes = 0
    // The first probe finds nothing; by the second, a person typed into their terminal.
    const typing = boxOf({
      store: memory({ generation: 3, restored: 3 }),
      root: (argv) => Effect.sync(() => (isProbe(argv) && ++probes === 2 ? 3 : 0)),
    })
    expect(await Effect.runPromise(Machine.sleepIfIdle(typing.box, 3, 1_000))).toBe("busy")
    expect(probes).toBe(2)
    expect(typing.state).toEqual({ running: true, destroyed: 0 })
  })
})
