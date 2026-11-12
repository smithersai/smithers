import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Option, Stream } from "effect"
import type { BigIntStats } from "node:fs"
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import * as Native from "../src/internal/AtomicFileSystemHost.ts"
import { usableExecutable } from "../src/internal/AtomicFileSystemTransport.ts"

const roots: Array<string> = []
const temporary = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-config-")))
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const request: KernelFileSystem.AtomicRequest = { operation: "exists", path: "/a" }
const execute = (options: AtomicFileSystem.Options, input = request) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId].execute(input)
  }).pipe(Effect.provide(AtomicFileSystem.layerWith(options)))
const refused = (options: AtomicFileSystem.Options, input = request) =>
  Effect.runPromise(Effect.flip(execute(options, input)))

describe("atomic helper configuration admission", () => {
  it.each(["win32", "linux"] as const)(
    "watches the %s path and reports event paths relative to the directory named",
    async (platform) => {
      const root = await temporary()
      const named = join(root, "SHORT~1")
      await mkdir(join(root, "long"))
      await symlink(join(root, "long"), named)
      const host = { ...Native.nodeHost, platform }
      let settled = false
      const event = Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) => Stream.runHead(Native.watch(host, fileSystem)(named)))
          .pipe(
            Effect.provide(NodeFileSystem.layer)
          )
      ).finally(() => {
        settled = true
      })
      // The watcher starts asynchronously; write until it reports a change.
      while (!settled) {
        await writeFile(join(root, "long", "changed.txt"), "changed")
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
      expect(Option.getOrThrow(await event).path).toBe("changed.txt")
      // Only the Windows branch resolves the name before the watcher stats it, so only it names realPath.
      const missing = join(root, "missing")
      const failure = await Effect.runPromise(
        Effect.flip(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => Stream.runHead(Native.watch(host, fileSystem)(missing)))
            .pipe(
              Effect.provide(NodeFileSystem.layer)
            )
        )
      )
      expect(failure.reason).toMatchObject({ _tag: "NotFound", method: platform === "win32" ? "realPath" : "stat" })
    }
  )

  it("uses native canonical root spelling and preserves root resolution failures", async () => {
    const root = await temporary()
    const resolveRoot = (path: string) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(path))
        .pipe(Effect.provide(AtomicFileSystem.layerWith({})))
    expect(await Effect.runPromise(resolveRoot(root))).toBe(await realpath(root))
    const absent = join(root, "missing")
    expect(await Effect.runPromise(Effect.flip(resolveRoot(absent)))).toMatchObject({
      reason: { _tag: "NotFound", method: "realPath", pathOrDescriptor: absent, syscall: "realpath" }
    })
    const unavailable = Native.realPath({
      ...Native.nodeHost,
      realpath: () => Promise.reject(new Error("root path unavailable"))
    })
    expect(await Effect.runPromise(Effect.flip(unavailable(root)))).toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("root path unavailable") }
    })
  })

  it("pins exact BigInt identities and preserves a failed root observation", async () => {
    const root = await temporary()
    const actual = await stat(root, { bigint: true })
    const identify = (path: string) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return yield* (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
          .identifyRoot!(path)
      }).pipe(Effect.provide(AtomicFileSystem.layerWith({})))
    expect(await Effect.runPromise(identify(root))).toBe(`${actual.dev}:${actual.ino}`)
    // 2^53 + 1 is the first inode a Number cannot hold.
    const wide = Native.identifyRoot({
      ...Native.nodeHost,
      stat: async () => ({ ...actual, dev: 7n, ino: 9007199254740993n }) as BigIntStats
    })
    expect(await Effect.runPromise(wide(root))).toBe("7:9007199254740993")
    const unavailable = Native.identifyRoot({
      ...Native.nodeHost,
      stat: () => Promise.reject(new Error("root stat unavailable"))
    })
    expect(await Effect.runPromise(Effect.flip(unavailable(root)))).toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("root stat unavailable") }
    })
    const absent = join(root, "absent")
    expect(await Effect.runPromise(Effect.flip(identify(absent)))).toMatchObject({
      reason: { _tag: "NotFound", method: "stat", pathOrDescriptor: absent, syscall: "stat" }
    })
  })

  it.each(
    [
      [{ limits: { content: 0 } }, "limit_invalid", /content limit must be a positive integer/],
      [{ limits: { request: 256 * 1024 * 1024 + 1 } }, "limit_invalid", /request limit must be a positive integer/],
      [
        { limits: { batchSize: KernelFileSystem.maxBatchSize + 1 } },
        "limit_invalid",
        /batchSize limit must be no greater/
      ],
      [{ concurrency: 0 }, "concurrency_invalid", /concurrency must be a positive integer/],
      [{ concurrency: 1.5 }, "concurrency_invalid", /concurrency must be a positive integer/],
      [{ timeoutMs: 0 }, "timeout_invalid", /timeoutMs must be a positive integer/],
      [{ timeoutMs: 2_147_483_648 }, "timeout_invalid", /timeoutMs must be a positive integer/]
    ] as const
  )("rejects invalid settings before spawning: %j", async (options, code, message) => {
    const before = AtomicFileSystem.helperSpawns()
    const error = await refused(options)
    expect(error).toMatchObject({ reason: { _tag: "BadArgument" } })
    // The typed configuration failure travels as the cause, with its stable code.
    const cause = (error.reason as { cause: unknown }).cause
    expect(cause).toBeInstanceOf(AtomicFileSystem.AtomicHelperError)
    expect(cause).toMatchObject({ _tag: "@smthrs/platform-node/AtomicHelperError", code })
    expect((cause as Error).message).toMatch(message)
    expect(AtomicFileSystem.helperSpawns()).toBe(before)
  })

  it("turns a throwing option getter into a typed refusal", async () => {
    expect(
      await refused({
        get limits(): never {
          throw "unavailable"
        }
      })
    ).toMatchObject({
      reason: { _tag: "BadArgument", description: "atomic helper limits are invalid" }
    })
  })

  it("rejects requests that cannot serialize or exceed their byte ceiling", async () => {
    const cyclic = { ...request, extra: {} }
    cyclic.extra = cyclic
    for (const input of [cyclic, { ...request, toJSON: () => undefined }]) {
      expect(await refused({}, input)).toMatchObject({
        reason: { _tag: "BadArgument", description: "atomic request is not serializable" }
      })
    }
    // A value JSON drops is refused with the tagged configuration error.
    expect(((await refused({}, { ...request, toJSON: () => undefined } as never)).reason as { cause: unknown }).cause)
      .toMatchObject({ _tag: "@smthrs/platform-node/AtomicHelperError", code: "request_not_serializable" })
    expect(await refused({ limits: { request: 1 } })).toMatchObject({ reason: { _tag: "BadArgument" } })
  })

  it("uses the fixed default when the host provides no executable override", async () => {
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", undefined)
    const result = await Effect.runPromise(Effect.exit(execute({})))
    // The default can be installed or absent; an unconfined request is refused either way.
    expect(result._tag).toBe("Failure")
  })

  it("refuses an unusable environment override without falling back or spawning", async () => {
    const root = await temporary()
    const missing = join(root, "missing-helper")
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", missing)
    const before = AtomicFileSystem.helperSpawns()
    const error = await refused({})
    expect(error.reason).toMatchObject({
      _tag: "PermissionDenied",
      method: "exists",
      pathOrDescriptor: "/a",
      description: expect.stringContaining(`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${missing}`)
    })
    expect(error.reason.description).toContain("cargo build --locked")
    expect(AtomicFileSystem.helperSpawns()).toBe(before)
  })

  it("resolves the helper a diagnostic reports as an operation would, without spawning it", async () => {
    const root = await temporary()
    const binary = join(root, "helper")
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const missing = join(root, "missing-helper")
    const before = AtomicFileSystem.helperSpawns()
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", binary)
    expect(AtomicFileSystem.resolveHelper()).toBe(binary)
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", missing)
    expect(() => AtomicFileSystem.resolveHelper()).toThrow(AtomicFileSystem.AtomicHelperError)
    expect(() => AtomicFileSystem.resolveHelper()).toThrow(`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${missing}`)
    expect(AtomicFileSystem.helperSpawns()).toBe(before)
  })

  it("gives an explicit executable precedence over the environment override", async () => {
    const root = await temporary()
    const explicit = join(root, "explicit-helper")
    const configured = join(root, "environment-helper")
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", configured)
    const before = AtomicFileSystem.helperSpawns()
    const error = await refused({ executable: explicit })
    expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "exists" })
    expect(error.reason.description).toContain(explicit)
    expect(error.reason.description).not.toContain(configured)
    expect(AtomicFileSystem.helperSpawns()).toBe(before)
  })

  it("rejects an environment helper supplied by the confined workspace", async () => {
    const root = await temporary()
    const binary = join(root, "helper")
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", binary)
    const before = AtomicFileSystem.helperSpawns()
    const error = await refused({}, { operation: "exists", path: join(root, "file"), boundaryRoot: root })
    expect(error.reason).toMatchObject({
      _tag: "PermissionDenied",
      method: "exists",
      description: expect.stringContaining(`outside the confined workspace: ${binary}`)
    })
    expect(AtomicFileSystem.helperSpawns()).toBe(before)
  })

  it("resolves absolute and relative symlinks without admitting workspace executables", async () => {
    const root = await temporary()
    const bin = join(root, "helper")
    await writeFile(bin, "#!/bin/sh\nexit 0\n")
    await chmod(bin, 0o755)
    const absolute = join(root, "absolute")
    const relative = join(root, "relative")
    await symlink(bin, absolute)
    await symlink("helper", relative)
    expect(usableExecutable(absolute, undefined)).toBe(bin)
    expect(usableExecutable(relative, undefined)).toBe(bin)
    const code = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        expect(error).toBeInstanceOf(AtomicFileSystem.AtomicHelperError)
        return (error as AtomicFileSystem.AtomicHelperError).code
      }
      throw new Error("expected a throw")
    }
    expect(code(() => usableExecutable("helper", undefined))).toBe("helper_path_invalid")
    expect(code(() => usableExecutable(root, undefined))).toBe("helper_not_regular_file")
    expect(code(() => usableExecutable(bin, root))).toBe("helper_inside_workspace")
    expect(code(() => usableExecutable(bin, bin))).toBe("helper_inside_workspace")
    expect(() => usableExecutable("helper", undefined)).toThrow("absolute path")
    await mkdir(join(root, "nested"))
    expect(usableExecutable(bin, join(root, "nested"))).toBe(bin)
    const loop = join(root, "loop")
    await symlink("loop", loop)
    expect(code(() => usableExecutable(loop, undefined))).toBe("helper_path_invalid")
    expect(() => usableExecutable(loop, undefined)).toThrow("too many symbolic links")
    expect(code(() => usableExecutable(`${root}/`, undefined))).toBe("helper_path_invalid")
  })
})
