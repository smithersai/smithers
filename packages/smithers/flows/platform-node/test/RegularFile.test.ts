import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as RegularFile from "../src/internal/RegularFile.ts"
import * as NodeHost from "../src/NodeHost.ts"

const withRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-regular-file-")))
  try {
    return await use(root)
  } finally {
    await Fs.chmod(root, 0o700)
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const contents = (opened: Effect.Effect<FileSystem.File, PlatformError.PlatformError, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const file = yield* opened
    const bytes = new Uint8Array(64)
    const read = Number(yield* file.read(bytes))
    return new TextDecoder().decode(bytes.subarray(0, read))
  })))

const refusal = (platform: NodeJS.Platform, path: string) =>
  Effect.runPromise(Effect.flip(Effect.scoped(RegularFile.open(platform, path))))

describe.skipIf(process.platform === "win32")("NodeHost.openRegularFile", () => {
  it("reads a regular file", async () => {
    await withRoot(async (root) => {
      const path = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(path, "lockfileVersion: '9.0'\n", "utf8")
      expect(await contents(NodeHost.openRegularFile(path))).toBe("lockfileVersion: '9.0'\n")
    })
  })

  it("refuses a FIFO without waiting for a writer", async () => {
    await withRoot(async (root) => {
      const path = NodePath.join(root, "pnpm-lock.yaml")
      execFileSync("mkfifo", [path], { timeout: 5_000 })
      const outcome = await Promise.race([
        refusal(process.platform, path),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000))
      ])
      expect(outcome).not.toBe("blocked")
      const error = outcome as PlatformError.PlatformError
      expect(error.reason._tag).toBe("BadResource")
      expect(error.message).toContain("expected a regular file")
    })
  }, 10_000)

  it("refuses a directory", async () => {
    await withRoot(async (root) => {
      expect((await refusal(process.platform, root)).reason._tag).toBe("BadResource")
    })
  })

  it("maps host open failures to PlatformError reasons", async () => {
    await withRoot(async (root) => {
      const file = NodePath.join(root, "file")
      await Fs.writeFile(file, "text", "utf8")
      expect((await refusal(process.platform, NodePath.join(root, "missing"))).reason._tag).toBe("NotFound")
      expect((await refusal(process.platform, NodePath.join(file, "child"))).reason._tag).toBe("Unknown")
      if (process.getuid?.() !== 0) {
        await Fs.chmod(file, 0o000)
        expect((await refusal(process.platform, file)).reason._tag).toBe("PermissionDenied")
      }
    })
  })

  it("opens the path itself and checks the opened file where FIFOs cannot stand on ordinary paths", async () => {
    await withRoot(async (root) => {
      const path = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(path, "lockfileVersion: '9.0'\n", "utf8")
      expect(await contents(RegularFile.open("win32", path))).toBe("lockfileVersion: '9.0'\n")
      expect((await refusal("win32", root)).reason._tag).toBe("BadResource")
    })
  })
})
