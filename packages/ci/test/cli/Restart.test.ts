/**
 * The program's own environment: what it keeps, what it withholds, and the
 * restart that hands the rest over. Real pipes and real processes.
 */
import { inheritedEnvironmentNames } from "@smthrs/targets/Exec"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  hand,
  handed,
  machine,
  notHandedOver,
  notHidden,
  own,
  type Program,
  received,
  runtime,
  split,
  taken,
  tools
} from "../../src/cli/Restart.ts"

const made: Array<string> = []
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "smithers-ci-restart-"))
  made.push(path)
  return path
}
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

/** Values a shell or a parser could mangle. */
const awkward = {
  GITHUB_TOKEN: "ghp $x `y` \\ \"q\" 'z'\n second line\n",
  NPM_TOKEN: "n".repeat(100_000),
  "npm_config_//registry.example/:_authToken": "ü-✓"
}

/** A program that says, as JSON, what `own` gave it and what its process holds afterwards. */
const second = fileURLToPath(new URL("restarted.mjs", import.meta.url))

/** Starts what `execve` would become, as a child, and keeps what it printed. */
const starting = () => {
  const starts: Array<{ file: string; args: ReadonlyArray<string>; env: Record<string, string>; said: string }> = []
  const execve = (file: string, args: ReadonlyArray<string>, env: Record<string, string>): void => {
    const child = spawnSync(file, args.slice(1), { env, encoding: "utf8" })
    starts.push({ file, args, env, said: child.stdout })
  }
  return { starts, execve }
}

const programWith = (env: Record<string, string | undefined>, rest: Partial<Program> = {}): Program => ({
  env,
  platform: process.platform,
  execPath: process.execPath,
  execArgv: ["--no-warnings"],
  argv: [process.execPath, second, "replay", "two words"],
  ...rest
})

describe("the variables the program keeps", () => {
  it("are what a step gets of the machine and what the runtime and the terminal read", () => {
    expect([...machine].sort()).toEqual([...inheritedEnvironmentNames].sort())
    expect(runtime).toContain("NODE_OPTIONS")
    // Where compiled code is kept: a new start, and the Zig builds it starts, find it where the person put it.
    const kept = { NODE_COMPILE_CACHE: "/c/node", VIBELANG_CACHE_DIR: "/c/vibelang", ZIG_GLOBAL_CACHE_DIR: "/c/zig" }
    expect(split(kept, "linux")).toEqual({ short: kept, withheld: {} })
    const { short, withheld } = split({
      PATH: "/bin",
      HOME: "/home/me",
      TERM: "xterm",
      GITHUB_TOKEN: "t",
      SSH_AUTH_SOCK: "/tmp/agent",
      UNSET: undefined
    }, "linux")
    expect(short).toEqual({ PATH: "/bin", HOME: "/home/me", TERM: "xterm" })
    expect(withheld).toEqual({ GITHUB_TOKEN: "t", SSH_AUTH_SOCK: "/tmp/agent" })
  })

  it("are found whatever their case on Windows, and only there", () => {
    expect(split({ Path: "C:\\bin", Token: "t" }, "win32")).toEqual({
      short: { Path: "C:\\bin" },
      withheld: { Token: "t" }
    })
    expect(split({ Path: "/bin" }, "linux")).toEqual({ short: {}, withheld: { Path: "/bin" } })
  })
})

describe("handing variables to the next start", () => {
  it("gives them back whole, once, and leaves nothing behind", async () => {
    const pipe = await hand(awkward)
    expect(taken(pipe)).toEqual(awkward)
    expect(existsSync(dirname(pipe))).toBe(false)
    expect(taken(pipe)).toEqual({})
  })

  it("gives nothing for a path that is no pipe of its own, and leaves the file alone", () => {
    const file = join(directory(), "file")
    writeFileSync(file, JSON.stringify({ A: "1" }))
    expect(taken(file)).toEqual({})
    expect(readFileSync(file, "utf8")).toBe("{\"A\":\"1\"}")
  })

  it("fails, with nothing left behind, when the pipe or its writer cannot be made", async () => {
    const here = { ...tools(), directory: directory() }
    await expect(hand(awkward, { ...here, mkfifo: "false" })).rejects.toThrow()
    await expect(hand(awkward, { ...here, shell: "/nowhere/sh" })).rejects.toThrow()
    await expect(hand(awkward, { ...here, shell: "false" })).rejects.toThrow()
    expect(readdirSync(here.directory)).toEqual([])
  })
})

/** A pipe at `path`, as `hand` makes one. */
const fifo = (path: string): string => {
  execFileSync("mkfifo", ["-m", "600", path])
  return path
}

/** A directory named as `hand` names one, under `base`, that only this user can enter. */
const handDirectory = (base: string): string => mkdtempSync(join(base, "smithers-ci-environment-"))

