/**
 * `ContainerSandbox.existing` over a transport double that runs each command
 * on this host, in the directory the request names.
 *
 * The real-engine suite beside it proves the std flows on a real container;
 * this one holds the session to the contract on every host, CI included, and
 * pins how each failure is reported: a transport that refuses, a spawner
 * that cannot start, a guest without `base64`, and a read the probe refuses.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-existing-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const isRoot = globalThis.process.getuid?.() === 0

/** Runs the request's program here, in its `cwd`; `env` lands on the double's own process. */
const here = (env?: Record<string, string>): ContainerSandbox.Transport => ({
  exec: (request) =>
    request.container === "task"
      ? Effect.succeed({
        file: "/bin/sh",
        args: [
          "-c",
          "cd \"$1\" || exit 125; shift; exec \"$@\"",
          "sh",
          request.cwd ?? root,
          request.file,
          ...request.args
        ],
        ...env === undefined ? {} : { env }
      })
      : Effect.fail(new Error(`no container named ${request.container}`))
})

const session = (
  workdir: string,
  transport: ContainerSandbox.Transport = here(),
  container = "task",
  hostEnvironment?: Record<string, string | undefined>
) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return ContainerSandbox.existing({ container, workdir, spawner, transport, hostEnvironment })
  }).pipe(Effect.provide(rawPlatform))

const directory = (name: string): string => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

const output = (process: { readonly stdout: Stream.Stream<Uint8Array, unknown> }) =>
  Stream.mkString(Stream.decodeText(process.stdout))

