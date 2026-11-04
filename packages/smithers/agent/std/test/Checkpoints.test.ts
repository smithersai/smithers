/**
 * The checkpoint store's two halves, against a scripted process.
 *
 * `CheckpointsFixture.test.ts` drives the git half against a real repository;
 * this file pins the argv it spawns and the shape it answers with. The
 * relocation table it re-exports is pinned by `Relocate.test.ts`.
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Logger, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import type { Word } from "effect/process/CommandLine"
import * as Redacted from "effect/Redacted"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.vibe"
import { GitWorktree } from "../src/internal/GitWorktree.ts"
import * as Relocate from "../src/Relocate.vibe"

// Effect 4.1 types a command's arguments and environment values as Word, text or
// Redacted text; the fakes read what the process would receive.
const word = (value: Word): string => Redacted.isRedacted(value) ? Redacted.value(value) : value
const argsOf = (command: { readonly args: ReadonlyArray<Word> }): Array<string> => command.args.map(word)
const envOf = (
  command: { readonly options: { readonly env?: Readonly<Record<string, Word | undefined>> | undefined } }
): Record<string, string | undefined> | undefined =>
  command.options.env === undefined ? undefined : Object.fromEntries(
    Object.entries(command.options.env).map(([name, value]) => [name, value === undefined ? undefined : word(value)])
  )

interface Response {
  readonly stdout?: string
  readonly exitCode?: number
}

/** Records every argv and answers each from a table keyed by a fragment. */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>,
  envs: Array<Readonly<Record<string, string>> | undefined> = []
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...argsOf(standard)]
        spawns.push(argv)
        envs.push(envOf(standard) as Readonly<Record<string, string>> | undefined)
        const line = argv.join(" ")
        const scripted = [...responses, ...repository].find(([fragment]) => line.includes(fragment))?.[1] ?? {}
        const found = typeof scripted === "function" ? scripted() : scripted
        const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
        const stdout = encode(found.stdout ?? "")
        const stderr = encode("")
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(found.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  }))

/** What `rev-parse` reports about `/work/repo`, answered when a test's own table does not. */
const repository: ReadonlyArray<readonly [string, Response]> = [
  ["--show-toplevel", { stdout: "/work/repo\n/work/repo/.git\n/work/repo/.git/index\nsha1\n" }],
  ["--get-regexp", { exitCode: 1 }],
  // The checkout's scratch parent, the shadow and the root's parent share one filesystem.
  ["stat -c %d", { stdout: "1\n1\n1\n" }]
]

const store = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>,
  options: Checkpoints.GitOptions = { root: "/work/repo" },
  envs?: Array<Readonly<Record<string, string>> | undefined>
) => Effect.provide(Checkpoints.makeGit(options), host(spawns, responses, envs))

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { code?: string; message?: string } | undefined
    : undefined

const materialized: Checkpoints.Materialized = {
  id: "cp-0-1",
  host: "/work/repo/.flows-checkpoints/cp-0-1",
  guest: "/testbed/.flows-checkpoints/cp-0-1",
  root: "/work/repo",
  guestRoot: "/testbed"
}

/** The shadow GIT_DIR is a fresh temporary path per operation; argv pins name it `<shadow>`. */
const lines = (spawns: ReadonlyArray<ReadonlyArray<string>>) =>
  spawns.map((argv) =>
    argv.map((part) => part.replace(/^(--git-dir=|--work-tree=)?\S*\/smithers-git-[0-9a-f-]{36}/, "$1<shadow>")).join(
      " "
    )
  )

/** The exact allocated path must be used for checkout, relocation and removal. */
const checkoutPath = (spawns: ReadonlyArray<ReadonlyArray<string>>) => {
  const published = spawns.find((argv) => argv[0] === "sh" && argv[2]?.includes("mv --"))
  const path = published === undefined ? undefined : `${published[5]}/${published[6]}`
  expect(path).toMatch(/^\/work\/repo\/\.flows-checkpoints\/[a-z0-9-]+-[0-9a-f-]{36}$/)
  return path!
}

