import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Fiber, Schema, Stream } from "effect"
import * as fs from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"
import { BrowserRuntime } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "120" : "40"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261203")

const Prepared = Schema.Struct({ rows: Schema.Number })

const throwingFs = (cause: unknown): BrowserFileSystem.ZenFsPromisesLike => {
  const boom = async (): Promise<never> => {
    throw cause
  }
  return {
    open: boom,
    readFile: boom,
    writeFile: boom,
    mkdir: boom,
    readdir: boom,
    stat: boom,
    rm: boom
  }
}

describe("@smthrs/platform-browser BrowserFileSystem & BrowserRuntime Prepare deep fuzz", () => {
  it("BrowserFileSystem.make upholds file/dir/stream/realPath CRUD & POSIX PlatformError mapping", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-bfs-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          op: Schema.Literals(["write_read", "stream_rw", "mkdir_ls_rm", "stat_realpath", "copy_rename", "posix_error"]),
          errCode: Schema.Literals(["ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY", "EINVAL", "EPERM"]),
          idx: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
        })
      )

      const bfs = BrowserFileSystem.make(NodeFsPromises)
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ op, errCode, idx }) =>
            Effect.gen(function*() {
              const targetFile = path.join(tmpBase, `f-${idx}.txt`)
              const subDir = path.join(tmpBase, `d-${idx}`)
              if (op === "write_read") {
                yield* bfs.writeFileString(targetFile, `hello-${idx}`)
                const text = yield* bfs.readFileString(targetFile)
                const exists = yield* bfs.exists(targetFile)
                return text === `hello-${idx}` && exists
              }
              if (op === "stream_rw") {
                yield* bfs.writeFile(targetFile, new TextEncoder().encode(`stream-${idx}\nline2`))
                const chunks = yield* Stream.runCollect(bfs.stream(targetFile))
                const joined = Buffer.concat(Array.from(chunks)).toString("utf8")
                return joined === `stream-${idx}\nline2`
              }
              if (op === "mkdir_ls_rm") {
                yield* bfs.makeDirectory(subDir, { recursive: true })
                yield* bfs.writeFileString(path.join(subDir, "item.txt"), "x")
                const entries = yield* bfs.readDirectory(subDir)
                yield* bfs.remove(subDir, { recursive: true })
                const after = yield* bfs.exists(subDir)
                return entries.includes("item.txt") && !after
              }
              if (op === "stat_realpath") {
                yield* bfs.writeFileString(targetFile, "stat-me")
                const info = yield* bfs.stat(targetFile)
                const rp = yield* bfs.realPath(targetFile)
                return info.type === "File" && rp.endsWith(`f-${idx}.txt`)
              }
              if (op === "copy_rename") {
                const dest = path.join(tmpBase, `c-${idx}.txt`)
                yield* bfs.writeFileString(targetFile, `copy-${idx}`)
                const cpRes = yield* bfs.copyFile(targetFile, dest).pipe(Effect.result)
                const renRes = yield* bfs.rename(targetFile, dest).pipe(Effect.result)
                return cpRes._tag === "Failure" && (renRes._tag === "Success" || renRes._tag === "Failure")
              }
              // posix_error
              const errFs = BrowserFileSystem.make(throwingFs(Object.assign(new Error(`${errCode}: boom`), { code: errCode })))
              const r1 = yield* errFs.readFileString("/any").pipe(Effect.result)
              const r2 = yield* errFs.writeFileString("/any", "x").pipe(Effect.result)
              const r3 = yield* errFs.stat("/any").pipe(Effect.result)
              const r4 = yield* errFs.readDirectory("/any").pipe(Effect.result)
              return r1._tag === "Failure" && r2._tag === "Failure" && r3._tag === "Failure" && r4._tag === "Failure"
            }),
          { seed, executions: Math.min(executions, 80) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  }, 45_000)

  it("BrowserRuntime.run({ prepare }) executes preparation once per epoch and fences tabs on PrepareFailed", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        epoch: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        shouldFail: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ epoch, shouldFail }) =>
          Effect.gen(function*() {
            const remove = MemoryOpfs.install()
            try {
              const name = Engines.name()
              const ran: Array<number> = []
              const prepare: BrowserRuntime.Prepare<typeof Prepared.Type> = {
                epoch,
                success: Prepared,
                run: (database) =>
                  Effect.gen(function*() {
                    ran.push(epoch)
                    if (shouldFail) return yield* Effect.fail("prep-boom")
                    yield* database.execute("CREATE TABLE IF NOT EXISTS prepared (epoch INTEGER)")
                    yield* database.execute("INSERT INTO prepared VALUES (?)", [epoch])
                    return { rows: 1 }
                  })
              }
              const running = BrowserRuntime.run({
                name,
                sqlite: MemorySqlite.build,
                flows,
                registerFlows: registration(Effect.succeed),
                prepare,
                telemetry: Telemetry.make().layer
              })
              yield* Effect.addFinalizer(() => Fiber.interrupt(running))

              const tab = yield* Engines.sharedTab(name)
              const tabRes = yield* tab.execute("SELECT epoch FROM prepared ORDER BY epoch").pipe(
                Effect.timeout("1500 millis"),
                Effect.result
              )
              if (shouldFail) return tabRes._tag === "Failure"
              return tabRes._tag === "Success" && ran.includes(epoch)
            } finally {
              remove()
            }
          }).pipe(Effect.scoped),
        { seed: seed + 1, executions: Math.min(executions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 60_000)
})
