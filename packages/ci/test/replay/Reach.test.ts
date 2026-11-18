/**
 * What a command in the jail reaches of the machine beyond its files: the
 * keys the kernel holds for the person's session, the processes outside the
 * jail, and the descriptors of the program that started it. And how the
 * shared cache's token reaches Smithers build. Real bubblewrap, real
 * processes, a real kernel keyring.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { smthrsWithToken } from "../../src/cli/Install.ts"
import { confine, held, reading } from "../../src/replay/Confine.vibe"
import { stepEnvironment } from "../../src/replay/Environment.ts"
import { keyringFilter, probe } from "../../src/replay/Jail.ts"

const made: Array<string> = []
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const found = probe()
const jailable = !("refusal" in found)

/** The repository these tests run from. */
const repository = fileURLToPath(new URL("../../../../", import.meta.url))

/**
 * Two files in the real home of whoever runs the tests, at paths no list of credentials could name: one in a
 * directory of settings with a name of its own, one directly in the home. Removed when the tests end.
 */
const unlisted = (() => {
  const name = `.smithers-ci-test-${randomUUID()}`
  const directory = join(homedir(), name)
  const inside = join(directory, "token")
  const beside = join(homedir(), `${name}.txt`)
  mkdirSync(directory)
  writeFileSync(inside, "a token of a program nobody heard of\n")
  writeFileSync(beside, "a note with a password in it\n")
  made.push(directory, beside)
  return { inside, beside }
})()

/** Plants a key in the session's keyring, looks for it, or removes it. It prints what it found, never the key. */
const keyring = fileURLToPath(new URL("keyring.py", import.meta.url))
const keys = (what: "plant" | "look" | "drop"): string =>
  spawnSync("python3", [keyring, what], { encoding: "utf8" }).stdout?.trim() ?? ""

/** Whether this machine has the Python the keyring program is written in. */
const python = process.platform === "linux" && spawnSync("python3", ["-c", "import ctypes"]).status === 0

/**
 * Whether the kernel took a key for this session. A machine at its limit of keys takes none; the jail's answer is
 * the same either way.
 */
const planted = python && keys("plant") === "planted"
afterAll(() => void (python && keys("drop")))

/**
 * Runs a command as a step runs, in the real jail of a replay that is set up for it and removed after, or with no
 * jail. The command is started with descriptor 3 open, as a program that was itself started with one would start
 * it.
 */
const asStep = (argv: readonly [string, ...Array<string>], jailed: boolean) => {
  const work = mkdtempSync(join(tmpdir(), "smithers-ci-reach-"))
  made.push(work)
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const asked = jailed ? () => found : () => ({ refusal: "no bubblewrap" })
      // The tests' own files are in the repository the tests run from, which a replay puts back as the checkout.
      const places = yield* confine(work, asked, () => Effect.void, [], false, undefined, repository)
      const [command, ...args] = held(places.normal, [], argv)
      return spawnSync(command, args, {
        env: stepEnvironment({}, places.normal),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"]
      })
    })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<SpawnSyncReturns<string>>
  )
}
const inJail = (argv: readonly [string, ...Array<string>]) => asStep(argv, true)

describe.skipIf(!jailable)("a command in the jail", () => {
  it.skipIf(!python)("is refused the keys the kernel holds for the session that started it", async () => {
    // Outside the jail the kernel answers as one that holds keys: with the key when it took one, else with why it
    // has none for this search. A machine at its limit of keys answers that, too.
    const outside = keys("look")
    if (planted) expect(outside).toBe("session: read")
    expect(outside).not.toBe("session: refused 38")
    const seen = await inJail(["python3", keyring, "look"])
    // 38 is "not implemented": in the jail the kernel answers as one that has no keys at all.
    expect(seen.stdout.trim()).toBe("session: refused 38")
  })

  it("sees no process of the machine, and starts with no descriptor but its three", async () => {
    const outside = spawn("sleep", ["60"], { stdio: "ignore" })
    try {
      const seen = await inJail([
        "sh",
        "-c",
        "test ! -e /proc/$1 && ls /proc | grep -c '^[0-9]' && ls /proc/self/fd | tr '\\n' ' '",
        "sh",
        String(outside.pid)
      ])
      expect(seen.status, seen.stderr).toBe(0)
      const [processes, descriptors] = seen.stdout.trim().split("\n")
      // The jail, the shell and what the shell started: nothing of the machine's.
      expect(Number(processes)).toBeLessThan(6)
      // `ls` holds the directory it lists as 3. The descriptor the command was started with is closed, and so is
      // the filter's, once it is loaded.
      expect(descriptors?.trim()).toBe("0 1 2 3")
    } finally {
      outside.kill()
    }
  })
})