const workspace = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /work/repo"
const shadow = "git --git-dir=<shadow>"
const guarded = "-c core.hooksPath=/dev/null -c core.fsmonitor=false"
const configFile = "git --git-dir=/dev/null config --file /work/repo/.git/config"

/** Opening the workspace: paths and hashing settings, as data. */
const opened = [
  `${workspace} rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-path index --show-object-format`,
  `${configFile} --get-regexp ^core\\.(autocrlf|eol|safecrlf|filemode|symlinks|ignorecase|precomposeunicode)$`
]

/**
 * The host opens the workspace when it builds the store, before any agent runs;
 * each operation opens it again and refuses a repository other than that one.
 */
const bound = [...opened, ...opened]

const init = "git init --quiet --bare --template= --object-format=sha1 <shadow>"

const checkout = (path: string, commit: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return [
    init,
    `sh -c ${measureScript} sh /work/repo/.flows-checkpoints <shadow> /work ${cacheRoot}`,
    `sh -c set -eC; mkdir -- "$2" "$2/.git" "$2/.git/objects" "$2/.git/objects/info" "$2/.git/refs"; printf '%s\\n' "$3" > "$2/.git/HEAD"; printf '%s\\n' "$4" > "$2/.git/objects/info/alternates"; printf '%s' "$5" > "$2/.git/config" sh <shadow> <shadow>/${name} ${commit} ../../../../.git/objects [core]\n\trepositoryformatversion = 0\n\tbare = false\n`,
    `${shadow} --work-tree=<shadow>/${name} ${guarded} read-tree --reset -u ${commit}`,
    `sh -c set -C; cat -- "$1" > "$2" sh <shadow>/index <shadow>/${name}/.git/index`,
    `sh -c ${publishScript} sh <shadow>/${name} ${path.slice(0, path.lastIndexOf("/"))} ${name} /work/repo`,
    "rm -rf -- <shadow>"
  ]
}

/** The host cache the stage falls back to, from this process's environment. */
const cacheRoot = "/host-cache/smithers"
beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", "/host-cache")
})
afterEach(() => vi.unstubAllEnvs())

/** Finds which staging directory shares the checkout parent's filesystem. */
const measureScript = [
  "set -e",
  `mkdir -p -- "$1"`,
  `dev() { stat -c %d -- "$1" 2>/dev/null || stat -f %d -- "$1" 2>/dev/null || echo; }`,
  `t=$(dev "$1")`,
  `s=$(dev "$2")`,
  `if [ -w "$3" ]; then b=$(dev "$3"); else b=unwritable; fi`,
  "c=",
  `if [ -n "$t" ] && [ "$t" != "$s" ] && [ "$t" != "$b" ] && [ -n "$4" ] && mkdir -p -m 700 -- "$4" 2>/dev/null; then c=$(dev "$4"); fi`,
  `printf '%s\\n' "$t" "$s" "$b" "$c"`
].join("; ")

/**
 * Enters the checkout's parent by its physical path, refuses one outside the
 * workspace root, renames the staged checkout in relative to it and proves the
 * directory there is the one staged.
 */
const publishScript = [
  "set -e",
  `root=$(cd -P -- "$4" && pwd -P)`,
  `cd -P -- "$2"`,
  "here=$(pwd -P)",
  `case "$here" in "$root"|"$root"/*) ;; *) echo "$2 resolves to $here, outside the workspace $root" >&2; exit 1 ;; esac`,
  `if [ -e "./$3" ] || [ -L "./$3" ]; then echo "$2/$3 already exists" >&2; exit 1; fi`,
  `staged=$(ls -di -- "$1" | awk '{print $1}')`,
  `mv -- "$1" "./$3"`,
  `if [ -L "./$3" ] || [ ! -d "./$3" ]; then echo "$2/$3 was replaced while it was written" >&2; exit 1; fi`,
  `moved=$(ls -di -- "./$3" | awk '{print $1}')`,
  `if [ "$staged" != "$moved" ]; then echo "$2/$3 was replaced while it was written" >&2; exit 1; fi`
].join("; ")