describe("a pipe the program did not make", () => {
  it("is neither read nor removed: another name, another directory, a directory others can enter, a link", () => {
    const base = directory()
    const named = fifo(join(handDirectory(base), "queue"))
    const plain = join(base, "plain")
    mkdirSync(plain, { mode: 0o700 })
    const elsewhere = fifo(join(plain, "pipe"))
    const open = handDirectory(base)
    chmodSync(open, 0o755)
    const shared = fifo(join(open, "pipe"))
    // A link to a directory of the right kind is not that directory.
    const real = handDirectory(base)
    fifo(join(real, "pipe"))
    const link = join(base, "smithers-ci-environment-link")
    symlinkSync(real, link)
    for (const pipe of [named, elsewhere, shared, join(link, "pipe")]) {
      expect(received(pipe, 50), pipe).toBeUndefined()
      expect(taken(pipe, 50), pipe).toEqual({})
      expect(existsSync(pipe), pipe).toBe(true)
    }
    // A file where the pipe would be is left as it is, and a path that is not there gives nothing.
    const file = join(handDirectory(base), "pipe")
    writeFileSync(file, JSON.stringify({ A: "1" }))
    expect(received(file)).toBeUndefined()
    expect(readFileSync(file, "utf8")).toBe("{\"A\":\"1\"}")
    expect(received(join(base, "smithers-ci-environment-none", "pipe"))).toBeUndefined()
  })

  it("is given up on when nobody writes to it, and a pipe of its own making is then removed", () => {
    const own = handDirectory(directory())
    const pipe = fifo(join(own, "pipe"))
    const started = Date.now()
    expect(received(pipe, 60)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(existsSync(own)).toBe(false)
  })

  it("waits for a writer that has written nothing yet, and gives nothing for what is not the variables", () => {
    /** A writer that opens the pipe, waits `seconds`, and writes `text`. */
    const writing = (text: string, seconds: string): string => {
      const pipe = fifo(join(handDirectory(directory()), "pipe"))
      spawn("/bin/sh", ["-c", "exec 3>\"$1\"; sleep \"$2\"; printf %s \"$3\" >&3", "sh", pipe, seconds, text], {
        stdio: "ignore"
      })
      return pipe
    }
    expect(received(writing(JSON.stringify({ A: "1", B: "two words" }), "0.4"), 30_000)).toEqual({
      A: "1",
      B: "two words"
    })
    for (const text of ["[\"a\"]", "null", "7", "{\"A\":1}", "{"]) {
      const pipe = writing(text, "0")
      expect(received(pipe, 30_000), text).toBeUndefined()
      expect(existsSync(pipe), text).toBe(false)
    }
  })
})

describe("the variables waiting for a new start", () => {
  it("are let go, with their pipe, when no new start comes to read them", async () => {
    const here = { ...tools(), directory: directory(), seconds: 1 }
    const pipe = await hand(awkward, here)
    expect(existsSync(pipe)).toBe(true)
    await vi.waitFor(() => expect(readdirSync(here.directory)).toEqual([]), { timeout: 30_000, interval: 100 })
  })
})

describe("the program's own environment", () => {
  it("is returned as it is when nothing needs withholding, and the program does not start again", async () => {
    const env = { PATH: "/bin", HOME: "/home/me" }
    const { execve, starts } = starting()
    expect(await own(programWith(env, { execve }))).toEqual(env)
    expect(starts).toEqual([])
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" })
  })

  it("starts the program again with the short environment, and the new start gets the rest from the pipe", async () => {
    const env: Record<string, string | undefined> = { PATH: process.env["PATH"], HOME: "/home/me", ...awkward }
    const whole = { ...env }
    const { execve, starts } = starting()

    expect(await own(programWith(env, { execve }))).toEqual(whole)

    expect(starts).toHaveLength(1)
    const [start] = starts
    expect(start?.file).toBe(process.execPath)
    expect(start?.args).toEqual([process.execPath, "--no-warnings", second, "replay", "two words"])
    // What the new start is started with: the short environment and the path of the pipe. No withheld value.
    expect(Object.keys(start?.env ?? {}).sort()).toEqual(["HOME", "PATH", handed])
    for (const value of Object.values(awkward)) expect(Object.values(start?.env ?? {}).join("\n")).not.toContain(value)
    const said = JSON.parse(start?.said ?? "null") as {
      readonly args: ReadonlyArray<string>
      readonly given: Record<string, string>
      readonly holds: ReadonlyArray<string>
      readonly startedWith: string
    }
    expect(said.args).toEqual(["replay", "two words"])
    // A system may add a variable of its own to every process, as macOS does.
    expect(said.given).toMatchObject(whole)
    expect(said.holds).toEqual(expect.arrayContaining(["HOME", "PATH"]))
    for (const name of [handed, ...Object.keys(awkward)]) expect(said.holds).not.toContain(name)
    for (const value of Object.values(awkward)) expect(said.startedWith).not.toContain(value.slice(0, 40))
    // The pipe is gone, and a process that was not replaced holds the short environment too.
    expect(existsSync(dirname(start?.env[handed] as string))).toBe(false)
    expect(env).toEqual({ PATH: process.env["PATH"], HOME: "/home/me" })
  })

  it("gives the whole environment back to a new start, and forgets the pipe", async () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", [handed]: await hand(awkward) }
    expect(await own(programWith(env))).toEqual({ PATH: "/bin", ...awkward })
    expect(env).toEqual({ PATH: "/bin" })
  })

  it("removes the variables from the process on a runtime that cannot start again", async () => {
    const { execve, starts } = starting()
    for (const rest of [{}, { execve, platform: "win32" }]) {
      const env: Record<string, string | undefined> = { PATH: "/bin", ...awkward }
      expect(await own(programWith(env, rest))).toEqual({ PATH: "/bin", ...awkward })
      expect(env).toEqual({ PATH: "/bin" })
    }
    expect(starts).toEqual([])
  })

  it("removes the variables from the process when the restart fails, and lets the pipe go", async () => {
    const here = { ...tools(), directory: directory() }
    const refused = (): void => {
      throw new Error("E2BIG")
    }
    const env: Record<string, string | undefined> = { PATH: "/bin", ...awkward }
    const send = (withheld: Readonly<Record<string, string>>) => hand(withheld, here)
    expect(await own(programWith(env, { execve: refused }), send)).toEqual({ PATH: "/bin", ...awkward })
    expect(env).toEqual({ PATH: "/bin" })
    expect(readdirSync(here.directory)).toEqual([])

    const noPipe = (): Promise<string> => Promise.reject(new Error("no mkfifo"))
    const again: Record<string, string | undefined> = { PATH: "/bin", ...awkward }
    expect(await own(programWith(again, { execve: refused }), noPipe)).toEqual({ PATH: "/bin", ...awkward })
    expect(again).toEqual({ PATH: "/bin" })
  })
})

