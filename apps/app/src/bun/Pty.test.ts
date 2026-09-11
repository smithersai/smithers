import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { childEnv, createPtyManager, ENV_ALLOWLIST, expandCwd, plainText, PTY_SCROLLBACK_BYTES } from "./Pty"
import type { PtyManager } from "./Pty"

/*
 * Real PTY sessions over Bun.spawn({ terminal }) with the sandbox off (the
 * seatbelt profile itself is Sandbox.test.ts's subject): a plain shell
 * echoes typed text back on its topic, exits are reported once with the
 * code, and kills drop the record.
 */

interface Frame {
  readonly topic: string
  readonly message: { type: string; sessionId: string; data?: string; code?: number | null }
}

const frames: Array<Frame> = []
const managers: Array<PtyManager> = []
let scratch = ""

const manager = (overrides: Partial<Parameters<typeof createPtyManager>[0]> = {}): PtyManager => {
  const created = createPtyManager({
    publish: (topic, message) => frames.push({ topic, message: message as Frame["message"] }),
    harnesses: async () => [],
    shell: "/bin/sh",
    // A real login shell must never source the developer's personal profile.
    home: scratch,
    env: {},
    sandboxHost: { platform: "linux", disabled: true, log: () => {} },
    killGraceMs: 300,
    log: () => {},
    ...overrides
  })
  managers.push(created)
  return created
}

const outputOf = (sessionId: string): string =>
  frames
    .filter((frame) => frame.topic === `pty:${sessionId}` && frame.message.type === "pty.output")
    .map((frame) => frame.message.data ?? "")
    .join("")

const exitOf = (sessionId: string): Frame | undefined =>
  frames.find((frame) => frame.topic === `pty:${sessionId}` && frame.message.type === "pty.exit")

const until = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "smithers-pty-"))
})

afterAll(async () => {
  await Promise.all(managers.map((m) => m.dispose()))
  if (scratch !== "") await rm(scratch, { recursive: true, force: true })
})

describe("expandCwd", () => {
  test("~ and ~/x expand against home; absolute paths resolve as-is", () => {
    expect(expandCwd("~", "/Users/u")).toBe("/Users/u")
    expect(expandCwd("", "/Users/u")).toBe("/Users/u")
    expect(expandCwd("~/work/a", "/Users/u")).toBe("/Users/u/work/a")
    expect(expandCwd("/tmp/../var", "/Users/u")).toBe("/var")
  })
})

describe("childEnv", () => {
  test("keeps the allowlist, sets TERM/COLORTERM/LANG, and builds PATH from the candidate dirs", () => {
    const env = childEnv(
      { HOME: "/other", USER: "u", PATH: "/usr/bin:/bin", SECRET_TOKEN: "x", LANG: "fr_FR.UTF-8", OPENAI_API_KEY: "sk" },
      "/Users/u",
      ["/opt/node/bin"]
    )
    expect(env.HOME).toBe("/Users/u")
    expect(env.USER).toBe("u")
    expect(env.TERM).toBe("xterm-256color")
    expect(env.COLORTERM).toBe("truecolor")
    expect(env.LANG).toBe("fr_FR.UTF-8")
    expect(env.OPENAI_API_KEY).toBe("sk")
    expect(env).not.toHaveProperty("SECRET_TOKEN")
    expect(env.PATH?.startsWith("/opt/node/bin:")).toBe(true)
    expect(env.PATH?.split(":")).toContain("/usr/bin")
    expect(env.PATH?.split(":")).toContain("/bin")
    expect(ENV_ALLOWLIST).toContain("SSH_AUTH_SOCK")
    expect(childEnv({}, "/Users/u", []).LANG).toBe("en_US.UTF-8")
  })
})

