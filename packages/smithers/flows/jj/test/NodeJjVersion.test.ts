import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import { execFileSync, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

// Observe cleanup at the real spawn boundary. Every invocation still starts
// the fixture executable, and every signal is forwarded to the actual child.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process")

const withVersion = <A, E, R>(version: string, use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "flows-jj-version-"))
      const binary = join(root, "jj")
      await writeFile(join(root, "version"), version)
      await writeFile(
        binary,
        `#!/bin/sh
cd "\${0%/*}"
if [ "$1" = "--version" ]; then
  echo probe >> probes
  /bin/cat version
else
  echo operation >> operations
  echo ok
fi
`
      )
      await chmod(binary, 0o755)
      const previous = process.env.SMITHERS_JJ_PATH
      process.env.SMITHERS_JJ_PATH = binary
      return { root, previous }
    }),
    ({ root }) => use(root),
    ({ root, previous }) =>
      Effect.promise(async () => {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previous
        await rm(root, { recursive: true, force: true })
      })
  )

// Publish the PID atomically, then block on a FIFO until NodeJj kills the child.
// Readiness retries real asynchronous file reads, without native watchers,
// sleeps, or a wall-clock budget. Cancellation stops the readiness loop too.
const withBlockedProbe = <A, E, R>(
  root: string,
  use: (probe: {
    readonly ready: Effect.Effect<number>
    readonly kills: Array<NodeJS.Signals | number | undefined>
  }) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      execFileSync("mkfifo", [join(root, "hold")])
      await writeFile(
        join(root, "jj"),
        `#!/bin/sh
cd "\${0%/*}"
echo probe >> probes
echo $$ > pid.tmp
/bin/mv pid.tmp pid
exec /bin/cat hold
`
      )
      const kills: Array<NodeJS.Signals | number | undefined> = []
      vi.mocked(spawn).mockImplementationOnce((...args) => {
        const child = actualChildProcess.spawn(...args)
        const kill = child.kill.bind(child)
        child.kill = (signal) => {
          kills.push(signal)
          return kill(signal)
        }
        return child
      })
      const ready = Effect.promise(async (signal) => {
        for (;;) {
          signal.throwIfAborted()
          try {
            return Number(await readFile(join(root, "pid"), "utf8"))
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
          }
        }
      })
      return { ready, kills }
    }),
    use,
    () => Effect.sync(() => vi.mocked(spawn).mockReset())
  )

// Both the real deadline regression and its early-budget negative control use
// these exact assertions. A pending fiber alone can already be in cleanup.
const verifyStartupBudget = (budget: number) =>
  withVersion("jj 0.39.0", (root) =>
    Effect.gen(function*() {
      const binary = join(root, "jj")
      const original = yield* Effect.promise(() => readFile(binary, "utf8"))
      yield* withBlockedProbe(root, ({ ready, kills }) =>
        Effect.acquireUseRelease(
          Effect.forkChild(
            Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root))).pipe(
              Effect.provideService(NodeJj.StartupTimeoutMs, budget)
            )
          ),
          (building) =>
            Effect.gen(function*() {
              const pid = yield* ready
              expect(pid).toBeGreaterThan(0)
              yield* TestClock.adjust(499)
              expect(kills, "startup probe cleanup before 500 ms").toEqual([])
              expect(building.pollUnsafe()).toBeUndefined()
              yield* TestClock.adjust(1)
              expect(kills).toEqual(["SIGKILL"])
              const error = yield* Fiber.join(building)
              expect(error).toMatchObject({
                code: "unknown",
                module: "NodeJj",
                method: "version",
                command: `${binary} --version`,
                cause: { name: "TimeoutError", code: "ETIMEDOUT" }
              })
              expect(() => process.kill(pid, 0)).toThrow()
              yield* Effect.promise(() => writeFile(binary, original))
              yield* Effect.provide(Jj, NodeJj.layerAt(root)).pipe(
                Effect.provideService(NodeJj.StartupTimeoutMs, 2_000)
              )
              expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\nprobe\n")
            }),
          // A rejected negative control must reap its real child as well.
          (building) => Fiber.interrupt(building)
        ))
    }))

