/**
 * `smthrs` started with the shared cache's token to run targets starts again where they see no other process.
 * Real bubblewrap and real processes; the decisions are asked with the facts of other machines.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
  apartArguments,
  commandOf,
  divide,
  findProgram,
  pipeName,
  plan,
  receive,
  startVariables,
  targetCommands,
  tokenName
} from "../bin/apart.mjs"

const made: Array<string> = []
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const start = fileURLToPath(new URL("fixtures/apart-start.mjs", import.meta.url))
const searchPath = process.env["PATH"] as string
const bwrap = findProgram("bwrap", searchPath)
const linux = process.platform === "linux"

/** Whether this machine holds a program in a process table of its own. */
const holds = linux && bwrap !== undefined &&
  spawnSync(bwrap, [...apartArguments(process.getuid?.() ?? 0), "true"], { stdio: "ignore" }).status === 0

/** A token no other process on this machine holds. */
const canary = `smthrs-canary-${randomUUID()}`

/** What the program says of the token it read, in place of the token. */
const digest = createHash("sha256").update(canary).digest("hex")

interface Seen {
  readonly processes: number
  readonly startedWith: boolean
  readonly tokenDigest: string
  readonly held: boolean
  readonly afterRemoval: string | null
  readonly names: ReadonlyArray<string>
  readonly otherIsSet: boolean
  readonly inheritsToken: boolean
  readonly inheritsOther: boolean
  readonly noNewPrivileges: boolean
}

/** Starts the program as a person with a token and another variable starts it. */
const started = (args: ReadonlyArray<string>, more: Readonly<Record<string, string>> = {}) =>
  spawnSync(process.execPath, [start, ...args], {
    encoding: "utf8",
    env: { PATH: searchPath, HOME: process.env["HOME"], [tokenName]: canary, OTHER: canary, ...more }
  })

describe("the command a start names", () => {
  it("is its first argument that is no flag", () => {
    expect(commandOf(["ci", "//..."])).toBe("ci")
    expect(commandOf(["--ui", "plain"])).toBe("plain")
    expect(commandOf(["--help"])).toBeUndefined()
    expect([...targetCommands].sort()).toEqual(["build", "ci", "docs", "lint", "review", "run", "test"])
  })
})

describe("a program on a search path", () => {
  it("is the first one of its name that can be run", () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-apart-"))
    made.push(directory)
    writeFileSync(join(directory, "not-a-program"), "")
    expect(findProgram("sh", `:${directory}:${searchPath}`)).toBe(findProgram("sh", searchPath))
    expect(dirname(findProgram("sh", searchPath) as string)).toMatch(/bin$/)
    expect(findProgram("not-a-program", directory)).toBeUndefined()
    expect(findProgram("sh", undefined)).toBeUndefined()
  })
})

describe("what bubblewrap is told", () => {
  it("keeps every file, gives a process table of its own, and hides the session's bus where there is one", () => {
    expect(apartArguments(1000, () => false)).toEqual([
      "--dev-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--"
    ])
    expect(apartArguments(1000, () => true).slice(6, -2)).toEqual([
      "--ro-bind",
      "/dev/null",
      "/run/user/1000/bus",
      "--tmpfs",
      "/run/user/1000/systemd"
    ])
  })
})

describe("whether a start starts again", () => {
  const facts = { args: ["ci", "//..."], env: { PATH: searchPath, [tokenName]: canary }, platform: "linux", uid: 1000 }
  const never = () => false

  it("does not without a token, for a command that runs no target, or as the second start", () => {
    expect(plan({ ...facts, env: { PATH: searchPath } }, never)).toEqual({ apart: false, why: "no token" })
    expect(plan({ ...facts, env: { ...facts.env, [tokenName]: "" } }, never)).toEqual({ apart: false, why: "no token" })
    // A token handed over through a pipe is answered by name and is in no process to read: nothing to start again for.
    const answered = new Proxy<Record<string, string | undefined>>({ PATH: searchPath }, {
      get: (variables, key) => (key === tokenName ? canary : Reflect.get(variables, key))
    })
    expect(answered[tokenName]).toBe(canary)
    expect(plan({ ...facts, env: answered }, never)).toEqual({ apart: false, why: "no token" })
    expect(plan({ ...facts, args: ["cache", "status"] }, never)).toEqual({
      apart: false,
      why: "the command runs no target"
    })
    expect(plan({ ...facts, env: { ...facts.env, [pipeName]: "3" } }, never)).toEqual({
      apart: false,
      why: "this is the second start"
    })
  })

  it("does not where the machine cannot hold it, and says why", () => {
    expect(plan({ ...facts, platform: "darwin" }, never)).toEqual({
      apart: false,
      why: "only Linux gives a process table of its own"
    })
    expect(plan({ ...facts, uid: 0 }, never)).toEqual({ apart: false, why: "root reads every process" })
    expect(plan({ ...facts, env: { [tokenName]: canary, PATH: "/nowhere" } }, never)).toEqual({
      apart: false,
      why: "bwrap is not on PATH"
    })
  })

  it.skipIf(bwrap === undefined)("does not where bubblewrap is there and does not start", () => {
    expect(plan(facts, never)).toEqual({ apart: false, why: "bubblewrap does not start here" })
  })

  it.skipIf(!holds)("does on a machine whose bubblewrap starts, asked of the machine itself", () => {
    const decided = plan({ ...facts, uid: process.getuid?.() })
    expect(decided).toEqual({ apart: true, bwrap, wrap: apartArguments(process.getuid?.() ?? 0) })
  })
})

