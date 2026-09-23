import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem } from "effect"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
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
  it.each([
    { limits: { content: 0 } },
    { limits: { request: 256 * 1024 * 1024 + 1 } },
    { concurrency: 0 },
    { concurrency: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 }
  ])("rejects invalid settings before spawning: %j", async (options) => {
    const before = AtomicFileSystem.helperSpawns()
    expect(await refused(options)).toMatchObject({ reason: { _tag: "BadArgument" } })
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
    expect(await refused({ limits: { request: 1 } })).toMatchObject({ reason: { _tag: "BadArgument" } })
  })

  it("uses the fixed default when the host provides no executable override", async () => {
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", undefined)
    const result = await Effect.runPromise(Effect.exit(execute({})))
    // The default can be installed or absent; an unconfined request is refused either way.
    expect(result._tag).toBe("Failure")
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
    expect(() => usableExecutable("helper", undefined)).toThrow("absolute path")
    expect(() => usableExecutable(root, undefined)).toThrow("not a regular file")
    expect(() => usableExecutable(bin, root)).toThrow("outside the confined workspace")
    expect(() => usableExecutable(bin, bin)).toThrow("outside the confined workspace")
    await mkdir(join(root, "nested"))
    expect(usableExecutable(bin, join(root, "nested"))).toBe(bin)
    const loop = join(root, "loop")
    await symlink("loop", loop)
    expect(() => usableExecutable(loop, undefined)).toThrow("too many symbolic links")
  })
})
