/**
 * `smithers-ci` started with tokens in its environment, on a repository whose
 * CI looks for them: a step that reads its own environment, the environment
 * and command line of every process it can see, the descriptors it was
 * started with, and every file the replay wrote. The whole program, every
 * part on `main`, real `git`, real `smthrs`, a real shared cache to send the
 * token to, and on a machine that has one, the real jail.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { cli } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { parts } from "../../src/cli/parts.ts"
import { Options } from "../../src/replay/index.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, git, recorder, remove, temporary, until } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
const servers: Array<Server> = []
afterAll(() => {
  made.forEach(remove)
  servers.forEach((server) => server.close())
})
afterEach(() => vi.unstubAllEnvs())

const home = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** A value no other process on this machine holds, in two halves. Every token of the test starts with it. */
const halves = ["smithers-ci-canary-", randomUUID()] as const
const canary = halves.join("")

/** The variables a person has set when they run the program: the two it reads, and two of other tools. */
const tokens = Object.fromEntries(
  ["AI_GATEWAY_API_KEY", "SMITHERS_CACHE_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"].map((
    name,
    index
  ) => [name, `${canary}-${index}`])
)

/**
 * The step. It fails when it finds a canary: in its own environment; in the environment or command line of any
 * process it can read, through `/proc` on Linux and through `ps` where there is none; or in a file under the
 * directory the replay keeps its copies, homes, caches and run records in. It also fails when it was started with a
 * descriptor beyond its three, as it would be if the program passed on one it was itself started with. It prints
 * the name of what held a canary, never a value. The script holds the canary
 * in halves, so a search for the whole does not find the script.
 */
const look = [
  "#!/bin/bash",
  `canary=${halves[0]}`,
  `canary="$canary"${halves[1]}`,
  // The canary is on no command line of the step's own: a search reads it from descriptor 3. What records the
  // step's commands, as the replay does to learn what a step reads, so records no canary either.
  "case \"$(env)\" in *\"$canary\"*) echo \"a token is in the step's environment\" >&2; exit 1 ;; esac",
  // One search over what every process was started with.
  "set -- /proc/[0-9]*/environ /proc/[0-9]*/cmdline",
  "held=$(grep -alF -f /dev/fd/3 -- \"$@\" 3<<<\"$canary\" 2>/dev/null | head -1)",
  "if [ -n \"$held\" ]; then",
  "  echo \"a token is in $held: $(tr '\\0' ' ' < \"${held%/*}/cmdline\" | cut -c1-60)\" >&2",
  "  exit 1",
  "fi",
  "if [ ! -d /proc/self ]; then",
  "  ps eww -ax > \"$HOME/processes\" 2>/dev/null",
  "  if grep -qF -f /dev/fd/3 \"$HOME/processes\" 3<<<\"$canary\"; then",
  "    echo \"a token is in what ps shows of a process\" >&2",
  "    exit 1",
  "  fi",
  "  rm -f \"$HOME/processes\"",
  "fi",
  // bash holds the script itself as 255. Listing the descriptors opens one more, closed again by the time it is
  // looked at.
  "for descriptor in /proc/$$/fd/*; do",
  "  case ${descriptor##*/} in 0|1|2|255|'*') continue ;; esac",
  "  [ -e \"$descriptor\" ] || continue",
  "  echo \"descriptor ${descriptor##*/} is open\" >&2",
  "  exit 1",
  "done",
  // The step's home is `home/<way>` in the replay's directory.
  "held=$(grep -rIlF -f /dev/fd/3 -- \"$HOME/../..\" 3<<<\"$canary\" 2>/dev/null | head -1)",
  "if [ -n \"$held\" ]; then echo \"a token is in the file $held\" >&2; exit 1; fi",
  ""
].join("\n")

/**
 * Two files in the real home of whoever runs the tests, at paths no list of credentials could name: one in a
 * directory of settings with a name of its own, one directly in the home. A jailed step finds neither.
 */
const unlisted = (() => {
  const name = `.smithers-ci-test-${randomUUID()}`
  const inside = join(homedir(), name, "token")
  const beside = join(homedir(), `${name}.txt`)
  mkdirSync(join(homedir(), name))
  writeFileSync(inside, "a token of a program nobody heard of\n")
  writeFileSync(beside, "a note with a password in it\n")
  keep(join(homedir(), name))
  keep(beside)
  return [inside, beside] as const
})()

/** Where the person's container daemon is, in the test that allows Docker. No daemon listens there. */
const daemon = "unix:///nowhere/docker.sock"

/** A repository of two commits whose CI is the step, then `more`. */
const fixture = (more: ReadonlyArray<string> = []): string => {
  const root = keep(temporary("secrets"))
  const workflow = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  look:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: ./look.sh",
    ...more.map((step) => `      - run: ${step}`),
    ""
  ].join("\n")
  git(root, "init", "--quiet", "--initial-branch=main")
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow)
  writeFileSync(join(root, "look.sh"), look)
  chmodSync(join(root, "look.sh"), 0o755)
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c1")
  // A second commit, the one replayed: its steps run after the replay's first run, at the commit before, and
  // search everything that run left behind.
  writeFileSync(join(root, "notes.md"), "a change\n")
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c2")
  return root
}

