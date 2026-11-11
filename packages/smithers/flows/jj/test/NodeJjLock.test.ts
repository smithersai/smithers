import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { nodeHost, NodeJjHost, type NodeJjHostService } from "../src/internal/NodeJjHost.ts"
import { Jj, RepositoryMutation } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { inTemporaryDirectory } from "./inTemporaryDirectory.ts"

// Faults enter through the `NodeJjHost` service: each case replaces the one
// host call it breaks, every other call stays real, and the public layer still
// spawns its CLI shim against real temporary directories.
const withHost = (overrides: Partial<NodeJjHostService>) =>
  Effect.provideService(NodeJjHost, { ...nodeHost, ...overrides })
const errno = (code: string) => Object.assign(new Error(code), { code })
/** `fault` answers the first call; every later call is the real one. */
const once = <Args extends ReadonlyArray<unknown>, A>(
  real: (...args: Args) => Promise<A>,
  fault: (...args: Args) => Promise<A>
) => {
  let spent = false
  return (...args: Args): Promise<A> => {
    if (spent) return real(...args)
    spent = true
    return fault(...args)
  }
}
// Fail the next read of one directory; every other read stays real.
const failReaddirOnce = (target: string, code: string) => {
  let failed = false
  return (path: string): Promise<Array<string>> => {
    if (failed || path !== target) return nodeHost.readdir(path)
    failed = true
    return Promise.reject(errno(code))
  }
}

/** The jj workspace holding this package, or the package itself in a git-only checkout. */
const checkoutOf = (from: string): string => {
  for (let directory = from;; directory = dirname(directory)) {
    if (existsSync(join(directory, ".jj"))) return directory
    if (dirname(directory) === directory) return from
  }
}
const checkout = checkoutOf(fileURLToPath(new URL("..", import.meta.url)))

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flows-jj-lock-")))
      await mkdir(join(root, ".jj", "repo"), { recursive: true })
      await mkdir(join(root, "nested"))
      const binary = join(root, "jj-shim")
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
printf '%s\\n' "$*" >> calls
: > started
echo $$ > child-pid.tmp
mv child-pid.tmp child-pid
while [ -f hold ]; do /bin/sleep 0.01; done
# Git diff, its path metadata, and revert's changed paths describe an empty change.
if [ "$1" = "diff" ]; then exit 0; fi
if [ "$1" = op ]; then echo 0abc; else printf "0abc\\nkkkk\\n"; fi
`
      )
      await chmod(binary, 0o755)
      const previous = process.env.SMITHERS_JJ_PATH
      process.env.SMITHERS_JJ_PATH = binary
      return { root, previous }
    }),
    // These live cases assert lock semantics. NodeJjVersion covers startup
    // latency under the test clock; allow preflight the full test watchdog here.
    ({ root }) => use(root).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)),
    ({ root, previous }) =>
      Effect.promise(async () => {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previous
        await rm(root, { recursive: true, force: true })
      })
  )

const until = (predicate: () => Promise<boolean>) =>
  Effect.retry(Effect.promise(predicate).pipe(Effect.filterOrFail((ready) => ready)), {
    times: 3_000,
    schedule: Schedule.spaced(10)
  })

describe("NodeJj repository locks", () => {
  it.effect("times out a held fence without starting the waiting operation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const acquired = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never))
        ))
        yield* Deferred.await(acquired)
        let ran = false
        const waiter = yield* Effect.forkChild(
          NodeJj.withRepositoryMutation(
            "apply",
            root,
            Effect.sync(() => {
              ran = true
            })
          ).pipe(Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30), Effect.flip)
        )
        yield* TestClock.adjust(31)
        expect(yield* Fiber.join(waiter)).toMatchObject({ cause: { code: "lock_timeout" } })
        expect(ran).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        yield* Fiber.interrupt(holder)
        yield* NodeJj.withRepositoryMutation("apply", root, Effect.void)
      })
    ))

  it.effect("serves the same fences as the RepositoryMutation service", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const mutation = yield* RepositoryMutation
        const held = yield* mutation.run(
          "apply",
          root,
          Effect.sync(() => existsSync(join(root, ".jj", "repo", "smithers.lock")))
        )
        expect(held).toBe(true)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
      }).pipe(Effect.provide(NodeJj.layerRepositoryMutation))
    ))

  it.effect("allows an acquired operation to outlive the acquisition timeout", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const acquired = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<string>()
        const operation = yield* Effect.forkChild(
          NodeJj.withRepositoryMutation(
            "apply",
            root,
            Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(complete)))
          ).pipe(Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30))
        )
        yield* Deferred.await(acquired)
        yield* TestClock.adjust(31)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(true)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        yield* Deferred.succeed(complete, "completed")
        expect(yield* Fiber.join(operation)).toBe("completed")
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
      })
    ))

  it.live("releases both fences after SIGKILL of an acquired jj child", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const pending = yield* Effect.forkChild(jj.snapshot("killed").pipe(Effect.flip))
        yield* until(async () => existsSync(join(root, "child-pid")))
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(true)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        const pid = Number(yield* Effect.promise(() => readFile(join(root, "child-pid"), "utf8")))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        yield* Effect.sync(() => process.kill(pid, "SIGKILL"))
        expect(yield* Fiber.join(pending)).toMatchObject({ method: "snapshot" })
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        yield* Effect.promise(() => rm(join(root, "hold")))
        expect(
          (yield* jj.snapshot("after-kill").pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 1_000)
          )).commitId
        ).toBe("0abc")
      })
    ))

  it.effect("reaches lock assertions after fixture startup exceeds the production deadline", () =>
    fixture((root) =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          const gate = join(root, "version-gate")
          execFileSync("mkfifo", [gate])
          await writeFile(
            join(root, "jj-shim"),
            `#!/bin/sh
