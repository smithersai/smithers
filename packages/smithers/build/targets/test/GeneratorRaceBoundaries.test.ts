import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "generator-race-boundary-")))
  await Fs.mkdir(Path.join(root, "out/nested"), { recursive: true })
  await Fs.writeFile(Path.join(root, "out/nested/original"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload = (
  changes: ReadonlyArray<string>,
  script = "require('node:fs').writeFileSync('ran', 'unexpected')"
): Compose.GenerateCheckPayload => ({
  changes,
  run: {
    cwd: ".",
    argv: [process.execPath, "-e", script],
    env: {},
    secrets: [],
    expectedExitCodes: [0],
    timeoutMs: 5000
  }
})
const failure = async (value: Compose.GenerateCheckPayload, io: typeof Fs = Fs) => {
  const error = await Effect.runPromise(Effect.flip(
    Compose.checkGenerator({ workspaceRoot: root }, value)
      .pipe(Effect.provideService(PublicationFileSystem, io))
  ))
  if (error._tag !== "smithers-build/DriftError") throw new Error("expected a generator drift refusal")
  return error
}

describe("generator snapshot directory races", () => {
  it("refuses a canonical root replaced during its metadata observation", async () => {
    let observed = false
    const parked = root + "-parked"
    const io = {
      ...Fs,
      lstat: async (...args: Parameters<typeof Fs.lstat>) => {
        if (args[0] === root && !observed) {
          observed = true
          await Fs.rename(root, parked)
          try {
            await Fs.writeFile(root, "replacement")
            return await Fs.lstat(...args)
          } finally {
            await Fs.rm(root, { force: true })
            await Fs.rename(parked, root)
          }
        }
        return Fs.lstat(...args)
      }
    } as typeof Fs
    const error = await failure(payload(["out"]), io)
    expect(observed).toBe(true)
    expect(error.message).toContain("canonical workspace root was replaced while outputs were checked")
    expect(await Fs.readFile(Path.join(root, "out/nested/original"), "utf8")).toBe("original")
    await expect(Fs.stat(Path.join(root, "ran"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses an output directory whose parent disappears before enumeration", async () => {
    const parent = Path.join(root, "out")
    let observations = 0
    const io = {
      ...Fs,
      lstat: async (...args: Parameters<typeof Fs.lstat>) => {
        if (args[0] === parent && ++observations === 2) await Fs.rm(parent, { recursive: true })
        return Fs.lstat(...args)
      }
    } as typeof Fs
    const error = await failure(payload(["out/nested"]), io)
    expect(observations).toBe(2)
    expect(error.message).toContain("declared output directory disappeared while it was being read: out/nested")
    await expect(Fs.stat(Path.join(root, "ran"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a discovered directory replaced with a file before enumeration", async () => {
    const output = Path.join(root, "out")
    let discovered = false
    let replaced = false
    const io = {
      ...Fs,
      lstat: async (...args: Parameters<typeof Fs.lstat>) => {
        if (args[0] === root && discovered && !replaced) {
          replaced = true
          await Fs.rm(output, { recursive: true })
          await Fs.writeFile(output, "replacement")
        }
        const stats = await Fs.lstat(...args)
        if (args[0] === output && stats.isDirectory()) discovered = true
        return stats
      }
    } as typeof Fs
    const error = await failure(payload(["out"]), io)
    expect(replaced).toBe(true)
    expect(error.message).toContain("declared output directory was replaced while it was being read: out")
    await expect(Fs.stat(Path.join(root, "ran"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

it("retains recoverable bytes when a generator removes an undeclared parent", async () => {
  const error = await failure(payload(["out/nested/original"], "require('node:fs').rmSync('out', { recursive: true })"))
  expect(error.message).toContain("declared output parent is missing during restore: out/nested/original")
  const backup = /generator backup retained at (.+)$/.exec(error.message)?.[1]
  expect(backup).toBeDefined()
  try {
    expect(await Fs.readFile(Path.join(backup!, "files/out/nested/original"), "utf8")).toBe("original")
  } finally {
    await Fs.rm(backup!, { recursive: true, force: true })
  }
})
