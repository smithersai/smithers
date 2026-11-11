import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null }
const runtime = Runtime.makeNoop("node", { requirement: "1.0.0", version: "1.0.0", platform })

describe("injected host failures", () => {
  it("journals a runtime spawner failure even when it has no message", async () => {
    const spawner = ChildProcessSpawner.make(() => Effect.fail("unavailable" as never))
    const error = await Effect.runPromise(
      Runtime.make("node", { requirement: "1.0.0", platform, environment: {} }).pipe(
        Effect.flatMap((service) => service.version),
        Effect.flip,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      )
    )
    expect(error.code).toBe("probe_failed")
    expect(error.message).toBe("node --version failed: unknown failure")
    expect(Schema.encodeUnknownSync(Schema.toCodecJson(Runtime.RuntimeError))(error)).toMatchObject({
      code: "probe_failed",
      cause: { name: "string", message: "unavailable" }
    })
  })

  it("keeps package-manager failures readable without invoking host string conversion or accessors", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-host-failures-")))
    let reads = 0
    const inherited = Object.create(Error.prototype)
    Object.defineProperty(inherited, "message", { value: undefined })
    const prototype = Object.create(Error.prototype)
    Object.defineProperty(prototype, "message", { value: "inherited message" })
    const inheritedMessage = Object.create(prototype)
    const accessor = Object.defineProperty({}, "message", {
      get: () => {
        reads += 1
        throw new Error("private")
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new Error("private")
      }
    })
    try {
      for (
        const [cause, message] of [
          ["", "unknown failure"],
          ["unavailable", "unavailable"],
          [7, "7"],
          [1n, "1"],
          [true, "true"],
          [Symbol("failure"), "Symbol(failure)"],
          [null, "unknown failure"],
          [undefined, "unknown failure"],
          [{ message: 7 }, "unknown failure"],
          [accessor, "unknown failure"],
          [proxy, "unknown failure"],
          [inherited, "unknown failure"],
          [inheritedMessage, "inherited message"]
        ] as const
      ) {
        const spawner = ChildProcessSpawner.make(() => Effect.fail(cause as never))
        const error = await Effect.runPromise(
          PackageManager.makePnpm({ requirement: "1.0.0", projectRoot: root, environment: {} }).pipe(
            Effect.flatMap((service) => service.version),
            Effect.flip,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Runtime.Runtime, runtime),
            Effect.provide(NodeServices.layer)
          )
        )
        expect(error.code).toBe("command_failed")
        expect(error.message).toBe(`pnpm --version failed: ${message}`)
        expect(Schema.encodeUnknownSync(Schema.toCodecJson(PackageManager.PackageManagerError))(error))
          .toMatchObject({ code: "command_failed", message: error.message })
      }
      expect(reads).toBe(0)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("refuses unreadable Windows shim stages before starting the manager", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shim-failures-")))
    try {
      await Fs.writeFile(NodePath.join(root, "pnpm.cmd"), "@node \"%~dp0\\pnpm.mjs\" %*")
      await Fs.writeFile(NodePath.join(root, "pnpm.mjs"), "throw new Error(\"must not spawn\")")
      const host = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
      for (const stage of ["exists", "stat", "readFileString"] as const) {
        const fault = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: stage,
          description: "shim is unreadable"
        })
        const fileSystem = {
          ...host,
          [stage]: (path: string) => path.endsWith("/pnpm.cmd") ? Effect.fail(fault) : host[stage](path)
        } as FileSystem.FileSystem
        const error = await Effect.runPromise(
          PackageManager.makePnpm({
            requirement: "1.0.0",
            projectRoot: root,
            environment: { PATH: root }
          }).pipe(
            Effect.flatMap((service) => service.version),
            Effect.flip,
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(
              Runtime.Runtime,
              Runtime.makeNoop("node", {
                requirement: "1.0.0",
                version: "1.0.0",
                executable: process.execPath,
                platform: { ...platform, os: "win32" }
              })
            ),
            Effect.provide(NodeServices.layer)
          )
        )
        expect(error.code, stage).toBe("environment_mismatch")
        expect(error.message, stage).toContain("cannot resolve")
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("refuses an uninspectable workspace configuration before probing", async () => {
    const host = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
    const fault = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists"
    })
    const fileSystem: FileSystem.FileSystem = {
      ...host,
      exists: (path) => path.endsWith("/pnpm-workspace.yaml") ? Effect.fail(fault) : Effect.succeed(false)
    }
    const error = await Effect.runPromise(
      PackageManager.makePnpm({ requirement: "1.0.0", projectRoot: "/workspace", environment: {} }).pipe(
        Effect.flatMap((service) => service.version),
        Effect.flip,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Runtime.Runtime, runtime),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(error.code).toBe("manifest_unreadable")
    expect(error.message).toContain("pnpm-workspace.yaml")
    expect(error.cause?.name).toBe("PlatformError")
  })
})

describe("host capability boundaries", () => {
  it("constructs an ambient runtime without a process global", async () => {
    const host = await Effect.runPromise(
      ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.provide(NodeServices.layer))
    )
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")!
    const executable = process.execPath
    let environment: unknown
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") environment = command.options.env
      return host.spawn(command)
    })
    let service: Runtime.Service
    try {
      Reflect.deleteProperty(globalThis, "process")
      service = Effect.runSync(
        Runtime.make("node", {
          requirement: ">=1",
          platform,
          executable
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      )
    } finally {
      Object.defineProperty(globalThis, "process", descriptor)
    }
    expect(await Effect.runPromise(service.verify)).toMatch(/^[0-9]+\./)
    expect(environment).toEqual({})
  })

  it("refuses the Windows default manager when the environment has no search path", async () => {
    const error = await Effect.runPromise(
      PackageManager.makePnpm({
        requirement: "1.0.0",
        projectRoot: "/workspace",
        environment: {}
      }).pipe(
        Effect.flatMap((service) => service.version),
        Effect.flip,
        Effect.provideService(FileSystem.FileSystem, {
          ...(await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))),
          exists: () => Effect.succeed(false)
        }),
        Effect.provideService(
          Runtime.Runtime,
          Runtime.makeNoop("node", {
            requirement: "1.0.0",
            version: "1.0.0",
            platform: { ...platform, os: "win32" }
          })
        ),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(error.code).toBe("environment_mismatch")
    expect(error.message).toContain("pnpm.cmd on PATH")
  })

  it("reads through a virtual filesystem without inode or timestamp metadata", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-metadata-")))
    try {
      await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfile")
      const host = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
      const crypto = NodeCrypto.layer
      const expected = await Effect.runPromise(
        PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(
          Effect.provide(NodeServices.layer),
          Effect.provide(crypto)
        )
      )
      const info = (value: FileSystem.File.Info): FileSystem.File.Info => ({
        ...value,
        ino: Option.none(),
        mtime: Option.none()
      })
      const toHost = (path: string) => root + path.slice("workspace".length)
      const fileSystem: FileSystem.FileSystem = {
        ...host,
        realPath: (path) => Effect.succeed(path),
        stat: (path) => host.stat(toHost(path)).pipe(Effect.map(info)),
        open: (path, options) =>
          host.open(toHost(path), options).pipe(Effect.map((file) =>
            new Proxy(file, {
              get: (target, property) => {
                const value = Reflect.get(target, property, target)
                if (property === "stat") return file.stat.pipe(Effect.map(info))
                return typeof value === "function" ? value.bind(target) : value
              }
            })
          ))
      }
      const actual = await Effect.runPromise(
        PackageManager.lockfileDigest("workspace", "pnpm-lock.yaml").pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provide(crypto)
        )
      )
      expect(actual).toBe(expected)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("reports an install process that cannot start after a successful version probe", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-start-failure-")))
    try {
      const host = await Effect.runPromise(
        ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.provide(NodeServices.layer))
      )
      const fault = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        description: "execution denied"
      })
      const spawner = { ...host, exitCode: () => Effect.fail(fault) }
      const error = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: ">=1",
          projectRoot: root,
          executable: process.execPath,
          environment: {}
        }).pipe(
          Effect.flatMap((service) => service.fetch),
          Effect.flip,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Runtime.Runtime, runtime),
          Effect.provide(NodeServices.layer)
        )
      )
      expect(error.code).toBe("command_failed")
      expect(error.message).toContain("pnpm fetch failed:")
      expect(error.cause?.name).toBe("PlatformError")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
