/**
 * The checkpoint store's two halves, against a scripted process.
 *
 * `CheckpointsFixture.test.ts` drives the git half against a real repository;
 * this file pins the argv it spawns and the shape it answers with. The
 * relocation table it re-exports is pinned by `Relocate.test.ts`.
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import * as Relocate from "../src/Relocate.ts"

interface Response {
  readonly stdout?: string
  readonly exitCode?: number
}

/** Records every argv and answers each from a table keyed by a fragment. */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        const line = argv.join(" ")
        const scripted = responses.find(([fragment]) => line.includes(fragment))?.[1] ?? {}
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

const store = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>,
  options: Checkpoints.GitOptions = { root: "/work/repo" }
) => Effect.provide(Checkpoints.makeGit(options), host(spawns, responses))

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

/** The exact allocated path must be used for checkout, relocation and removal. */
const checkoutPath = (spawns: ReadonlyArray<ReadonlyArray<string>>) => {
  const path = spawns.find((argv) => argv.includes("add"))?.at(-2)
  expect(path).toMatch(/^\/work\/repo\/\.flows-checkpoints\/[a-z0-9-]+-[0-9a-f-]{36}$/)
  return path!
}

const checkout = (path: string, commit: string) => [
  `git -C /work/repo -c worktree.useRelativePaths=true worktree add --detach --force ${path} ${commit}`
]

/**
 * The repository-format read taken before every checkout, so the store can
 * restore exactly what stood if the checkout stamps the repository.
 */
const formatRead = [
  "git -C /work/repo config --local --get core.repositoryformatversion",
  "git -C /work/repo config --local --get extensions.relativeWorktrees"
]

describe("Checkpoints.makeGit capture", () => {
  it("records the working tree without touching the index or the worktree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { stdout: "abc123\n" }]])
      return yield* checkpoints.capture("cp-0-1")
    }))

    // `stash create` and nothing else. `add`, `read-tree` and `write-tree` all
    // write the repository's index, and the agent's own `git diff` — the run's
    // evidence — is read off that index.
    //
    // And the commit is named in config, never with a ref: a ref is history,
    // and a checkpoint holds the agent's own edit.
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-0-1",
      "git -C /work/repo config --local flows-checkpoint.cp-0-1 abc123"
    ])
    expect(snapshot).toMatchObject({ id: "cp-0-1", ref: "abc123" })
  })

  it("takes HEAD when the working tree has nothing of its own to record", async () => {
    // `stash create` prints nothing for a clean tree. That is not an error and
    // must not be read as one: the tree IS the commit it is sitting on.
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "" }],
        ["rev-parse", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-1-0")
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-1-0",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      "git -C /work/repo config --local flows-checkpoint.cp-1-0 head999"
    ])
    expect(snapshot.ref).toBe("head999")
  })

  it("refuses an id that could not safely become a ref or a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.capture("../../etc/passwd")
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when git could not record the tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { exitCode: 1 }]])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not record the working tree")
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
        ["config --local flows-checkpoint", { exitCode: 1 }]
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

  it("checks the tree out beside the repository and removes it however the call ends", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
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
    // The scripted host answers every unmatched command with exit 0, so the
    // format read reports the marker as already present — a repository that
    // legitimately uses relative worktrees — and the store rightly leaves the
    // format alone.
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo config --local --get flows-checkpoint.cp-0-1",
      ...formatRead,
      ...checkout(checkoutPath(spawns), "abc123"),
      `git -C /work/repo worktree remove --force ${checkoutPath(spawns)}`
    ])
  })

  it("removes the format stamp its own checkout wrote, before the call runs", async () => {
    // Git 2.48+ records the first relative checkout in the repository itself:
    // `extensions.relativeWorktrees = true`, `core.repositoryformatversion`
    // raised to 1. A pre-2.48 git that then opens the repository refuses it
    // whole — which on the r97 wave cost 15 of 45 benchmark runs every
    // in-container `git status` and `git diff` from the first `{ at: ctx.base }`
    // call onward. The repair must land before the relocated call, because the
    // call is the thing that runs git through the mount.
    const spawns: Array<ReadonlyArray<string>> = []
    let markerReads = 0
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get flows-checkpoint", { stdout: "abc123\n" }],
        ["--get core.repositoryformatversion", { stdout: "0\n" }],
        // Absent before the checkout, present after it: exactly what a
        // git 2.48+ relative `worktree add` leaves behind.
        ["--get extensions.relativeWorktrees", () => ({ exitCode: markerReads++ === 0 ? 1 : 0, stdout: "true\n" })]
      ])
      return yield* checkpoints.materialize(
        "cp-0-1",
        () => Effect.sync(() => spawns.push(["<the relocated call runs here>"]))
      )
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo config --local --get flows-checkpoint.cp-0-1",
      ...formatRead,
      ...checkout(checkoutPath(spawns), "abc123"),
      "git -C /work/repo config --local --get extensions.relativeWorktrees",
      "git -C /work/repo config --local --unset extensions.relativeWorktrees",
      "git -C /work/repo config --local core.repositoryformatversion 0",
      "<the relocated call runs here>",
      `git -C /work/repo worktree remove --force ${checkoutPath(spawns)}`
    ])
  })

  it("allocates a new path each time the same materialization effect runs", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const paths = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      const read = checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found.host))
      return [yield* read, yield* read]
    }))
    expect(paths[0]).not.toBe(paths[1])
    const worktrees = spawns.filter((argv) => argv.includes("worktree")).map((argv) => argv.join(" "))
    expect(worktrees).toEqual(paths.flatMap((path) => [
      ...checkout(path, "abc123"),
      `git -C /work/repo worktree remove --force ${path}`
    ]))
  })

  it("keeps the caller's process service inside the callback", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const caller = ChildProcessSpawner.makeNoop()
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => ChildProcessSpawner.ChildProcessSpawner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, caller)
      )
    }))
    expect(seen).toBe(caller)
  })

  it("removes the checkout when the call inside it fails", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.fail("the call failed"))
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    // A run killed at its wall-clock budget would otherwise leave a second
    // checkout of the whole repository inside the tree whose diff is its answer.
    expect(spawns.at(-1)?.join(" ")).toContain("worktree remove --force")
  })

  it("gives the container's name for the directory when the host declared one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]], {
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

    expect(spawns[0]?.join(" ")).toContain("refs/flows/capture-base^{commit}")
  })

  it("falls back to HEAD when no capture base was recorded", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["HEAD^", { stdout: "head999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/capture-base^{commit}",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      ...formatRead,
      ...checkout(checkoutPath(spawns), "head999"),
      `git -C /work/repo worktree remove --force ${checkoutPath(spawns)}`
    ])
  })

  it("takes only the declared base ref when the host named one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [], { root: "/work/repo", baseRef: "refs/flows/absent" })
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    })))

    // A declared ref that does not resolve is an error rather than a fallback:
    // a baseline against the wrong tree answers the question wrong, which is
    // worse than not answering it.
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/absent^{commit}"
    ])
  })

  it("refuses an id that could not safely become a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.materialize("../escape", () => Effect.void)
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when the checkout itself failed", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get", { stdout: "abc123\n" }],
        ["worktree add", { exitCode: 128 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toContain("Could not check out abc123")
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
        Effect.provide(host(spawns, [["stash create", { stdout: "abc123\n" }]]))
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