describe("NodeJj version requirement", () => {
  it.effect("keeps a relative override bound to the host executable in another repository", () =>
    withVersion("jj 0.39.0", (trusted) =>
      withVersion("jj 0.39.0", (repository) =>
        Effect.gen(function*() {
          const cwd = process.cwd()
          yield* Effect.promise(() => mkdir(join(trusted, "bin")))
          yield* Effect.promise(() => mkdir(join(repository, "bin")))
          yield* Effect.promise(() =>
            writeFile(
              join(trusted, "bin", "jj"),
              "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.39.0\"; else echo trusted; fi\n",
              { mode: 0o755 }
            )
          )
          yield* Effect.promise(() =>
            writeFile(join(repository, "bin", "jj"), "#!/bin/sh\necho REPOSITORY_EXECUTABLE_RAN\n", { mode: 0o755 })
          )
          process.chdir(trusted)
          process.env.SMITHERS_JJ_PATH = "./bin/jj"
          try {
            const jj = yield* Effect.provide(Jj, NodeJj.layerAt(repository))
            expect(yield* jj.status()).toBe("trusted\n")
          } finally {
            process.chdir(cwd)
          }
        }))))

  it.effect("keeps an existing layer on the verified PATH executable after PATH changes", () =>
    withVersion("jj 0.39.0", (trusted) =>
      withVersion("jj 0.38.0", (old) =>
        Effect.gen(function*() {
          const previousPath = process.env.PATH
          delete process.env.SMITHERS_JJ_PATH
          try {
            process.env.PATH = trusted
            const jj = yield* Effect.provide(Jj, NodeJj.layerAt(trusted))
            process.env.PATH = old
            expect(yield* jj.status()).toBe("ok\n")
            expect(yield* Effect.promise(() => readFile(join(trusted, "operations"), "utf8"))).toBe("operation\n")
            yield* Effect.promise(() => expect(stat(join(old, "operations"))).rejects.toMatchObject({ code: "ENOENT" }))
          } finally {
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
          }
        }))))

  it.effect("builds before the repository parent exists and runs after it is created", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const repository = join(root, "missing", "repository")
        yield* Effect.gen(function*() {
          const jj = yield* Jj
          yield* Effect.promise(() => expect(stat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" }))
          yield* Effect.promise(() => mkdir(repository, { recursive: true }))
          expect(yield* jj.status()).toBe("ok\n")
        }).pipe(Effect.provide(NodeJj.layerAt(repository)))
        yield* Effect.provide(Jj, NodeJj.layerAt(join(root, "another", "repository")))
        expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
      })))

  it.effect("refuses an unsupported binary even before the repository exists", () =>
    withVersion("jj 0.38.0", (root) =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(join(root, "missing", "repository"))))
        expect(error.code).toBe("unsupported_version")
      })))

  it.effect("reports an executable that loses permission after the version probe", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => chmod(join(root, "jj"), 0o644))
        const error = yield* Effect.flip(jj.status())
        expect(error).toMatchObject({ code: "unknown", method: "status" })
        expect(error.cause).toMatchObject({ code: "EACCES" })
      })))

  it.effect("does not reuse an unresolved command's failure after PATH changes", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const previousPath = process.env.PATH
        const previousJj = process.env.SMITHERS_JJ_PATH
        delete process.env.SMITHERS_JJ_PATH
        try {
          process.env.PATH = ""
          const missing = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
          expect(missing.code).toBe("not_installed")
          yield* Effect.promise(() => chmod(join(root, "jj"), 0o644))
          process.env.PATH = root
          // Explicit non-executable candidates still reach spawn for EACCES diagnostics.
          process.env.SMITHERS_JJ_PATH = join(root, "jj")
          const refused = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
          expect(refused.code).toBe("unknown")
        } finally {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
          if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousJj
        }
      })))

  it.effect("retries an interrupted probe when another layer is built", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const binary = join(root, "jj")
        const original = yield* Effect.promise(() => readFile(binary, "utf8"))
        yield* withBlockedProbe(root, ({ ready }) =>
          Effect.gen(function*() {
            const building = yield* Effect.forkChild(Effect.provide(Jj, NodeJj.layerAt(root)))
            const pid = yield* ready
            expect(pid).toBeGreaterThan(0)
            yield* Fiber.interrupt(building)
            expect(() => process.kill(pid, 0)).toThrow()
            yield* Effect.promise(() => writeFile(binary, original))
            yield* Effect.provide(Jj, NodeJj.layerAt(root))
            expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\nprobe\n")
          }))
      })))

  it.effect("retries a timed out probe with a new layer's budget", () => verifyStartupBudget(500))

  it.effect("rejects a 1 ms startup budget against the 500 ms deadline", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(verifyStartupBudget(1))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          name: "AssertionError",
          message: expect.stringContaining("startup probe cleanup before 500 ms"),
          actual: ["SIGKILL"],
          expected: []
        })
      }
    }))

  for (const budget of [0, -1, Infinity, NaN, 2_147_483_648]) {
    it.effect(`rejects invalid startup budget ${budget} before spawning`, () =>
      withVersion("jj 0.39.0", (root) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root))).pipe(
            Effect.provideService(NodeJj.StartupTimeoutMs, budget)
          )
          expect(error).toMatchObject({ method: "version", cause: { code: "EINVAL" } })
          yield* Effect.promise(() => expect(stat(join(root, "probes"))).rejects.toMatchObject({ code: "ENOENT" }))
        })))
  }

  it.effect("shares a completed probe across concurrent and subsequent layer builds", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        yield* Effect.all(
          Array.from({ length: 3 }, () => Effect.provide(Jj, NodeJj.layerAt(root))),
          { concurrency: "unbounded" }
        )
        yield* Effect.provide(Jj, NodeJj.layer)
        expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
      })))

  it.effect("checks each executable selected by PATH independently", () =>
    withVersion("jj 0.39.0", (first) =>
      withVersion("jj 0.38.0", (second) =>
        Effect.gen(function*() {
          const previousPath = process.env.PATH
          const previousJj = process.env.SMITHERS_JJ_PATH
          delete process.env.SMITHERS_JJ_PATH
          try {
            process.env.PATH = first
            yield* Effect.provide(Jj, NodeJj.layer)
            process.env.PATH = second
            const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
            expect(error.code).toBe("unsupported_version")
            process.env.PATH = first
            yield* Effect.provide(Jj, NodeJj.layer)
            expect(yield* Effect.promise(() => readFile(join(first, "probes"), "utf8"))).toBe("probe\n")
            expect(yield* Effect.promise(() => readFile(join(second, "probes"), "utf8"))).toBe("probe\n")
          } finally {
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
            if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
            else process.env.SMITHERS_JJ_PATH = previousJj
          }
        }))))

  for (const version of ["jj 0.9.0", "jj 0.38.9", "unrecognized version"]) {
    it.effect(`rejects ${version} while constructing the layer`, () =>
      withVersion(version, (root) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root)))
          expect(error).toMatchObject({ code: "unsupported_version", method: "version", command: "jj --version" })
          expect(error.message).toContain("0.39.0")
          expect(error.message).toContain(version)
          const again = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root)))
          expect(again).toMatchObject({ code: "unsupported_version", message: error.message })
          expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
        })))
  }

  for (const version of ["jj 0.39.0", "jj 0.39.1", "jj 0.40.0", "jj 1.0.0"]) {
    it.effect(`accepts ${version} before exposing repository operations`, () =>
      withVersion(version, (root) =>
        Effect.gen(function*() {
          yield* Effect.gen(function*() {
            const jj = yield* Jj
            expect(yield* jj.status()).toBe("ok\n")
            expect(yield* jj.status()).toBe("ok\n")
          }).pipe(Effect.provide(NodeJj.layerAt(root)))
          expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
          expect(yield* Effect.promise(() => readFile(join(root, "operations"), "utf8"))).toBe("operation\noperation\n")
        })))
  }
})