describe.skipIf(!jailable)("the person's home, in the jail", () => {
  it("is empty of everything but the tools: a file no list could name is not there", async () => {
    const seen = await inJail([
      "sh",
      "-c",
      "for file in \"$@\"; do if [ -e \"$file\" ] || cat \"$file\" 2>/dev/null; then echo \"reads $file\"; fi; done; ls -A \"$HOME/..\" > /dev/null",
      "sh",
      unlisted.inside,
      unlisted.beside,
      join(homedir(), ".bash_history"),
      join(homedir(), ".ssh"),
      join(homedir(), ".config")
    ])
    expect(seen.stdout).toBe("")
    // Outside the jail both are there.
    expect(spawnSync("cat", [unlisted.inside, unlisted.beside], { encoding: "utf8" }).stdout).toBe(
      "a token of a program nobody heard of\na note with a password in it\n"
    )
  })

  /** The tools of this machine's search path that are installed under the home, each with how it says its version. */
  const tools = ([
    ["node", ["--version"]],
    ["bun", ["--version"]],
    ["pnpm", ["--version"]],
    ["zig", ["version"]],
    ["go", ["version"]],
    ["cargo", ["--version"]],
    ["uv", ["--version"]]
  ] as const).filter(([tool]) => {
    const where = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
    return where.startsWith(`${homedir()}/`)
  })

  it.each(tools)("still runs %s, which is installed under the home", async (tool, version) => {
    const seen = await inJail([tool, ...version])
    expect(seen.status, seen.stderr).toBe(0)
    expect(seen.stdout).toMatch(/\d+\.\d+/)
  }, 300_000)

  it("is as empty for the git the program runs in a copy a step wrote, as fast mode does", async () => {
    const copy = mkdtempSync(join("/var/tmp", "smithers-ci-reach-copy-"))
    made.push(copy)
    spawnSync("git", ["init", "--quiet", copy])
    const work = mkdtempSync(join(tmpdir(), "smithers-ci-reach-"))
    made.push(work)
    // What a step can leave in its copy: a command git runs. Here it tries to read the two files.
    const peek = `!cat ${unlisted.inside} ${unlisted.beside}; echo done`
    const printed = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const real = yield* ChildProcessSpawner
        const places = yield* confine(work, () => found, () => Effect.void, [], false)
        const git = reading(real, places.fast, copy)
        return yield* git.string(ChildProcess.make("git", ["-c", `alias.peek=${peek}`, "peek"], { stderr: "ignore" }))
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<string>
    )
    expect(printed).toBe("done\n")
  })
})

describe.skipIf(process.platform !== "linux")("a command with no jail", () => {
  it("starts with no descriptor but its three", async () => {
    const seen = await asStep(["sh", "-c", "ls /proc/self/fd | tr '\\n' ' '"], false)
    expect(seen.status, seen.stderr).toBe(0)
    expect(seen.stdout.trim()).toBe("0 1 2 3")
  })

  it("names a command that is not there, and ends as a shell does for one it cannot find", async () => {
    const seen = await asStep(["/no/such/program", "an argument"], false)
    expect(seen.status).toBe(127)
    expect(seen.stderr).toBe("could not run /no/such/program\n")
    expect(seen.stdout).toBe("")
  })
})

describe("the filter of the jail", () => {
  it("is a program of whole instructions that ends by allowing the call", () => {
    const filter = keyringFilter()
    expect(filter.length % 8).toBe(0)
    expect(filter.length / 8).toBe(36)
    // The last instruction returns "allow"; the one before returns "not implemented" for the last processor's calls.
    expect([...filter.slice(-8)]).toEqual([0x06, 0, 0, 0, 0x00, 0x00, 0xFF, 0x7F])
    expect([...filter.slice(-16, -8)]).toEqual([0x06, 0, 0, 0, 38, 0x00, 0x05, 0x00])
  })
})

describe("the shared cache's token", () => {
  /** What a program that stands where `smthrs` stands says it was given. */
  const seen = fileURLToPath(new URL("token-seen.mjs", import.meta.url))
  const given = (token: string) => {
    const [node, starter] = smthrsWithToken() as readonly [string, string, string]
    const child = spawn(node, [starter, seen, "ci", "//:a"], {
      env: { PATH: process.env["PATH"] },
      stdio: ["pipe", "pipe", "inherit"]
    })
    let stdout = ""
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk))
    child.stdin?.end(token)
    return new Promise<unknown>((resolve) => child.on("close", () => resolve(JSON.parse(stdout))))
  }

  it("reaches Smithers build through a pipe: read by name, in no environment, and gone once removed", async () => {
    expect(await given("a-token-for-the-cache")).toEqual({
      token: "a-token-for-the-cache",
      shown: false,
      inherited: false,
      removed: true,
      sets: true,
      argv: [seen, "ci", "//:a"]
    })
  })

  it("is absent when the pipe holds none", async () => {
    expect(await given("")).toEqual({
      shown: false,
      inherited: false,
      removed: true,
      sets: true,
      argv: [seen, "ci", "//:a"]
    })
  })
})