cd "\${0%/*}"
if [ "$1" = "--version" ]; then
  exec 3< version-gate
  echo ready > ready.tmp
  /bin/mv ready.tmp ready
  read version <&3
  echo "$version"
else
  : > started
  if [ "$1" = op ]; then echo 0abc; else printf "0abc\\nkkkk\\n"; fi
fi
`
          )
          return open(gate, "r+")
        }),
        (gate) =>
          Effect.acquireUseRelease(
            // The first operation runs the version probe before it takes a lock.
            Effect.flatMap(Effect.provide(Jj, NodeJj.layerAt(root)), (jj) =>
              Effect.forkChild(
                Effect.flip(jj.snapshot()).pipe(withHost({
                  rename: once(nodeHost.rename, () => Promise.reject(errno("EACCES")))
                }))
              )),
            (snapshotting) =>
              Effect.gen(function*() {
                yield* Effect.promise(async (signal) => {
                  for (;;) {
                    signal.throwIfAborted()
                    try {
                      await readFile(join(root, "ready"))
                      return
                    } catch (cause) {
                      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw cause
                      }
                    }
                  }
                })
                // The FIFO holds a real child; only the test clock advances.
                yield* TestClock.adjust(5_200)
                yield* Effect.promise(() => gate.writeFile("jj 0.39.0\n"))
                const error = yield* Fiber.join(snapshotting)
                expect(error).toMatchObject({ code: "unknown", module: "NodeJj", method: "snapshot" })
                expect(error.message).toContain("repository lock failed")
                expect(existsSync(join(root, "started"))).toBe(false)
              }),
            (snapshotting) => Fiber.interrupt(snapshotting)
          ),
        (gate) => Effect.promise(() => gate.close())
      )
    ))

  it.live("coordinates different workspaces sharing a store and bounds permit waits through cancellation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const secondary = join(root, "secondary")
        yield* Effect.promise(async () => {
          await mkdir(join(secondary, ".jj"), { recursive: true })
          await writeFile(join(secondary, ".jj", "repo"), join(root, ".jj", "repo"))
        })
        let started = false
        const first = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Effect.sync(() => {
            started = true
          }).pipe(Effect.andThen(Effect.never))
        ))
        yield* until(async () => started)
        const failure = yield* Effect.flip(
          NodeJj.withRepositoryMutation("apply", secondary, Effect.void).pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          )
        )
        expect(failure.cause?.code).toBe("lock_timeout")
        yield* Fiber.interrupt(first)
        yield* NodeJj.withRepositoryMutation("apply", secondary, Effect.void)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
      })
    ))

  for (const method of ["status", "root"] as const) {
    it.live(`bounds public ${method} before spawn and releases its waiting fence on cancellation`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const secondary = join(root, "secondary")
          yield* Effect.promise(async () => {
            await mkdir(join(secondary, ".jj"), { recursive: true })
            await writeFile(join(secondary, ".jj", "repo"), join(root, ".jj", "repo"))
          })
          let started = false
          const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
            "apply",
            root,
            Effect.sync(() => {
              started = true
            }).pipe(Effect.andThen(Effect.never))
          ))
          yield* until(async () => started)
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(secondary))
          const operation = method === "status" ? jj.status() : jj.root!(secondary)
          const failure = yield* Effect.flip(operation.pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          ))
          expect(failure).toMatchObject({ method, cause: { code: "lock_timeout" } })
          expect(existsSync(join(secondary, "started"))).toBe(false)
          const waiting = yield* Effect.forkChild(operation)
          yield* until(async () => existsSync(join(secondary, ".jj", "smithers.lock")))
          yield* Fiber.interrupt(waiting)
          expect(existsSync(join(secondary, ".jj", "smithers.lock"))).toBe(false)
          expect(existsSync(join(secondary, "started"))).toBe(false)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
          yield* Fiber.interrupt(holder)
          yield* operation
          expect(existsSync(join(secondary, "started"))).toBe(true)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        })
      ))
  }

  it.live("fences root on its actual directory independently of the bound workspace", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const other = join(root, "other")
        yield* Effect.promise(() => mkdir(join(other, ".jj", "repo"), { recursive: true }))
        let held = false
        const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Effect.sync(() => {
            held = true
          }).pipe(Effect.andThen(Effect.never))
        ))
        yield* until(async () => held)
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* jj.root!(other)
        expect(existsSync(join(other, "started"))).toBe(true)
        expect(existsSync(join(root, "started"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        expect(existsSync(join(other, ".jj", "repo", "smithers.lock"))).toBe(false)
        yield* Fiber.interrupt(holder)
      })
    ))

  for (const code of ["EACCES", "ENOENT"]) {
    it.live(`refuses a ${code} store-pointer inspection failure before CLI spawn and releases both fences`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const secondary = join(root, "secondary")
          const pointer = join(secondary, ".jj", "repo")
          yield* Effect.promise(async () => {
            await mkdir(join(secondary, ".jj"), { recursive: true })
            await writeFile(pointer, join(root, ".jj", "repo"))
          })
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(secondary))
          // Resolving the store for its fence reads the pointer as well; only a
          // read made once both fences are held is the config inspection.
          const fenced: Array<string> = []
          const failure = yield* Effect.flip(
            jj.status().pipe(withHost({
              readFileSync: (path) => {
                if (!existsSync(join(root, ".jj", "repo", "smithers.lock"))) return nodeHost.readFileSync(path)
                fenced.push(path)
                throw errno(code)
              }
            }))
          )
          expect(failure).toMatchObject({ code: "unknown", method: "status", cause: { code, message: code } })
          expect(failure.message).toContain("could not inspect repository configuration")
          expect(fenced).toEqual([pointer])
          expect(existsSync(join(secondary, "started"))).toBe(false)
          expect(existsSync(join(secondary, ".jj", "smithers.lock"))).toBe(false)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        })
      ))
  }

  it.live("leaves the CLI to report operations outside a workspace", () =>
    fixture((root) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => rm(join(root, ".jj"), { recursive: true }))
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
      })
    ))

  it.live("finds a repository from a nested directory", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(join(root, "nested")))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
      })
    ))

  for (const cause of [errno("EACCES"), null, "filesystem failure", {}]) {
    it.effect(`reports an acquisition failure as a typed lock error: ${String(cause)}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const error = yield* Effect.flip(
            jj.snapshot().pipe(withHost({
              rename: once(nodeHost.rename, () => Promise.reject(cause))
            }))
          )
          expect(error).toMatchObject({ code: "unknown", module: "NodeJj", method: "snapshot" })
          expect(error.message).toContain("repository lock failed")
          expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["repo"])
        })
      ))
  }

  for (const code of ["ENOTEMPTY", "EEXIST"]) {
    it.live(`retries a lock that disappeared after contention (${code})`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const snapshot = yield* jj.snapshot().pipe(withHost({
            rename: once(nodeHost.rename, () => Promise.reject(errno(code))),
            readdir: failReaddirOnce(join(root, ".jj", "smithers.lock"), "ENOENT")
          }))
          expect(snapshot.commitId).toBe("0abc")
        })
      ))
  }

  it.live("reports unreadable lock ownership without running a mutation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const failure = yield* Effect.flip(
          jj.snapshot().pipe(withHost({
            rename: once(nodeHost.rename, () => Promise.reject(errno("ENOTEMPTY"))),
            readdir: failReaddirOnce(join(root, ".jj", "smithers.lock"), "EACCES")
          }))
        )
        expect(failure.message).toContain("EACCES")
        expect(existsSync(join(root, "started"))).toBe(false)
      })
    ))

  it.live("tolerates another reclaimer removing the dead owner's entry and directory", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, `${hostname()}-2147483647-dead`), "")
        })
        const snapshot = yield* jj.snapshot().pipe(withHost({
          unlink: once(nodeHost.unlink, async (path) => {
            await unlink(path)
            throw errno("ENOENT")
          }),
          rmdir: once(nodeHost.rmdir, async (path) => {
            await rmdir(path)
            throw errno("ENOENT")
          })
        }))
        expect(snapshot.commitId).toBe("0abc")
      })
    ))

  it.live.runIf(existsSync("/proc/self/stat"))(
    "reclaims a lock an earlier incarnation of this PID left behind",
    () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const lock = join(root, ".jj", "smithers.lock")
          // A restarted container's PID 1 is alive under the crashed owner's
          // PID; only its start time tells the two incarnations apart.
          yield* Effect.promise(async () => {
            await mkdir(lock)
            await writeFile(join(lock, `${hostname()}-${process.pid}-s1-crashed`), "")
          })
          const snapshot = yield* jj.snapshot().pipe(Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 5_000))
          expect(snapshot.commitId).toBe("0abc")
          expect(existsSync(lock)).toBe(false)
        })
      )
  )

  it.live("records the owner's start time and keeps a same-PID owner it cannot date", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const lock = join(root, ".jj", "smithers.lock")
        const owner = `${hostname()}-${process.pid}-s1-undated`
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, owner), "")
        })
        // Unreadable procfs for this process, an unparsable record for the
        // owner's PID: neither proves the owner a different incarnation.
        const readProc = (path: string) => {
          if (path === "/proc/self/stat") return Promise.reject(errno("ENOENT"))
          if (path === `/proc/${process.pid}/stat`) return Promise.resolve("garbage")
          return nodeHost.readFile(path)
        }
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const refused = yield* Effect.flip(
          jj.snapshot().pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30),
            withHost({ readFile: readProc })
          )
        )
        expect(refused.message).toContain("timed out waiting")
        expect(yield* Effect.promise(() => readdir(lock))).toEqual([owner])
      })
    ))

  it.live("removes lock candidates killed waiters left and keeps live or unclaimed ones", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const candidate = (directory: string, name: string, owner?: string) =>
          Effect.promise(async () => {
            await mkdir(join(directory, `.smithers-lock-${name}`))
            if (owner !== undefined) await writeFile(join(directory, `.smithers-lock-${name}`, owner), "")
          })
        const workspace = join(root, ".jj")
        const store = join(root, ".jj", "repo")
        yield* candidate(workspace, "dead00", `${hostname()}-2147483647-dead00`)
        yield* candidate(store, "dead01", `${hostname()}-2147483647-dead01`)
        yield* candidate(workspace, "live00", `${hostname()}-${process.pid}-live00`)
        yield* candidate(workspace, "foreign", `remote-${hostname()}-2147483647-foreign`)
        yield* candidate(workspace, "empty0")
        yield* Effect.promise(() => writeFile(join(workspace, ".smithers-lock-file"), ""))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
        expect((yield* Effect.promise(() => readdir(workspace))).sort()).toEqual([
          ".smithers-lock-empty0",
          ".smithers-lock-file",
          ".smithers-lock-foreign",
          ".smithers-lock-live00",
          "repo"
        ])
        expect(yield* Effect.promise(() => readdir(store))).toEqual([])
      })
    ))

  for (const code of ["ENOENT", "EACCES"]) {
    it.live(`${code === "ENOENT" ? "skips" : "reports"} a lock candidate that cannot be read (${code})`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const vanished = join(root, ".jj", ".smithers-lock-gone00")
          yield* Effect.promise(() => mkdir(vanished))
          const snapshot = jj.snapshot().pipe(withHost({ readdir: failReaddirOnce(vanished, code) }))
          if (code === "ENOENT") {
            expect((yield* snapshot).commitId).toBe("0abc")
          } else {
            expect((yield* Effect.flip(snapshot)).message).toContain("EACCES")
            expect(existsSync(join(root, "started"))).toBe(false)
          }
        })
      ))
  }

  for (const code of ["ENOTEMPTY", "EEXIST"]) {
    it.live(`does not delete a replacement lock during stale recovery (${code})`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const lock = join(root, ".jj", "smithers.lock")
          const replacement = join(lock, `${hostname()}-${process.pid}-replacement`)
          yield* Effect.promise(async () => {
            await mkdir(lock)
            await writeFile(join(lock, `${hostname()}-2147483647-dead`), "")
          })
          const pending = yield* Effect.forkChild(
            jj.snapshot().pipe(withHost({
              rmdir: once(nodeHost.rmdir, async () => {
                await writeFile(replacement, "")
                throw errno(code)
              })
            }))
          )
          yield* until(async () => existsSync(replacement))
          yield* Fiber.interrupt(pending)
          expect(existsSync(replacement)).toBe(true)
          expect(existsSync(join(root, "started"))).toBe(false)
        })
      ))
  }

  for (const operation of ["unlink", "rmdir"] as const) {
    it.live(`keeps the result if lock release fails at ${operation}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const snapshot = yield* jj.snapshot().pipe(withHost({
            [operation]: once(nodeHost[operation], () => Promise.reject(errno("EACCES")))
          }))
          expect(snapshot.commitId).toBe("0abc")
        })
      ))
  }

  for (
    const [owner, code] of [
      [`${hostname()}-2147483647-denied`, "EPERM"],
      [`remote-${hostname()}-2147483647-foreign`, "ESRCH"],
      ["2147483647-legacy", "ESRCH"]
    ]
  ) {
    it.effect(`preserves an owner whose death cannot be established locally: ${owner}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const lock = join(root, ".jj", "smithers.lock")
          yield* Effect.promise(async () => {
            await mkdir(lock)
            await writeFile(join(lock, owner!), "")
          })
          // The owner is inspected once its directory has been read, and, for a
          // local PID, once that PID has been probed.
          const kills: Array<readonly [number, number]> = []
          let inspected!: () => void
          const inspection = new Promise<void>((resolve) => {
            inspected = resolve
          })
          const pending = yield* Effect.forkChild(Effect.flip(
            jj.snapshot().pipe(
              Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30),
              withHost({
                kill: (pid, signal) => {
                  kills.push([pid, signal])
                  inspected()
                  throw errno(code!)
                },
                readdir: async (path) => {
                  const names = await nodeHost.readdir(path)
                  if (path === lock && code !== "EPERM") inspected()
                  return names
                }
              })
            )
          ))
          yield* Effect.promise(() => inspection)
          yield* TestClock.adjust(31)
          expect((yield* Fiber.join(pending)).message).toContain("timed out waiting")
          expect(existsSync(join(lock, owner!))).toBe(true)
          if (code === "EPERM") expect(kills).toContainEqual([2147483647, 0])
          else expect(kills).toEqual([])
        })
      ))
  }

  it.live("times out on unknown ownership without removing the lock", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, "unknown-owner"), "")
        })
        const refused = yield* Effect.flip(
          jj.snapshot().pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          )
        )
        expect(refused.message).toContain("timed out waiting")
        expect(refused.cause).toMatchObject({ name: "JjInternalFault", code: "lock_timeout" })
        expect(existsSync(join(lock, "unknown-owner"))).toBe(true)
      })
    ))

  it.live("releases the lock after cancelling an active snapshot", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const pending = yield* Effect.forkChild(jj.snapshot("cancelled"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        yield* Fiber.interrupt(pending)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        yield* Effect.promise(() => rm(join(root, "hold")))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
      })
    ))

  it.live("cancels a waiter without deleting another live owner's lock", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, `${hostname()}-${process.pid}-other`), "")
        })
        const pending = yield* Effect.forkChild(
          Effect.flatMap(Jj, (jj) => jj.restore("5a7ed")).pipe(Effect.provide(NodeJj.layerAt(root)))
        )
        yield* until(async () => (await readdir(join(root, ".jj"))).some((name) => name.startsWith(".smithers-lock-")))
        yield* Fiber.interrupt(pending)
        expect((yield* Effect.promise(() => readdir(lock))).sort()).toEqual([`${hostname()}-${process.pid}-other`])
        expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["repo", "smithers.lock"])
        expect(existsSync(join(root, "started"))).toBe(false)
      })
    ))

  it.live("fences an unbound layer run from a temporary directory there, never on this checkout", () =>
    fixture((root) =>
      Effect.gen(function*() {
        // The shim runs while its operation holds both fences, so it sees
        // whether the lock it names is held at that moment.
        const shim = (lock: string) =>
          Effect.promise(() =>
            writeFile(
              join(root, "jj-shim"),
              `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
pwd > "${root}/cwd"
if [ -e "${lock}" ]; then : > "${root}/held"; else rm -f "${root}/held"; fi
`
            )
          )
        const status = Effect.flatMap(Effect.provide(Jj, NodeJj.layer), (jj) => jj.status())
        // Positive control: run from a jj workspace, the unbound layer holds its lock.
        yield* shim(join(root, ".jj", "smithers.lock"))
        const previous = process.cwd()
        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.chdir(root)),
          () => status,
          () => Effect.sync(() => process.chdir(previous))
        )
        expect(existsSync(join(root, "held"))).toBe(true)
        expect((yield* Effect.promise(() => readFile(join(root, "cwd"), "utf8"))).trim()).toBe(root)
        // The suites' unbound cases run this way: away from the checkout's `.jj`.
        yield* shim(join(checkout, ".jj", "smithers.lock"))
        const directory = yield* inTemporaryDirectory(Effect.gen(function*() {
          const cwd = process.cwd()
          yield* status
          return cwd
        }))
        expect(existsSync(join(root, "held"))).toBe(false)
        expect((yield* Effect.promise(() => readFile(join(root, "cwd"), "utf8"))).trim()).toBe(directory)
        expect(process.cwd()).toBe(previous)
      })
    ))

  it.live("holds snapshot, restore, diff and revert together across separately built layers", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const first = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const second = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const snapshot = yield* Effect.forkChild(first.snapshot("held"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        const followers = yield* Effect.forkChild(
          Effect.all([second.restore("5a7ed"), second.diff("5a7ed", "@"), second.revert!("5a7ed")], {
            concurrency: "unbounded"
          })
        )
        yield* Effect.sleep("100 millis")
        expect((yield* Effect.promise(() => readFile(join(root, "calls"), "utf8"))).trim().split("\n")).toHaveLength(1)
        yield* Effect.promise(() => rm(join(root, "hold")))
        yield* Fiber.join(snapshot)
        yield* Fiber.join(followers)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
      })
    ))
})