describe("ContainerSandbox.existing", () => {
  it.effect("preserves default bootstrap inheritance and accepts an empty environment", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.LC_SANDBOX_BOOTSTRAP
          process.env.LC_SANDBOX_BOOTSTRAP = "host-default"
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.LC_SANDBOX_BOOTSTRAP
            else process.env.LC_SANDBOX_BOOTSTRAP = previous
          })
      )
      for (const hostEnvironment of [undefined, {}]) {
        const existing = yield* session(directory("default-environment"), here(), "task", hostEnvironment)
        const actual = yield* Effect.scoped(Effect.flatMap(
          existing.spawn("printf '%s' \"$LC_SANDBOX_BOOTSTRAP\"", {}),
          output
        ))
        expect(actual).toBe(hostEnvironment === undefined ? "host-default" : "")
      }
    })))

  it.effect("takes bootstrap environment from the composition and overlays transport declarations", () =>
    Effect.gen(function*() {
      const existing = yield* session(directory("environment"), here({ LANG: "C", HOME: "/transport-home" }), "task", {
        HOME: "/configured-home",
        USER: "configured-user",
        LANG: "configured-locale",
        GH_TOKEN: "withheld",
        EXTRA: "withheld"
      })
      const actual = yield* Effect.scoped(Effect.flatMap(
        existing.spawn("printf '%s:%s:%s:%s:%s' \"$HOME\" \"$USER\" \"$LANG\" \"$GH_TOKEN\" \"$EXTRA\"", {}),
        output
      ))
      expect(actual).toBe("/transport-home:configured-user:C::")
    }))

  it.effect(
    "passes the sandbox conformance suite over a transport that reaches this host",
    () =>
      Effect.gen(function*() {
        const workdir = directory("conformance")
        const existing = yield* session(workdir)
        const violations = yield* SandboxConformance.check({ acquire: () => Effect.succeed(existing) })
        expect(violations).toEqual([])
      }),
    60_000
  )

  it.effect("runs nothing until asked, then runs each command in the workdir or the cwd it names", () =>
    Effect.gen(function*() {
      const workdir = directory("cwd")
      directory("cwd/sub")
      const calls: Array<string | undefined> = []
      const counted: ContainerSandbox.Transport = {
        exec: (request) => Effect.tap(here().exec(request), () => Effect.sync(() => calls.push(request.cwd)))
      }
      const existing = yield* session(workdir, counted)
      expect(calls).toEqual([])
      expect(existing).toMatchObject({ id: "task", remoteId: "task", workdir })
      const at = yield* Effect.scoped(Effect.flatMap(existing.spawn("pwd", { cwd: "sub" }), output))
      const plain = yield* Effect.scoped(Effect.flatMap(existing.spawn("pwd", {}), output))
      expect([at.trim(), plain.trim()]).toEqual([join(workdir, "sub"), workdir])
      expect(calls).toEqual([join(workdir, "sub"), workdir])
    }))

  it.effect("reads through the file system with the reasons the platform gives", () =>
    Effect.gen(function*() {
      const workdir = directory("reads")
      writeFileSync(join(workdir, "text.txt"), "naïve ü 日本語\n")
      mkdirSync(join(workdir, "folder"))
      const files = Sandbox.fileSystem(yield* session(workdir))
      expect(yield* files.readFileString("text.txt")).toBe("naïve ü 日本語\n")
      const reasons = yield* Effect.forEach(["folder", "absent.txt"], (path) =>
        Effect.map(Effect.flip(files.readFile(path)), (error) => error.reason._tag))
      expect(reasons).toEqual(["BadResource", "NotFound"])
      const absent = yield* Effect.flip(files.readFile("absent.txt"))
      expect(absent.message).toContain("nothing is there in the container")
    }))

  it.effect.skipIf(isRoot)(
    "reports a file the container's user may not read as PermissionDenied",
    () =>
      Effect.gen(function*() {
        const workdir = directory("denied")
        writeFileSync(join(workdir, "secret.txt"), "secret\n")
        chmodSync(join(workdir, "secret.txt"), 0o000)
        const existing = yield* session(workdir)
        const error = yield* Effect.flip(Sandbox.fileSystem(existing).readFile("secret.txt"))
        expect(error.reason._tag).toBe("PermissionDenied")
        const provider = yield* Effect.flip(existing.readFile(`${workdir}/secret.txt`))
        expect(provider).toMatchObject({ code: "unknown" })
        expect(provider.message).toContain("may not read it")
        chmodSync(join(workdir, "secret.txt"), 0o644)
      })
  )

  it.effect("reports a guest without base64, and one whose base64 answers garbage", () =>
    Effect.gen(function*() {
      const workdir = directory("tools")
      writeFileSync(join(workdir, "text.txt"), "text\n")
      const bin = directory("tools-bin")
      writeFileSync(join(bin, "base64"), "#!/bin/sh\nprintf '%s' '*not base64*'\n", { mode: 0o755 })
      const missing = Sandbox.fileSystem(yield* session(workdir, here({ PATH: join(root, "nothing") })))
      const garbled = yield* session(workdir, here({ PATH: `${bin}:/usr/bin:/bin` }))
      const unknown = yield* Effect.flip(missing.readFile("text.txt"))
      expect(unknown.reason._tag).toBe("Unknown")
      expect(unknown.message).toContain("base64")
      const invalid = yield* Effect.flip(Sandbox.fileSystem(garbled).readFile("text.txt"))
      expect(invalid.reason._tag).toBe("InvalidData")
      expect(yield* Effect.flip(garbled.readFile(`${workdir}/text.txt`))).toMatchObject({ code: "unknown" })
    }))

  it.effect("names the container and the transport's reason when the container cannot be reached", () =>
    Effect.gen(function*() {
      const workdir = directory("unreachable")
      const refused = yield* session(workdir, here(), "elsewhere")
      const spawn = yield* Effect.flip(Effect.scoped(refused.spawn("true", {})))
      expect(spawn).toMatchObject({ code: "unavailable" })
      expect(spawn.message).toBe("the container elsewhere could not be reached: no container named elsewhere")
      expect(yield* Effect.flip(refused.readFile("/x"))).toMatchObject({ code: "unavailable" })
      expect((yield* Effect.flip(Sandbox.fileSystem(refused).readFile("x"))).reason._tag).toBe("Unknown")
      const silent: ContainerSandbox.Transport = { exec: () => Effect.fail("refused") }
      const quiet = yield* Effect.flip(Effect.scoped((yield* session(workdir, silent)).spawn("true", {})))
      expect(quiet.message).toBe("the container task could not be reached")
      const absent: ContainerSandbox.Transport = {
        exec: () => Effect.succeed({ file: join(root, "no-such-transport"), args: [] })
      }
      const unstarted = yield* Effect.flip(Effect.scoped((yield* session(workdir, absent)).spawn("true", {})))
      expect(unstarted).toMatchObject({ code: "unavailable" })
    }))

  it.effect("writes bytes unchanged and reports a write the guest refuses", () =>
    Effect.gen(function*() {
      const workdir = directory("writes")
      writeFileSync(join(workdir, "occupied"), "a file, not a directory")
      const existing = yield* session(workdir)
      const bytes = new Uint8Array([0, 1, 2, 195, 188, 253, 254, 255, 10])
      yield* existing.writeFile(`${workdir}/deep/er/bytes.bin`, bytes)
      expect(Array.from(yield* existing.readFile(`${workdir}/deep/er/bytes.bin`))).toEqual(Array.from(bytes))
      const refused = yield* Effect.flip(existing.writeFile(`${workdir}/occupied/child`, bytes))
      expect(refused).toMatchObject({ code: "unknown" })
      expect(refused.message).toContain(`the container could not write ${workdir}/occupied/child`)
      // A bare name has no parent to create, and lands in the workdir.
      yield* existing.writeFile("bare.bin", bytes)
      expect(Array.from(yield* existing.readFile(`${workdir}/bare.bin`))).toEqual(Array.from(bytes))
    }))

  it.effect("serves the host surface a sealed host binds the file flows over", () =>
    Effect.gen(function*() {
      const workdir = directory("host")
      const services = yield* Sandbox.hostContext(yield* session(workdir))
      const files = yield* Effect.provide(
        Effect.gen(function*() {
          return yield* FileSystem.FileSystem
        }),
        services
      )
      yield* files.writeFileString("made.txt", "made")
      expect(yield* files.readFileString(`${workdir}/made.txt`)).toBe("made")
    }).pipe(Effect.scoped))
})
