import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Lock from "@smthrs/migrate/flow/Lock"
import { Effect, FileSystem } from "effect"

const [root, reportDir = ".smithers-migrate", mode = "normal"] = process.argv.slice(2)
if (root === undefined) throw new Error("root is required")
const send = (message: unknown) => process.send!(message)
const wait = (command: string): Promise<void> => new Promise((resolve) => {
  const listener = (message: unknown) => {
    if (message !== command) return
    process.off("message", listener)
    resolve()
  }
  process.on("message", listener)
})
let paused = false
const operation = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const pause = (phase: string) => Effect.promise(() => {
    send({ phase })
    return wait("continue")
  })
  const patched: FileSystem.FileSystem = {
    ...fs,
    open: (file, options) => {
      if (mode === "before-publish" && file.includes(".apply.lock.tmp-") && !paused) {
        paused = true
        return pause("initializing").pipe(Effect.andThen(fs.open(file, options)))
      }
      return fs.open(file, options)
    },
    readFileString: (file, options) => fs.readFileString(file, options).pipe(Effect.tap(() => {
      if (mode !== "after-read" || !file.endsWith("/apply.lock") || paused) return Effect.void
      paused = true
      return pause("reclaiming")
    }))
  }
  const held = yield* Lock.acquire({ root, reportDir }).pipe(Effect.provideService(FileSystem.FileSystem, patched))
  send({ phase: "acquired", file: held.file, record: held.record, reclaimed: held.reclaimed })
  if (mode === "checkpoint") {
    const Checkpoint = yield* Effect.promise(() => import("@smthrs/migrate/flow/Checkpoint"))
    const checkpoint = yield* Checkpoint.take({
      root,
      unit: "workflow:demo",
      files: ["workflow.jsx"],
      backupDir: `${root}/${reportDir}/backup`,
      allowNoVcs: true,
      treeExclude: [".smithers-migrate", reportDir]
    })
    yield* fs.writeFileString(`${root}/workflow.jsx`, "half migrated\n")
    send({ phase: "checkpoint", checkpoint })
  }
  yield* Effect.promise(() => wait("release"))
  yield* Lock.release(held).pipe(Effect.provideService(FileSystem.FileSystem, {
    ...fs,
    remove: (file, options) => mode === "before-remove" && file.endsWith("/apply.lock")
      ? pause("releasing").pipe(Effect.andThen(fs.remove(file, options)))
      : fs.remove(file, options)
  }))
  send({ phase: "released" })
})

send({ phase: "ready" })
await wait("acquire")
try {
  await Effect.runPromise(operation.pipe(Effect.provide(NodeServices.layer)))
} catch (cause) {
  send({ phase: "refused", code: (cause as { code?: string }).code, message: String(cause) })
}
process.disconnect!()