describe("Checkpoints.makeGit capture", () => {
  it.each([
    ["TMPDIR", "/native/tmp/", "/native/tmp"],
    ["TEMP", "C:\\Users\\runner\\Temp\\", "C:/Users/runner/Temp"],
    ["TMP", "D:/scratch/", "D:/scratch"]
  ])("uses %s for both native Git and shell index staging", async (variable, value, expected) => {
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, undefined)
    vi.stubEnv(variable, value)
    const spawns: Array<ReadonlyArray<string>> = []
    try {
      await Effect.runPromise(
        GitWorktree.withShadow({
          root: "/work/repo",
          toplevel: "/work/repo",
          common: "/work/repo/.git",
          index: "/work/repo/.git/index",
          objectFormat: "sha1",
          settings: []
        }, (shadow) => shadow.adoptIndex).pipe(Effect.provide(host(spawns, [])))
      )
      const directory = spawns.find((argv) => argv.includes("--bare"))!.at(-1)!
      expect(directory).toMatch(new RegExp(`^${expected}/smithers-git-[0-9a-f-]{36}$`))
      expect(spawns.find((argv) => argv[0] === "sh")!.at(-1)).toBe(`${directory}/index`)
      expect(spawns.at(-1)).toEqual(["rm", "-rf", "--", directory])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("records the working tree through a shadow GIT_DIR, without touching the index or the worktree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const envs: Array<Readonly<Record<string, string>> | undefined> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(
        spawns,
        [
          ["stash create", { stdout: "abc123\n" }],
          ["HEAD^", { stdout: "head999\n" }]
        ],
        { root: "/work/repo" },
        envs
      )
      return yield* checkpoints.capture("cp-0-1")
    }))

    // `stash create` records; nothing writes the repository's index, because
    // the shadow reads a copy of it. The agent's own `git diff` — the run's
    // evidence — is read off that index.
    //
    // And the commit is named in config, never with a ref: a ref is history,
    // and a checkpoint holds the agent's own edit.
    expect(lines(spawns)).toEqual([
      ...bound,
      init,
      `${workspace} rev-parse --verify --quiet HEAD^{commit}`,
      // The copy takes the index's modification time before its bytes (#3431).
      "sh -c set -C; if [ -e \"$1\" ]; then : > \"$2.at\" && touch -r \"$1\" -- \"$2.at\" && cat -- \"$1\" > \"$2\" && "
      + "touch -r \"$2.at\" -- \"$2\" && rm -f -- \"$2.at\"; fi sh /work/repo/.git/index <shadow>/index",
      `${shadow} ${guarded} update-ref --no-deref HEAD head999`,
      `${shadow} --work-tree=/work/repo ${guarded} stash create flows checkpoint cp-0-1`,
      "rm -rf -- <shadow>",
      `${configFile} flows-checkpoint.cp-0-1 abc123`
    ])
    // The shadow reads no host config file and writes the workspace's objects.
    const stash = spawns.findIndex((argv) => argv.includes("stash"))
    expect(envs[stash]).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OBJECT_DIRECTORY: "/work/repo/.git/objects"
    })
    expect(snapshot).toMatchObject({ id: "cp-0-1", ref: "abc123" })
  })

  it("takes HEAD when the working tree has nothing of its own to record", async () => {
    // `stash create` prints nothing for a clean tree. That is not an error and
    // must not be read as one: the tree IS the commit it is sitting on.
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "" }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-1-0")
    }))

    expect(lines(spawns).at(-1)).toBe(`${configFile} flows-checkpoint.cp-1-0 head999`)
    expect(snapshot.ref).toBe("head999")
  })

  it("carries only bare-word hashing settings from the workspace config onto the shadow", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get-regexp", {
          stdout: "core.filemode false\ncore.autocrlf true\ncore.eol $(touch /tmp/owned)\n"
        }],
        ["stash create", { stdout: "abc123\n" }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-0-1")
    }))

    expect(lines(spawns)).toContain(
      `${shadow} --work-tree=/work/repo ${guarded} -c core.filemode=false -c core.autocrlf=true stash create flows checkpoint cp-0-1`
    )
  })

  it("refuses an id that could not safely become a ref or a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.capture("../../etc/passwd")
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(lines(spawns)).toEqual(opened)
  })

  it("says so when git could not record the tree, and still removes the shadow", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { exitCode: 1 }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not record the working tree")
    expect(lines(spawns).at(-1)).toBe("rm -rf -- <shadow>")
  })

  it("says so when the workspace is not a git work tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* Effect.provide(
        Checkpoints.makeGit({ root: "/work/repo" }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
          spawn: (command) =>
            Effect.sync(() => {
              const standard = command as ChildProcess.StandardCommand
              spawns.push([standard.command, ...argsOf(standard)])
              const empty = Stream.make(new TextEncoder().encode(""))
              return makeHandle({
                pid: ProcessId(1),
                exitCode: Effect.succeed(ExitCode(128)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: empty,
                stderr: empty,
                all: empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void)
              })
            })
        }))
      )
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("/work/repo is not a git work tree")
    expect(spawns).toHaveLength(1)
  })

  it("says so when git could not be spawned at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* Effect.provide(
        Checkpoints.makeGit({ root: "/work/repo" }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop())
      )
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("git could not run")
  })

  it("says so when the checkpoint could not be named", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "abc123\n" }],
        ["HEAD^", { stdout: "head999\n" }],
        ["config --file /work/repo/.git/config flows-checkpoint", { exitCode: 1 }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not name the checkpoint")
  })
})

