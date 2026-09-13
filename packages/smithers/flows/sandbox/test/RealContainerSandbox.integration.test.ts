import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Stream } from "effect"
import * as Scope from "effect/Scope"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { afterAll } from "vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

// The suite drives a real container engine. It skips where none is running —
// the same posture as the real-CLI e2e suites — so a laptop without Docker and
// a CI shard without a daemon stay green without pretending to have proven
// anything.
const engineAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
const missingEngine = engineAvailable
  ? undefined
  : "no container engine answers `docker info` on this host"
const image = "alpine:3.20"

// Session keys are suite-unique so a concurrently running vitest worker
// cannot collide on container names, and every name this suite can create is
// force-removed at the end even when a test failed mid-acquire.
const keys = ["conformance-suite", "machine-boundary", "crash-reattach", "host-bundle"].map(
  (name) => `sandbox-it-${process.pid}-${name}`
)
const nameOf = (key: string): string => `smthrs-sbx-${sessionSlug(key)}`
afterAll(() => {
  if (!engineAvailable) return
  for (const key of keys) {
    spawnSync("docker", ["rm", "--force", nameOf(key)], { stdio: "ignore" })
  }
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const provider = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return ContainerSandbox.make({ spawner, image })
}).pipe(Effect.provide(platform))

// The conformance suite gives every check its own session so a check that
// leaves one unusable cannot decide the next, which costs this backend eleven
// container starts. Start is the one variable step and its cost is the
// engine's, not the provider's: on the development machine the same `docker
// start` was measured at 1 second on an idle engine and 30 seconds with many
// containers resident, while `create`, `exec`, and `rm` stayed near 50ms
// throughout. The ceiling is therefore sized for the loaded engine, because a
// timeout under load would report a conforming provider as broken.
const conformanceBudget = 900_000
const budget = 180_000

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(engineAvailable)("ContainerSandbox against a real engine", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!engineAvailable)("ContainerSandbox against a real engine", () => {
  it.effect(
    "passes the sandbox conformance suite, the kill check included, against real containers",
    () =>
      Effect.gen(function*() {
        const container = yield* provider
        const violations = yield* SandboxConformance.check(container, {
          session: keys[0]!,
          provides: { kill: true, ping: true }
        })
        expect(violations).toEqual([])
      }),
    conformanceBudget
  )

  it.effect("really places file IO and processes on the container's machine", () =>
    Effect.gen(function*() {
      const container = yield* provider
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* container.acquire(keys[1]!)
          const files = Sandbox.fileSystem(session)
          // The image pins the answer: whatever this host runs, the session's
          // /etc/os-release is Alpine's.
          const release = yield* files.readFileString("/etc/os-release")
          expect(release).toContain("Alpine Linux")
          // A file a guest process writes is the file the session reads, and
          // a binary payload survives the exec transport in both directions.
          const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0])
          yield* session.writeFile(`${session.workdir}/in.bin`, bytes)
          const copied = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn("cp in.bin out.bin && wc -c < out.bin", {})
              const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
              yield* process.exitCode
              return stdout
            })
          )
          expect(copied.trim()).toBe(String(bytes.length))
          expect(Array.from(yield* session.readFile(`${session.workdir}/out.bin`))).toEqual(Array.from(bytes))
          // The probe dialect against real busybox sh.
          yield* files.makeDirectory(`${session.workdir}/nested/deep`, { recursive: true })
          yield* files.rename(`${session.workdir}/out.bin`, `${session.workdir}/nested/deep/out.bin`)
          expect(yield* files.readDirectory(session.workdir, { recursive: true })).toEqual([
            "in.bin",
            "nested",
            "nested/deep",
            "nested/deep/out.bin"
          ])
          const stat = yield* files.stat(`${session.workdir}/nested/deep/out.bin`)
          expect(stat.type).toBe("File")
          expect(stat.size).toBe(BigInt(bytes.length))
          // Exclusive writes preserve an existing entry of every kind and
          // leave no private staging directories behind after a collision.
          yield* files.writeFile("private.bin", bytes, { flag: "wx", mode: 0o600 })
          expect((yield* files.stat("private.bin")).mode & 0o7777).toBe(0o600)
          yield* Effect.scoped(Effect.flatMap(
            session.spawn("ln -s private.bin alias.bin; ln -s absent dangling.bin; mkfifo pipe.bin; mkdir dir.bin", {}),
            (process) => process.exitCode
          ))
          for (const path of ["private.bin", "alias.bin", "dangling.bin", "pipe.bin", "dir.bin"]) {
            const error = yield* Effect.flip(files.writeFile(path, new Uint8Array([99]), { flag: "wx" }))
            expect(error.reason._tag).toBe("AlreadyExists")
          }
          expect(yield* files.readFile("private.bin")).toEqual(bytes)
          expect((yield* files.readDirectory(session.workdir)).some((name) => name.startsWith(".smithers-write.")))
            .toBe(false)
          yield* Effect.scoped(
            Effect.flatMap(session.spawn("ln -s nested/deep/out.bin link.bin", {}), (process) => process.exitCode)
          )
          expect(yield* files.readLink(`${session.workdir}/link.bin`)).toBe("nested/deep/out.bin")
          expect(yield* files.realPath(`${session.workdir}/link.bin`)).toBe(
            `${session.workdir}/nested/deep/out.bin`
          )
          yield* files.remove(`${session.workdir}/nested`, { recursive: true })
          expect(yield* files.exists(`${session.workdir}/nested`)).toBe(false)
        })
      )
    }), budget)

  it.effect("reattaches the machine a crashed run left behind, workspace intact", () =>
    Effect.gen(function*() {
      const container = yield* provider
      const key = keys[2]!
      // A crash is a scope whose finalizers never ran: leak the first scope on
      // purpose, then acquire the same key again.
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(container.acquire(key), Scope.Scope, leaked)
      yield* first.writeFile(`${first.workdir}/survivor.txt`, new TextEncoder().encode("still here"))
      const survived = yield* Effect.scoped(
        Effect.gen(function*() {
          const second = yield* container.acquire(key)
          const bytes = yield* second.readFile(`${second.workdir}/survivor.txt`)
          return new TextDecoder().decode(bytes)
        })
      )
      expect(survived).toBe("still here")
      // The reacquire's release already removed the container; closing the
      // leaked scope must tolerate that.
      const closed = yield* Effect.exit(Scope.close(leaked, Exit.void))
      expect(Exit.isSuccess(closed)).toBe(true)
    }), budget)

  it.effect("serves the host bundle from the container through layerHost", () =>
    Effect.gen(function*() {
      const container = yield* provider
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        yield* files.writeFileString("/workspace/tool-input.txt", "for the guest tool")
        const answer = yield* spawner.string(
          ChildProcess.make("tr a-z A-Z < /workspace/tool-input.txt && echo && uname -s", { shell: true })
        )
        return answer
      }).pipe(Effect.provide(Sandbox.layerHost(container, { session: keys[3]! })))
      expect(outcome).toBe("FOR THE GUEST TOOL\nLinux\n")
    }), budget)
})
