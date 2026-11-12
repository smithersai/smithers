// Test support: a branch's machine as its object holds it (worker/branch/Machine.ts `Box`), over a scratch checkout whose
// sessions are real local processes and whose storage is in memory: the stand-in for the Cloudflare container and its
// Durable Object storage (worker/BranchSandboxes.ts), whose real container the e2e suite drives. `@smthrs/sandbox`'s
// `SandboxTools` run their real scripts there. The box maps the container's `/home` onto a scratch directory, and it
// answers its root commands (provisioning a person's user, the idle probe) from the test, because they need root, tmux
// and Linux's /proc. worker/branch/Machine.test.ts and the command job's tests use it.
import { RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { Effect, Ref, Stream } from "effect"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import * as Machine from "../branch/Machine.ts"
import { commandsOver, Machines, ranOf } from "../branch/Machines.ts"

const { ProviderError } = RemoteChildProcessSpawner

const fromReadable = (readable: Readable) =>
  Stream.fromAsyncIterable(
    readable as AsyncIterable<Uint8Array>,
    (cause) => new ProviderError({ code: "unknown", message: String(cause) }),
  ).pipe(Stream.map((chunk) => new Uint8Array(chunk)))

/**
 * A session on the machine: `sh -c` in its checkout, with each person's `~/.smithers` in the container's `/home` at
 * `homes`, wherever the checkout itself is. Closing the session's scope kills its shell, as a dropped exec does.
 */
export const sessionAt = (workdir: string, homes: string): Sandbox.Session => ({
  id: "machine",
  remoteId: "machine",
  workdir,
  spawn: (command, options) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        spawn("sh", ["-c", command.replace(/'\/home\/([^/']+)\/\.smithers/g, `'${homes}/$1/.smithers`)], {
          cwd: options.cwd ?? workdir,
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
      ),
      (child) => Effect.sync(() => child.exitCode === null && child.kill("SIGKILL")),
    ).pipe(Effect.map((child) => {
      const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 137)))
      if (options.stdin !== undefined) child.stdin!.end(options.stdin)
      return {
        stdout: fromReadable(child.stdout!),
        stderr: fromReadable(child.stderr!),
        exitCode: Effect.promise(() => exited),
      }
    })),
  readFile: () => Effect.die("the tools read through commands"),
  writeFile: () => Effect.die("the tools write through commands"),
})

/** A session whose machine can't run anything. */
export const down = (workdir: string): Sandbox.Session => ({
  ...sessionAt(workdir, workdir),
  spawn: () => Effect.fail(new ProviderError({ code: "unavailable", message: "down" })),
})

/** A session whose commands start and never exit, as an exec whose exit is lost. */
export const hung = (workdir: string): Sandbox.Session => ({
  ...sessionAt(workdir, workdir),
  spawn: () => Effect.succeed({ stdout: Stream.never, stderr: Stream.never, exitCode: Effect.never }),
})

/** The object's storage, in memory. */
export const memory = (entries: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(entries))
  const store: Machine.Store<never> = {
    get: <A>(key: string) => Effect.sync(() => map.get(key) as A | undefined),
    put: (key, value) => Effect.sync(() => void map.set(key, value)),
    delete: (key) => Effect.sync(() => map.delete(key)),
    list: <A>(prefix: string) =>
      Effect.sync(() => new Map([...map].filter(([key]) => key.startsWith(prefix))) as ReadonlyMap<string, A>),
  }
  return { map, store }
}

export interface BoxOptions {
  /** The machine's checkout. */
  readonly workdir: string
  /** Where the container's `/home` is. */
  readonly homes: string
  readonly store?: ReturnType<typeof memory>
  /** What a root command answers: `provision` and `probe` by their argv. 0 unless set. */
  readonly root?: (argv: ReadonlyArray<string>) => Effect.Effect<number, unknown>
  /** The users whose sessions can't run anything. */
  readonly downFor?: ReadonlyArray<string>
  /** The users whose sessions' commands never exit. */
  readonly hungFor?: ReadonlyArray<string>
}

/** A machine's box over its checkout, recording every root command, session and stop. */
export const boxAt = (options: BoxOptions) => {
  const { homes, workdir } = options
  const { map, store } = options.store ?? memory()
  const runs: Array<{ readonly argv: ReadonlyArray<string>; readonly user: string }> = []
  const sessions: Array<string> = []
  const state = { running: true, destroyed: 0 }
  const box: Machine.Box<never> = {
    writing: Ref.makeUnsafe(false),
    sessionAs: (user) =>
      Effect.sync(() => {
        sessions.push(user)
        return options.downFor?.includes(user) === true
          ? down(workdir)
          : options.hungFor?.includes(user) === true
          ? hung(workdir)
          : sessionAt(workdir, homes)
      }),
    run: (argv, user) =>
      Effect.suspend(() => {
        runs.push({ argv, user })
        return options.root?.(argv) ?? Effect.succeed(0)
      }),
    running: Effect.sync(() => state.running),
    destroy: Effect.sync(() => {
      state.destroyed++
      state.running = false
    }),
    storage: store,
  }
  return { box, workdir, homes, map, store: { map, store }, runs, sessions, state }
}

/**
 * The branches' `Machines` over one `box`, as its object answers them at generation `generation` while the box runs:
 * the tools (`Machine.tool`) and the commands (`Machine.command`) run on its real processes. It never sleeps.
 */
export const machinesOn = (box: Machine.Box<never>, generation = 1) =>
  Machines.of({
    tool: (_branch, ownerId, callId, call) => Effect.flatMap(Machine.tool(box, { ownerId, callId, call, generation }), ranOf),
    commands: (_branch, ownerId, callId) =>
      commandsOver(
        (request) =>
          Effect.flatMap(Effect.orDie(box.running), (running) =>
            Machine.command(box, { ownerId, request, generation: running || request.op === "start" ? generation : undefined })),
        () => Effect.void,
        callId,
      ),
    sleepIfIdle: () => Effect.die("a test machine never sleeps"),
  })
