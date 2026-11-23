import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, rmSync } from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, test } from "vitest"
import { BrowserChildProcessSpawner, BrowserFileSystem } from "../src/index.ts"

const root = mkdtempSync(join(tmpdir(), "smthrs-platform-browser-bench-"))
const fs = BrowserFileSystem.make(NodeFsPromises as unknown as BrowserFileSystem.ZenFsPromisesLike)
const spawnerLayer = BrowserChildProcessSpawner.layer({
  exec: async (commandLine) => ({ stdout: commandLine, stderr: "", exitCode: 0 })
})

const payload = "export const value = 42\n".repeat(128)

beforeAll(async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* fs.makeDirectory(join(root, "tree/a/b"), { recursive: true })
      for (let index = 0; index < 20; index++) {
        const dir = index % 2 === 0 ? join(root, "tree/a") : join(root, "tree/a/b")
        yield* fs.writeFileString(join(dir, `file-${index}.ts`), payload)
      }
      yield* fs.writeFileString(join(root, "hot.ts"), payload)
    })
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("platform-browser adapters", () => {
  test("BrowserFileSystem.readFileString + stat", async ({ bench }) => {
    const target = join(root, "hot.ts")
    const program = Effect.gen(function*() {
      yield* fs.stat(target)
      return yield* fs.readFileString(target)
    })
    await bench("BrowserFileSystem stat + readFileString", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("BrowserFileSystem.readDirectory recursive (20 files)", async ({ bench }) => {
    const program = fs.readDirectory(join(root, "tree"), { recursive: true })
    await bench("BrowserFileSystem readDirectory recursive", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("BrowserChildProcessSpawner.string (argv quoting + exec)", async ({ bench }) => {
    const command = ChildProcess.make("echo", ["hello world", "a;b|c$d", "--flag=value"])
    const program = Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command)).pipe(
      Effect.provide(
        Layer.provide(
          spawnerLayer,
          Layer.merge(Path.layer, Layer.succeed(FileSystem.FileSystem, fs))
        )
      )
    )
    await bench("BrowserChildProcessSpawner.string", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })
})