describe("the variable that names the pipe", () => {
  it("is not believed in a process that holds a variable to withhold: the program starts again, and the path stays", async () => {
    const foreign = fifo(join(handDirectory(directory()), "pipe"))
    const env: Record<string, string | undefined> = {
      PATH: process.env["PATH"],
      HOME: "/home/me",
      [handed]: foreign,
      ...awkward
    }
    const { execve, starts } = starting()
    const said: Array<string> = []
    expect(await own(programWith(env, { execve }), undefined, (line) => said.push(line))).toEqual({
      PATH: process.env["PATH"],
      HOME: "/home/me",
      ...awkward
    })
    // The new start is given a pipe this start made, never the one the variable named.
    expect(starts).toHaveLength(1)
    expect(starts[0]?.env[handed]).not.toBe(foreign)
    const given = (JSON.parse(starts[0]?.said ?? "null") as { readonly given: Record<string, string> }).given
    expect(given).toMatchObject(awkward)
    expect(existsSync(foreign)).toBe(true)
    expect(env).toEqual({ PATH: process.env["PATH"], HOME: "/home/me" })
    expect(said).toEqual([])
  })

  it("is forgotten, and the program says the variables did not come, when nothing waits where it points", async () => {
    const said: Array<string> = []
    const env: Record<string, string | undefined> = { PATH: "/bin", [handed]: "" }
    expect(await own(programWith(env), undefined, (line) => said.push(line))).toEqual({ PATH: "/bin" })
    expect(env).toEqual({ PATH: "/bin" })
    expect(said).toEqual([notHandedOver])
  })
})

describe("a start that cannot be made again", () => {
  it("says the variables it was started with stay readable, where a machine could have hidden them", async () => {
    const refused = (): void => {
      throw new Error("E2BIG")
    }
    const { execve } = starting()
    const saidBy = async (rest: Partial<Program>): Promise<ReadonlyArray<string>> => {
      const said: Array<string> = []
      const here = { ...tools(), directory: directory() }
      await own(programWith({ PATH: "/bin", ...awkward }, rest), (withheld) => hand(withheld, here), (line) => {
        said.push(line)
      })
      return said
    }
    expect(await saidBy({})).toEqual([notHidden])
    expect(await saidBy({ execve: refused })).toEqual([notHidden])
    // Windows has no such start, and the program says nothing there.
    expect(await saidBy({ execve, platform: "win32" })).toEqual([])
    expect(notHidden).toContain("smithers-ci: ")
    expect(notHandedOver).toContain("smithers-ci: ")
  })
})