describe("Checkpoints.makeGit materialize", () => {
  it("documents that a declared baseRef is authoritative", () => {
    const guide = readFileSync(new URL("../docs/guides/pin-a-checkpoint.md", import.meta.url), "utf8")
    expect(guide).toMatch(/A declared ref that\s+does not resolve is `not_found`/)
    expect(guide).toMatch(/Otherwise it tries `TestRunner.captureBase`\s+and then `HEAD`/)
  })

  it("checks the tree out beside the repository from a shadow GIT_DIR and removes it however the call ends", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    expect(seen).toEqual({
      id: "cp-0-1",
      host: checkoutPath(spawns),
      // No container declared, so the two names of the one directory are the
      // same name.
      guest: checkoutPath(spawns),
      root: "/work/repo",
      guestRoot: "/work/repo"
    })
    expect(lines(spawns)).toEqual([
      ...bound,
      `${configFile} --get flows-checkpoint.cp-0-1`,
      ...checkout(checkoutPath(spawns), "abc123"),
      `rm -rf -- ${checkoutPath(spawns)}`
    ])
  })

  it("never registers a worktree in, or rewrites the format of, the workspace repository", async () => {
    // Git 2.48+ stamps a repository that gains a relative worktree, and a
    // pre-2.48 git then refuses it whole — on the r97 wave, 15 of 45 runs lost
    // every in-container `git status` and `git diff`. The shadow checkout
    // writes nothing into the workspace's `.git` but objects, so there is
    // no stamp to repair.
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    }))

    for (const line of lines(spawns)) {
      expect(line).not.toMatch(/worktree (add|remove)|config --local|relativeWorktrees/)
    }
  })

  it("allocates a new path each time the same materialization effect runs", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const paths = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]])
      const read = checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found.host))
      return [yield* read, yield* read]
    }))
    expect(paths[0]).not.toBe(paths[1])
    const removed = lines(spawns).filter((line) => line.startsWith("rm -rf -- /work/repo"))
    expect(removed).toEqual(paths.map((path) => `rm -rf -- ${path}`))
  })

  it("keeps the caller's process service inside the callback", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const caller = ChildProcessSpawner.makeNoop()
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => ChildProcessSpawner.ChildProcessSpawner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, caller)
      )
    }))
    expect(seen).toBe(caller)
  })

  it("removes the checkout when the call inside it fails", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.fail("the call failed"))
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    // A run killed at its wall-clock budget would otherwise leave a second
    // checkout of the whole repository inside the tree whose diff is its answer.
    expect(lines(spawns).at(-1)).toBe(`rm -rf -- ${checkoutPath(spawns)}`)
  })

  it("gives the container's name for the directory when the host declared one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { stdout: "abc123\n" }]], {
        root: "/work/repo",
        cwd: "/testbed"
      })
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    // One directory, two names: the host checks it out under the workspace, and
    // the container sees it at the same subpath under its bind mount. That is
    // the whole reason the scratch lives inside the workspace.
    expect(seen.host).toBe(checkoutPath(spawns))
    expect(seen.guest).toBe(checkoutPath(spawns).replace("/work/repo", "/testbed"))
  })

  it("resolves the base id against the capture base, then HEAD", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["capture-base", { stdout: "base999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(lines(spawns)[bound.length]).toContain("refs/flows/capture-base^{commit}")
  })

  it("falls back to HEAD when no capture base was recorded", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["capture-base", { exitCode: 1 }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(lines(spawns)).toEqual([
      ...bound,
      `${workspace} rev-parse --verify --quiet refs/flows/capture-base^{commit}`,
      `${workspace} rev-parse --verify --quiet HEAD^{commit}`,
      ...checkout(checkoutPath(spawns), "head999"),
      `rm -rf -- ${checkoutPath(spawns)}`
    ])
  })

  it("takes only the declared base ref when the host named one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["refs/flows/absent", { exitCode: 1 }]], {
        root: "/work/repo",
        baseRef: "refs/flows/absent"
      })
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    })))

    // A declared ref that does not resolve is an error rather than a fallback:
    // a baseline against the wrong tree answers the question wrong, which is
    // worse than not answering it.
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(lines(spawns)).toEqual([
      ...bound,
      `${workspace} rev-parse --verify --quiet refs/flows/absent^{commit}`
    ])
  })

  it("refuses an id that could not safely become a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.materialize("../escape", () => Effect.void)
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(lines(spawns)).toEqual(opened)
  })

  it("refuses a checkpoint the workspace config does not name", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["--get flows-checkpoint", { exitCode: 1 }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.code).toBe("not_found")
  })

  it.each([
    ["mkdir", "the directory could not be prepared"],
    ["read-tree", "the tree could not be written"],
    ["cat --", "the index could not be copied"],
    ["mv --", "the finished directory could not take its name"],
    ["stat -c %d", "the filesystems could not be measured"]
  ])("says so when the checkout itself failed at %s (%s)", async (fragment) => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        [fragment, { exitCode: 128 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toContain("Could not check out abc123")
    expect(lines(spawns).at(-1)).toMatch(/^rm -rf -- \/work\/repo\/\.flows-checkpoints\//)
  })
})

