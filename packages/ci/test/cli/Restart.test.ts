/**
 * The program's own environment: what it keeps, what it withholds, and the
 * restart that hands the rest over. Real pipes and real processes.
 */
import { inheritedEnvironmentNames } from "@smthrs/targets/Exec"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { hand, handed, machine, own, type Program, runtime, split, taken, tools } from "../../src/cli/Restart.ts"

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
