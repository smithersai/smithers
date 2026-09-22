import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, FileSystem, Layer, Path } from "effect"
import { spawn } from "node:child_process"
import { join } from "node:path"
import * as AtomicFileSystem from "../../src/AtomicFileSystem.ts"

const root = process.argv[2]!
const expected = "native helper identity: λ 🌱\n"
const file = join(root, "content.txt")
const guarded = KernelFileSystem.layer.pipe(
  Layer.provide(AtomicFileSystem.layer),
  Layer.provide(Path.layer),
  Layer.provide(Workspace.layer(root)),
  Layer.provide(GrantStore.layerNoop)
)

// Interleave another native process with real, confined file operations.
// The helper path must resolve to the packaged binary on every request.
const gitVersion = () =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["--version"], {
      cwd: "/",
      env: {},
      stdio: ["pipe", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (data) => {
      output += data.toString()
    })
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 && output.startsWith("git version ")
        ? resolve()
        : reject(new Error(`git identity probe failed: ${code}`)))
    child.stdin.end()
  })

const failures = await Effect.runPromise(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(file, expected)
    return yield* Effect.forEach(Array.from({ length: 64 }), () =>
      Effect.gen(function*() {
        yield* Effect.promise(gitVersion)
        const info = yield* fs.stat(file)
        const actual = yield* fs.readFileString(file)
        if (info.type !== "File" || actual !== expected) throw new Error("helper returned different file content")
        return null
      }).pipe(Effect.catch((error) => Effect.succeed(String(error)))), { concurrency: 4 })
  }).pipe(Effect.provide(guarded))
)

console.log(JSON.stringify({ iterations: 64, failures: failures.filter((value) => value !== null) }))