describe("Checkpoints.makeGit staging", () => {
  it("refuses to check out when no staging directory shares the workspace's filesystem", async () => {
    // A copy into the workspace would write through whatever the agent swapped
    // in; only a same-filesystem rename is safe, so nothing is written at all.
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "1\n2\n3\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toContain("is on the filesystem of /work/repo/.flows-checkpoints")
    expect(lines(spawns).some((line) => line.includes("read-tree"))).toBe(false)
  })

  it("stages under the host cache when only that shares the filesystem, and names an unwritable root parent", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "1\n2\nunwritable\n1\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    }))

    const stage = `${cacheRoot}/checkout-`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const written = lines(spawns).find((line) => line.includes("read-tree"))
    expect(written).toMatch(new RegExp(`--work-tree=${stage}[0-9a-f-]{36}/cp-0-1-[0-9a-f-]{36} `))
    expect(lines(spawns)).toContainEqual(expect.stringMatching(new RegExp(`^rm -rf -- ${stage}[0-9a-f-]{36}$`)))

    const refused: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(refused, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "1\n2\nunwritable\n\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))
    expect(failureOf(exit)?.message).toContain("nor /work (not writable by this user) nor")
  })

  it("stages beside the workspace root when only that shares its filesystem, and removes the stage", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "1\n2\n1\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    }))

    const written = lines(spawns).find((line) => line.includes("read-tree"))
    expect(written).toMatch(/--work-tree=\/work\/\.smithers-checkout-[0-9a-f-]{36}\/cp-0-1-[0-9a-f-]{36} /)
    expect(lines(spawns)).toContainEqual(expect.stringMatching(/^rm -rf -- \/work\/\.smithers-checkout-[0-9a-f-]{36}$/))
  })
})

