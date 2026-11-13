import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { writeGeneratedFile } from "../src/GeneratedFile.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform === "win32").each(["unsupported", "sync", "close", "both"])(
  "reports directory durability failures after publication: %s",
  async (fault) => {
    const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-generated-sync-")))
    roots.push(root)
    const syncFailure = Object.assign(new Error("directory sync failed"), {
      code: fault === "unsupported" ? "EINVAL" : "EIO"
    })
    const closeFailure = Object.assign(new Error("directory close failed"), { code: "EIO" })
    let closed = 0
    const io: typeof Fs = {
      ...Fs,
      open: async (...args) => {
        const handle = await Fs.open(...args)
        if (args[0] !== root || args[1] !== "r") return handle
        return {
          ...handle,
          sync: async () => {
            if (fault !== "close") throw syncFailure
            await handle.sync()
          },
          close: async () => {
            await handle.close()
            closed++
            if (fault === "close" || fault === "both") throw closeFailure
          }
        } as Fs.FileHandle
      }
    }
    const operation = Effect.runPromise(
      writeGeneratedFile(root, { path: "output", contents: "complete\n" })
        .pipe(Effect.provideService(PublicationFileSystem, io))
    )
    if (fault === "unsupported") await expect(operation).resolves.toBeUndefined()
    else await expect(operation).rejects.toThrow(fault === "close" ? "directory close failed" : "directory sync failed")
    expect(closed).toBe(1)
    expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("complete\n")
    expect(await Fs.readdir(root)).toEqual(["output"])
  }
)
