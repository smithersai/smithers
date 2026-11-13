import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

it.runIf(process.platform !== "win32")(
  "retains recovery bytes when a file parent vanishes just before mode restoration",
  async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "generator-mode-race-")))
    const directory = Path.join(root, "nested")
    const file = Path.join(directory, "original")
    let backup: string | undefined
    let readsAfterRun = 0
    let removed = false
    await Fs.mkdir(directory)
    await Fs.writeFile(file, "original", { mode: 0o644 })
    const io = {
      ...Fs,
      mkdtemp: async (...args: Parameters<typeof Fs.mkdtemp>) => {
        const path = await Fs.mkdtemp(...args)
        backup = path as string
        return path
      },
      open: async (...args: Parameters<typeof Fs.open>) => {
        const handle = await Fs.open(...args)
        if (args[0] === file && await Fs.access(Path.join(root, "ran")).then(() => true, () => false)) {
          readsAfterRun++
          if (readsAfterRun === 2) {
            const close = handle.close.bind(handle)
            handle.close = async () => {
              await close()
              await Fs.rm(directory, { recursive: true })
              removed = true
            }
          }
        }
        return handle
      }
    } as typeof Fs
    try {
      const error = await Effect.runPromise(Effect.flip(
        Compose.checkGenerator({ workspaceRoot: root }, {
          changes: ["nested/original"],
          run: {
            cwd: ".",
            argv: [
              process.execPath,
              "-e",
              "const fs=require('node:fs');fs.chmodSync('nested/original',0o600);fs.writeFileSync('ran','ran')"
            ],
            env: {},
            secrets: [],
            expectedExitCodes: [0],
            timeoutMs: 5000
          }
        }).pipe(Effect.provideService(PublicationFileSystem, io))
      ))
      expect(removed).toBe(true)
      expect(error._tag).toBe("smithers-build/DriftError")
      if (error._tag !== "smithers-build/DriftError") throw new Error("expected restoration refusal")
      expect(error.message).toContain("declared output parent is missing during restore: nested/original")
      expect(backup).toBeDefined()
      expect(error.message).toContain(`generator backup retained at ${backup}`)
      expect(await Fs.readFile(Path.join(backup!, "files/nested/original"), "utf8")).toBe("original")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      if (backup !== undefined) await Fs.rm(backup, { recursive: true, force: true })
    }
  }
)