describe("Checkpoints.makeNoop", () => {
  it("says plainly that this host pins nothing", async () => {
    const noop = Checkpoints.makeNoop()
    const captured = await Effect.runPromise(Effect.exit(noop.capture("cp-0-0")))
    const held = await Effect.runPromise(Effect.exit(noop.materialize("cp-0-0", () => Effect.void)))

    expect(failureOf(captured)?.code).toBe("provider_unavailable")
    expect(failureOf(held)?.message).toContain("Take the reading on the live tree instead")
  })

  it("names the checkpoint it was asked for, as Container.unavailable names the container", () => {
    const refusal = Checkpoints.unavailable("cp-0-3")

    expect(refusal.code).toBe("provider_unavailable")
    expect(refusal.message).toContain(`"cp-0-3"`)
    expect(Container.unavailable("box").message).toContain(`"box"`)
  })

  it("is provided as a layer, for a host with no version control at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(Effect.provide(Checkpoints.layerNoop))
    ))

    expect(failureOf(exit)?.code).toBe("provider_unavailable")
  })

  it("is what the layer constructor builds, given a store", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(
        Effect.provide(Checkpoints.layerGit({ root: "/work/repo" })),
        Effect.provide(host(spawns, [["stash create", { stdout: "abc123\n" }], ["HEAD^", { stdout: "head999\n" }]]))
      )
    )

    expect(snapshot.id).toBe("cp-0-0")
  })

  it("builds a store from an implementation", async () => {
    const built = Checkpoints.make({
      capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `custom/${id}` })),
      materialize: (id, use) => use({ id, host: `/h/${id}`, guest: `/g/${id}`, root: "/h", guestRoot: "/g" })
    })

    expect((await Effect.runPromise(built.capture("x"))).ref).toBe("custom/x")
    expect(await Effect.runPromise(built.materialize("x", (found) => Effect.succeed(found.guest)))).toBe("/g/x")
  })
})

describe("Checkpoints.relocate", () => {
  it("is the relocation table, re-exported so the harness reaches it here", () => {
    // `Relocate.test.ts` owns the behaviour. This pins only that the name the
    // harness and `@smthrs/agent` import still resolves to it.
    expect(Checkpoints.relocate).toBe(Relocate.relocate)
  })
})

describe("Checkpoints.makeGit host faults", () => {
  /** The text of every warning the run logs. */
  const warned = () => {
    const warnings: Array<string> = []
    const logger = Logger.make((options) => {
      if (options.logLevel === "Warn") warnings.push([options.message].flat().join(" "))
    })
    return { warnings, layer: Logger.layer([logger]) }
  }

  it("says so when git could not create the shadow repository, and still removes it", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["init --quiet --bare", { exitCode: 1 }]])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)).toMatchObject({ code: "command_failed", message: "Could not create a shadow repository: " })
    expect(lines(spawns).slice(-2)).toEqual([init, "rm -rf -- <shadow>"])
  })

  it("says so when git could not point the shadow at HEAD, and records nothing", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["update-ref --no-deref HEAD", { exitCode: 1 }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toBe("Could not record the working tree: ")
    expect(lines(spawns).some((line) => line.includes("stash create"))).toBe(false)
    expect(lines(spawns).at(-1)).toBe("rm -rf -- <shadow>")
  })

  it("keeps what a materialized checkpoint answered when nothing could be removed, and warns for each", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const { layer, warnings } = warned()
    const seen = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* store(spawns, [
          ["--get flows-checkpoint", { stdout: "abc123\n" }],
          ["rm -rf --", { exitCode: 1 }]
        ])
        return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found.host))
      }).pipe(Effect.provide(layer))
    )

    expect(seen).toBe(checkoutPath(spawns))
    expect(lines(spawns).filter((line) => line.startsWith("rm -rf --"))).toEqual([
      "rm -rf -- <shadow>",
      `rm -rf -- ${checkoutPath(spawns)}`
    ])
    expect(warnings).toEqual(["could not remove a shadow repository", "could not remove a scratch checkout"])
  })
})