describe("the variables of a second start", () => {
  it("are the short list at its start, and every other one at the pipe", () => {
    const { started: atStart, piped } = divide({
      PATH: "/bin",
      NODE_OPTIONS: "--no-warnings",
      NODE_AUTH_TOKEN: "a token",
      [tokenName]: "the token",
      GONE: undefined
    })
    expect(atStart).toEqual({ PATH: "/bin", NODE_OPTIONS: "--no-warnings" })
    expect(piped).toEqual({ NODE_AUTH_TOKEN: "a token", [tokenName]: "the token" })
    expect([...startVariables].some((name) => /TOKEN|KEY|SECRET|PASSWORD/.test(name))).toBe(false)
  })

  it("are taken from the pipe once: set as they were, but for the token, which is answered by name", () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-apart-"))
    made.push(directory)
    const file = join(directory, "variables")
    writeFileSync(file, JSON.stringify({ OTHER: "kept", [tokenName]: "the token" }))
    const descriptor = openSync(file, "r")
    const program: { env: Record<string, string | undefined> } = {
      env: { PATH: "/bin", [pipeName]: String(descriptor) }
    }
    try {
      receive(program)
    } finally {
      closeSync(descriptor)
    }
    expect(program.env[tokenName]).toBe("the token")
    expect(tokenName in program.env).toBe(true)
    // What a started program inherits: every variable but the token.
    expect({ ...program.env }).toEqual({ PATH: "/bin", OTHER: "kept" })
    program.env["LATER"] = "set"
    expect(program.env["LATER"]).toBe("set")
    delete program.env[tokenName]
    expect(program.env[tokenName]).toBeUndefined()
    expect(tokenName in program.env).toBe(false)
  })

  it("are left as they are in a start that is no second one, and a pipe with no token answers none", () => {
    const first = { env: { PATH: "/bin" } }
    receive(first)
    expect(first.env).toEqual({ PATH: "/bin" })
    const second: { env: Record<string, string | undefined> } = { env: { [pipeName]: "9" } }
    receive(second, () => JSON.stringify({ OTHER: "kept" }))
    expect(second.env[tokenName]).toBeUndefined()
    expect({ ...second.env }).toEqual({ OTHER: "kept" })
  })
})

describe.skipIf(!holds)("smthrs started with the token to run targets", () => {
  it("starts again where no process holds the token, and still reads it by name", () => {
    const ran = started(["ci"])
    expect(ran.status, ran.stderr).toBe(0)
    const seen = JSON.parse(ran.stdout) as Seen
    // bubblewrap, the program and what it started: nothing of the machine's.
    expect(seen.processes).toBeLessThan(6)
    expect(seen.startedWith).toBe(false)
    expect([seen.tokenDigest, seen.held, seen.afterRemoval]).toEqual([digest, true, null])
    // Every other variable is there as it was, and a program it starts inherits it, never the token.
    expect(seen.otherIsSet).toBe(true)
    expect(seen.names).not.toContain(tokenName)
    expect(seen.names).not.toContain(pipeName)
    expect([seen.inheritsOther, seen.inheritsToken]).toEqual([true, false])
    // No program it starts gains a privilege: sudo gains none.
    expect(seen.noNewPrivileges).toBe(true)
  })

  it("ends as the second start ends", () => {
    expect(started(["ci", "--exit-7"]).status).toBe(7)
  })

  it("passes on a signal, and ends as a program that a signal ended", async () => {
    const child = spawn(process.execPath, [start, "ci", "--wait"], {
      env: { PATH: searchPath, [tokenName]: canary },
      stdio: ["ignore", "pipe", "inherit"]
    })
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
    child.kill("SIGTERM")
    const code = await new Promise<number | null>((resolve) => child.once("exit", (status) => resolve(status)))
    expect(code).toBe(143)
  })
})

describe.skipIf(!linux)("smthrs started with the token for a command that runs no target", () => {
  it("runs as it was started", () => {
    const ran = started(["cache"])
    expect(ran.status, ran.stderr).toBe(0)
    const seen = JSON.parse(ran.stdout) as Seen
    expect(seen.processes).toBeGreaterThan(5)
    expect([seen.tokenDigest, seen.startedWith, seen.noNewPrivileges]).toEqual([digest, true, false])
  })
})
