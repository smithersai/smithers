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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { homedir, tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { smthrsWithToken } from "../../src/cli/Install.ts"
import { confine, held, reading } from "../../src/replay/Confine.vibe"
import { stepEnvironment } from "../../src/replay/Environment.ts"
import { keyringFilter, probe, scopeProgram } from "../../src/replay/Jail.ts"

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

describe.skipIf(!jailable)("the machine's temporary directory, in the jail", () => {
  it("is the step's own to write when the replay's program is installed in the directory that holds it", async () => {
    // As `TMPDIR=/tmp/x/tmp` with the program under `/tmp/x/consumer`: `/tmp/x` stays in sight, read-only, for the
    // program, and the temporary directory inside it is still the replay's own.
    const holder = mkdtempSync("/tmp/smithers-ci-reach-")
    made.push(holder)
    const machines = join(holder, "tmp")
    const program = join(holder, "consumer", "program")
    mkdirSync(machines)
    mkdirSync(dirname(program))
    writeFileSync(program, "echo ran\n")
    writeFileSync(join(machines, "left-by-another-program"), "")
    const work = mkdtempSync(join(machines, "smithers-ci-replay-"))
    const seen = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const asked = () => ({ ...found, tmp: machines })
        const places = yield* confine(work, asked, () => Effect.void, [program], false, undefined, repository)
        const writes =
          "sh \"$2\" && touch \"$1/made\" && test ! -e \"$1/left-by-another-program\" && ! touch \"$2\" 2> /dev/null"
        const [command, ...args] = held(places.normal, [], ["sh", "-c", writes, "sh", machines, program])
        const ran = spawnSync(command, args, { env: stepEnvironment({}, places.normal), encoding: "utf8" })
        return { ran, own: existsSync(join(places.normal.tmp, "made")) }
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
        { readonly ran: SpawnSyncReturns<string>; readonly own: boolean }
      >
    )
    expect(seen.ran.stderr).toBe("")
    expect([seen.ran.status, seen.ran.stdout]).toEqual([0, "ran\n"])
    // What the step wrote is in the replay's directory, not in the machine's.
    expect(seen.own).toBe(true)
    expect(existsSync(join(machines, "made"))).toBe(false)
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
        const asked = yield* git.string(
          ChildProcess.make("git", ["-c", `alias.peek=${peek}`, "peek"], { stderr: "ignore" })
        )
        // Any other program a part starts to read the copy, as `zig build` runs the commit's build.zig.
        const other = yield* git.string(
          ChildProcess.make("sh", ["-c", `cat ${unlisted.inside} ${unlisted.beside}; echo done`], { stderr: "ignore" })
        )
        return [asked, other]
      })).pipe(Effect.provide(NodeServices.layer), Effect.orDie)
    )
    expect(printed).toEqual(["done\n", "done\n"])
  })
})

describe.skipIf(process.platform !== "linux")("a program of the person's that listens on a socket", () => {
  const listening: Array<Server> = []
  /** Whether this machine's kernel keeps a jailed step from the sockets that have a name and no file. */
  const scoped = !("refusal" in found) && found.scope !== undefined
  afterAll(() => listening.forEach((server) => server.close()))
  /** A program that listens at `address`, as a key agent or a session bus does. */
  const listens = (address: string) =>
    new Promise<string>((resolve) => {
      const server = createServer()
      listening.push(server)
      server.listen(address, () => resolve(address))
    })

  /** A socket in the session's runtime directory, where one is: the SSH agent of a desktop session listens there. */
  const session = `/run/user/${userInfo().uid}`
  let agents = 0
  const places = (): ReadonlyArray<string> => {
    const temporary = mkdtempSync("/tmp/ssh-")
    made.push(temporary)
    agents += 1
    const inSession = join(session, `smithers-ci-test-${randomUUID()}`)
    if (existsSync(session)) made.push(inSession)
    return [
      // Where ssh-agent listens when a shell starts it, and where gpg-agent listens in a home.
      join(temporary, `agent.${agents}`),
      join(dirname(unlisted.inside), `S.gpg-agent.${agents}`),
      ...(existsSync(session) ? [inSession] : [])
    ]
  }

  /**
   * What a step's program says of each address it tries: `reached`, or why not. A socket with a name and no file
   * is written with `@` first.
   */
  const tries = [
    "const net = require('node:net')",
    "const all = process.argv.slice(1).map((address) => new Promise((resolve) => {",
    "  const socket = net.connect(address.startsWith('@') ? '\\0' + address.slice(1) : address)",
    "  socket.on('connect', () => resolve('reached')).on('error', (error) => resolve(error.code))",
    "}))",
    "Promise.all(all).then((answers) => { console.log(answers.join(' ')); process.exit(0) })"
  ].join("\n")

  it.skipIf(!jailable)("is out of a jailed step's reach, by the path of its socket and by its name alone", async () => {
    const paths = await Promise.all(places().map(listens))
    const name = `smithers-ci-test-${randomUUID()}`
    await listens(`\0${name}`)
    const seen = await inJail(["node", "-e", tries, ...paths, `@${name}`])
    expect(seen.status, seen.stderr).toBe(0)
    // No file of a socket is there. One with a name alone is refused by the kernel, where the kernel can.
    expect(seen.stdout.trim().split(" ")).toEqual([...paths.map(() => "ENOENT"), scoped ? "EPERM" : "reached"])
  })

  it("is reached by a step with no jail", async () => {
    const paths = await Promise.all(places().map(listens))
    const name = `smithers-ci-test-${randomUUID()}`
    await listens(`\0${name}`)
    const seen = await asStep(["node", "-e", tries, ...paths, `@${name}`], false)
    expect(seen.status, seen.stderr).toBe(0)
    expect(seen.stdout.trim().split(" ")).toEqual([...paths.map(() => "reached"), "reached"])
  })

  it("leaves a step the sockets it makes itself", async () => {
    const own = [
      "const net = require('node:net')",
      "const server = net.createServer((socket) => socket.end('mine'))",
      "server.listen('\\0smithers-ci-test-own-' + process.pid, () => {",
      "  net.connect('\\0smithers-ci-test-own-' + process.pid).on('data', (said) => {",
      "    console.log(String(said))",
      "    process.exit(0)",
      "  })",
      "})"
    ].join("\n")
    const seen = await asStep(["node", "-e", own], jailable)
    expect(seen.status, seen.stderr).toBe(0)
    expect(seen.stdout).toBe("mine\n")
  })

  it.skipIf(!scoped)(
    "is kept from a jailed step before its command starts, and a command that is not there is named",
    async () => {
      const seen = await inJail(["/no/such/program"])
      expect([seen.status, seen.stderr, seen.stdout]).toEqual([127, "could not run /no/such/program\n", ""])
    }
  )

  it.skipIf(spawnSync("perl", ["-e", "1"]).status !== 0)(
    "starts a step's command only once the kernel has taken the scope",
    () => {
      // The kernel scopes only a process that can gain no privilege. The jail's cannot; whether one outside it
      // can depends on what started the tests. Where the kernel refuses, the command never starts.
      const seen = spawnSync("perl", ["-e", scopeProgram, "--", "sh", "-c", "echo started"], { encoding: "utf8" })
      if (seen.status === 0) {
        expect([seen.stdout, seen.stderr]).toEqual(["started\n", ""])
      } else {
        expect([seen.status, seen.stdout]).toEqual([126, ""])
        expect(seen.stderr).toContain("smithers-ci: the kernel did not keep abstract sockets out of the jail")
      }
    }
  )
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