describe("Checkpoints.makeGit host edges", () => {
  /** The argv of the one spawn whose script includes `fragment`. */
  const script = (spawns: ReadonlyArray<ReadonlyArray<string>>, fragment: string) =>
    spawns.find((argv) => argv[0] === "sh" && argv[2]?.includes(fragment))!

  /** The shadow `git init` created. */
  const shadowPath = (spawns: ReadonlyArray<ReadonlyArray<string>>) =>
    spawns.find((argv) => argv.includes("--bare"))!.at(-1)!

  it("puts the shadow under /tmp when no temporary directory is configured", async () => {
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, "")
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(
      GitWorktree.withShadow({
        root: "/work/repo",
        toplevel: "/work/repo",
        common: "/work/repo/.git",
        index: "/work/repo/.git/index",
        objectFormat: "sha1",
        settings: []
      }, (shadow) => shadow.adoptIndex).pipe(Effect.provide(host(spawns, [])))
    )

    expect(shadowPath(spawns)).toMatch(/^\/tmp\/smithers-git-[0-9a-f-]{36}$/)
    expect(spawns.at(-1)).toEqual(["rm", "-rf", "--", shadowPath(spawns)])
  })

  it("says so when the workspace index could not be copied, and records nothing", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["touch -r", { exitCode: 1 }],
        ["HEAD^", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)).toMatchObject({ code: "command_failed", message: "Could not read the workspace index: " })
    expect(lines(spawns).some((line) => /update-ref|stash create/.test(line))).toBe(false)
    expect(lines(spawns).at(-1)).toBe("rm -rf -- <shadow>")
  })

  it("gives a sha256 repository's checkout a version 1 config that names its object format", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--show-toplevel", { stdout: "/work/repo\n/work/repo/.git\n/work/repo/.git/index\nsha256\n" }],
        ["--get-regexp", { stdout: "core.filemode false\n" }],
        ["--get flows-checkpoint", { stdout: "abc123\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    }))

    expect(lines(spawns)).toContain("git init --quiet --bare --template= --object-format=sha256 <shadow>")
    expect(script(spawns, "mkdir --").at(-1)).toBe(
      "[core]\n\trepositoryformatversion = 1\n\tbare = false\n\tfilemode = false\n[extensions]\n\tobjectformat = sha256\n"
    )
  })

  it("refuses to check out when stat measured no device, rather than matching one empty answer to another", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "\n\n\n\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toBe(
      `Could not check out abc123: neither ${shadowPath(spawns)} nor /work nor ${cacheRoot} is on the filesystem of `
        + "/work/repo/.flows-checkpoints"
    )
    expect(lines(spawns).some((line) => /mkdir -- |read-tree/.test(line))).toBe(false)
  })

  it.each([
    ["an absolute HOME when XDG_CACHE_HOME is relative", "cache", "/home/me/", "/home/me/.cache/smithers"],
    ["no cache directory when neither is absolute", "", "home/me", ""]
  ])("stages under %s", async (_, xdg, home, cache) => {
    vi.stubEnv("XDG_CACHE_HOME", xdg)
    vi.stubEnv("HOME", home)
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["--get flows-checkpoint", { stdout: "abc123\n" }],
        ["stat -c %d", { stdout: "1\n2\n3\n\n" }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(script(spawns, "stat -c %d").at(-1)).toBe(cache)
    expect(failureOf(exit)?.message).toMatch(
      new RegExp(` nor /work nor ${cache === "" ? "a cache directory" : cache} is on the filesystem of `)
    )
  })
})