/**
 * A shared cache on this machine that holds nothing and takes everything. It keeps the credential of each request it
 * is sent.
 */
const cache = async () => {
  const sent: Array<string> = []
  const server = createServer((request, response) => {
    sent.push(request.headers.authorization ?? "")
    request.resume().on("end", () => {
      response.statusCode = request.method === "PUT" ? 201 : 404
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent }
}

/**
 * Runs the program in `root` with the tokens set and the shared cache named. With `refusal`, the machine says it
 * cannot jail a step.
 */
const program = async (root: string, url: string, refusal?: string) => {
  for (const [name, value] of Object.entries(tokens)) vi.stubEnv(name, value)
  const sink = recorder()
  const run = cli(["--commits", "1", "--no-apply-check", "--json", "--cache", url], root, parts)
  const noJail = Layer.effect(
    Options,
    Effect.gen(function*() {
      return { ...(yield* Options), confine: () => ({ refusal: refusal as string }) }
    })
  )
  const code = await Effect.runPromise(
    (refusal === undefined ? run : Effect.provide(run, noJail)).pipe(
      // The program gives its parts the variables it was started with, as the published program does.
      Effect.provide(layer({ ...home, ...tokens })),
      Effect.provideService(Console.Console, sink.service as never)
    ) as Effect.Effect<number>
  )
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

interface Way {
  readonly ok: boolean
  readonly failures?: ReadonlyArray<{ readonly reason: string }>
}

/** What the report says of each commit: how each way ended, and why a step failed. */
const ways = (stdout: string) =>
  (JSON.parse(stdout) as { readonly commits: ReadonlyArray<Readonly<Record<"baseline" | "normal", Way>>> }).commits
    .map((commit) => {
      const of = (way: "baseline" | "normal") => ({
        ok: commit[way].ok,
        reasons: (commit[way].failures ?? []).map((failure) => failure.reason)
      })
      return { baseline: of("baseline"), normal: of("normal") }
    })

/** How a run ended and what its report says; what it wrote as errors when it printed no report. */
const told = (outcome: { readonly code: number; readonly stdout: string; readonly stderr: string }) => ({
  code: outcome.code,
  ways: outcome.stdout === "" ? outcome.stderr : ways(outcome.stdout)
})

const jailable = !("refusal" in probe())
const passed = { ok: true, reasons: [] }
const bothPassed = { baseline: passed, normal: passed }

/** What the system says a process was started with: every process of this user can read it. */
const startedWith = (pid: number): string => {
  try {
    return process.platform === "linux"
      ? readFileSync(`/proc/${pid}/environ`, "utf8")
      : execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" })
  } catch {
    return ""
  }
}

describe("smithers-ci started with tokens in its environment", () => {
  it.skipIf(!jailable)("shows a step none of them, and sends the cache its token", async () => {
    const shared = await cache()
    // In the jail the home of whoever runs the program is empty: the two files are not there, in the baseline or as
    // a target.
    const outcome = await program(fixture(unlisted.map((file) => `test ! -e ${file}`)), shared.url)

    expect(told(outcome)).toEqual({ code: 0, ways: [bothPassed] })
    // Smithers build was given the token, on a pipe: the cache was sent it.
    expect(shared.sent).toContain(`Bearer ${tokens["SMITHERS_CACHE_TOKEN"]}`)
  }, 1_800_000)

  it("shows a step none of them on a machine with no jail", async () => {
    const shared = await cache()
    const outcome = await program(fixture(), shared.url, "bwrap is not on PATH (install the bubblewrap package)")

    expect(told(outcome)).toEqual({ code: 0, ways: [bothPassed] })
    expect(shared.sent).toContain(`Bearer ${tokens["SMITHERS_CACHE_TOKEN"]}`)
  }, 1_800_000)

  it("holds none of them in its own process while a step runs", async () => {
    // The published program, as a process started with the tokens. Its PATH has the system's directories and this
    // Node: on a machine that keeps bubblewrap elsewhere there is no jail, and the step sees the program itself.
    // What the program reads of the person's variables it still reads, from memory: with Docker allowed, a step
    // is told where the person's daemon is.
    const child = spawn(process.execPath, [bin, "--commits", "1", "--no-apply-check", "--json", "--allow-docker"], {
      cwd: fixture([`test "$DOCKER_HOST" = ${daemon}`]),
      env: {
        ...process.env,
        ...home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        DOCKER_HOST: daemon,
        ...tokens
      },
      // A fourth descriptor, as a caller that keeps a channel to the program leaves one open.
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk))
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk))
    const code = new Promise<number | null>((resolve) => child.on("close", resolve))
    const pid = child.pid as number

    // Before any step runs, the process is one that was started without the tokens. It is the same process.
    expect(startedWith(pid)).toContain(canary)
    // While the program is inside its own `execve` the system gives an empty environment: neither start's.
    await until(() => {
      const now = startedWith(pid)
      return child.exitCode !== null || (now !== "" && !now.includes(canary))
    }, "the program to start again")
    expect(child.exitCode).toBeNull()
    expect(startedWith(pid)).not.toBe("")

    expect(await code, stderr).toBe(0)
    expect(ways(stdout)).toEqual([bothPassed])
  }, 1_800_000)
})