describe("sessions", () => {
  test("a terminal session echoes typed text on its topic, is listed alive, and exits with its code", async () => {
    const m = manager({ home: scratch })
    const created = await m.create({ kind: "terminal", cwd: "~", cols: 80, rows: 24 })
    if (created.status !== "ok") throw new Error(created.message)
    const { sessionId } = created.session
    expect(sessionId).toMatch(/^pty-[0-9a-f]{32}$/)
    expect(created.session).toMatchObject({ kind: "terminal", cwd: scratch, alive: true })
    expect(created.session.pid).toBeGreaterThan(0)
    expect(m.list().map((session) => session.sessionId)).toEqual([sessionId])

    expect(m.write(sessionId, "echo hi-from-pty\n")).toBe(true)
    await until(() => /hi-from-pty\r?\n/.test(outputOf(sessionId).replace(/echo hi-from-pty/g, "")))
    expect(m.resize(sessionId, 100, 30)).toBe(true)

    expect(m.write(sessionId, "exit 7\n")).toBe(true)
    await until(() => exitOf(sessionId) !== undefined)
    expect(exitOf(sessionId)?.message).toEqual({ type: "pty.exit", sessionId, code: 7 })
    expect(frames.filter((frame) => frame.message.type === "pty.exit" && frame.message.sessionId === sessionId)).toHaveLength(1)
    // Exited sessions stay listed, dead, until deleted; input is refused.
    expect(m.get(sessionId)).toMatchObject({ alive: false, exitCode: 7 })
    expect(m.write(sessionId, "x")).toBe(false)
    expect(m.resize(sessionId, 1, 1)).toBe(false)
    expect(await m.kill(sessionId)).toBe(true)
    expect(m.list()).toEqual([])
    expect(await m.kill(sessionId)).toBe(false)
  })

  test("kill hangs up a live session and drops it; dispose empties the table", async () => {
    const m = manager()
    const a = await m.create({ kind: "terminal", cwd: tmpdir(), cols: 80, rows: 24 })
    const b = await m.create({ kind: "terminal", cwd: tmpdir(), cols: 80, rows: 24 })
    if (a.status !== "ok" || b.status !== "ok") throw new Error("spawn failed")
    expect(m.list()).toHaveLength(2)
    expect(await m.kill(a.session.sessionId)).toBe(true)
    await until(() => exitOf(a.session.sessionId) !== undefined)
    expect(m.list().map((session) => session.sessionId)).toEqual([b.session.sessionId])
    await m.dispose()
    expect(m.list()).toEqual([])
  })

  test("a bad cwd, an unknown harness, and an unavailable harness are refused before spawning", async () => {
    const gemini: Harness = {
      id: "gemini",
      displayName: "Gemini",
      binary: null,
      version: null,
      status: "unavailable",
      account: null,
      launch: { argv: ["gemini"] }
    }
    const m = manager({ harnesses: async () => [gemini] })
    expect(await m.create({ kind: "terminal", cwd: "/definitely/not/here", cols: 80, rows: 24 })).toMatchObject({ status: "error", code: "bad_cwd" })
    expect(await m.create({ kind: "harness", cwd: "~", cols: 80, rows: 24, harnessId: "claude" })).toMatchObject({ status: "error", code: "unknown_harness" })
    expect(await m.create({ kind: "harness", cwd: "~", cols: 80, rows: 24, harnessId: "gemini" })).toMatchObject({ status: "error", code: "harness_unavailable" })
    expect(m.list()).toEqual([])
  })

  test("a harness session runs the resolved binary with the launch argv", async () => {
    const fake: Harness = {
      id: "pi",
      displayName: "Pi",
      binary: "/bin/sh",
      version: "0",
      status: "binary-only",
      account: null,
      launch: { argv: ["pi", "-c", "echo harness-ok; exit 3"] }
    }
    const m = manager({ harnesses: async () => [fake] })
    const created = await m.create({ kind: "harness", cwd: tmpdir(), cols: 80, rows: 24, harnessId: "pi" })
    if (created.status !== "ok") throw new Error(created.message)
    expect(created.session).toMatchObject({ kind: "harness", harnessId: "pi" })
    await until(() => exitOf(created.session.sessionId) !== undefined)
    expect(outputOf(created.session.sessionId)).toContain("harness-ok")
    expect(exitOf(created.session.sessionId)?.message.code).toBe(3)
  })

  test("a role session launches the role's harness with the role's argv and the task as its first prompt", async () => {
    // The "implementation" role runs codex `-m gpt-5.6-sol <task>`; the harness table only supplies the binary.
    const codex: Harness = {
      id: "codex",
      displayName: "Codex",
      binary: "/bin/echo",
      version: "0",
      status: "signed-in",
      account: { email: "will@example.com" },
      launch: { argv: ["codex"] }
    }
    const m = manager({ harnesses: async () => [codex] })
    const created = await m.create({ kind: "harness", cwd: tmpdir(), cols: 80, rows: 24, roleId: "implementation", task: "add a retry" })
    if (created.status !== "ok") throw new Error(created.message)
    expect(created.session).toMatchObject({ kind: "harness", harnessId: "codex" })
    await until(() => exitOf(created.session.sessionId) !== undefined)
    expect(outputOf(created.session.sessionId)).toContain("-m gpt-5.6-sol add a retry")
    // A role whose harness is not installed is refused like any other harness.
    const refused = await m.create({ kind: "harness", cwd: "~", cols: 80, rows: 24, roleId: "explainer" })
    expect(refused).toMatchObject({ status: "error", code: "unknown_harness" })
  })

  test("a custom role id resolves against the agents store and launches with its own composed argv; an unknown id is refused", async () => {
    const codex: Harness = {
      id: "codex",
      displayName: "Codex",
      binary: "/bin/echo",
      version: "0",
      status: "signed-in",
      account: { email: "will@example.com" },
      launch: { argv: ["codex"] }
    }
    const reviewer: AgentRole = {
      id: "reviewer",
      label: "Reviewer",
      purpose: "Reviews diffs.",
      model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      harness: "codex",
      delegates: false,
      builtin: false,
      createdAt: 1,
      updatedAt: 1
    }
    const m = manager({ harnesses: async () => [codex], roles: async () => [...AGENT_ROLES, reviewer] })
    const created = await m.create({ kind: "harness", cwd: tmpdir(), cols: 80, rows: 24, roleId: "reviewer", task: "review it" })
    if (created.status !== "ok") throw new Error(created.message)
    expect(created.session).toMatchObject({ kind: "harness", harnessId: "codex" })
    await until(() => exitOf(created.session.sessionId) !== undefined)
    expect(outputOf(created.session.sessionId)).toContain("-m gpt-5.6-terra review it")
    // The store is the truth: an id it lacks is not a role, however well-formed.
    expect(await m.create({ kind: "harness", cwd: "~", cols: 80, rows: 24, roleId: "poet" })).toMatchObject({ status: "error", code: "unknown_role" })
    // Without a store the built-ins alone resolve.
    const builtinOnly = manager({ harnesses: async () => [codex] })
    expect(await builtinOnly.create({ kind: "harness", cwd: "~", cols: 80, rows: 24, roleId: "reviewer" })).toMatchObject({ status: "error", code: "unknown_role" })
  })

  test("read serves the scrollback as plain text: escapes stripped, bounded, tail-cut on request", async () => {
    const created = manager()
    const result = await created.create({ kind: "terminal", cwd: "~", cols: 80, rows: 24 })
    if (result.status !== "ok") throw new Error(result.message)
    const { sessionId } = result.session
    created.write(sessionId, "printf 'a\\033[31mred\\033[0m b\\n'; echo hi-from-read\n")
    await until(() => /hi-from-read\r?\n/.test(outputOf(sessionId).replace(/echo hi-from-read/g, "")))
    const whole = created.read(sessionId)
    expect(whole?.alive).toBe(true)
    expect(whole?.output).toContain("hi-from-read")
    expect(whole?.output).toContain("ared b")
    expect(whole?.output).not.toMatch(/\u001b|\r/)
    const cut = created.read(sessionId, 8)
    expect(cut?.output.length).toBe(8)
    expect(cut?.truncated).toBe(true)
    expect(created.read("nope")).toBeUndefined()
    await created.kill(sessionId)
  })

  test("plainText drops CSI, OSC, and C0 controls but keeps tabs and newlines; the scrollback bound is 64 KiB", () => {
    expect(plainText("\u001b[1;32mok\u001b[0m\r\n\u001b]0;title\u0007x\ty\u0008")).toBe("ok\nx\ty")
    expect(PTY_SCROLLBACK_BYTES).toBe(64 * 1024)
  })
})
