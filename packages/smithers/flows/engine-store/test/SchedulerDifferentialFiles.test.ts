import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal } from "@smthrs/journal"
import { FileSet } from "@smthrs/plan"
import { Effect, FileSystem, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import * as Reference from "./PlanSchedulerReference.ts"
import { activate, compile, draft, owner, runtime } from "./SchedulerDifferentialHarness.ts"
import { runPromise, sha256 } from "./Sha256.ts"

describe("declared file reachability against the captured scheduler", () => {
  for (const kind of ["exact", "tree", "glob"] as const) {
    it(`${kind}: preserves producer measurements, source pins, own reads and later-writer ordering`, async () => {
      const writes: ReadonlyArray<FileSet.Entry> = kind === "exact" ? ["out/produced/item.txt"] : kind === "tree"
        ? [{ _tag: "TreeArtifact", path: "out/produced" }]
        : [{ _tag: "Glob", include: ["out/produced/**"] }]
      const plan = await compile([
        draft("self", [], {
          effects: { reads: ["out/self.txt"], writes: ["out/self.txt"], boundaryMode: "hard" }
        }),
        draft("producer", [], { effects: { reads: [], writes, boundaryMode: "hard" } }),
        draft("reader", ["self", "producer"], {
          effects: {
            reads: ["src/input.txt", { _tag: "Glob", include: ["out/**"] }],
            writes: [],
            boundaryMode: "hard"
          }
        }),
        draft("later", ["reader"], {
          effects: { reads: [], writes: ["src/input.txt"], boundaryMode: "hard" }
        })
      ])
      const drive = (reference: boolean) => {
        const implementation = reference ? Reference : PlanScheduler
        const files = new Map([
          ["src/input.txt", "source-before"],
          ["out/self.txt", "self-before"],
          ["out/source.txt", "unproduced-source"]
        ])
        const calls: Array<{ node: string; boundary: FileBoundary }> = []
        const fs = FileSystem.makeNoop({
          readDirectory: (path) =>
            Effect.sync(() => {
              const prefix = path === "." ? "" : `${path}/`
              return [
                ...new Set(
                  [...files.keys()].filter((file) => file.startsWith(prefix)).map((file) =>
                    file.slice(prefix.length).split("/")[0]!
                  )
                )
              ].sort()
            }),
          stat: (path) =>
            Effect.sync(() => ({
              type: files.has(path) ? "File" : "Directory",
              size: 0n
            } as FileSystem.File.Info))
        })
        const boundary = StepBoundary.make({
          prepare: (descriptor) =>
            Effect.sync(() => ({
              descriptor,
              readSnapshot: StepBoundary.exactReads(descriptor).map(({ path }) => ({
                path,
                digest: sha256(files.get(path) ?? "absent")
              }))
            })),
          settle: ({ descriptor }) =>
            Effect.sync(() => ({
              declaredOutputs: { paths: descriptor.writeSet },
              diffIdentity: "file-fixture",
              wholeTreeWritesVerified: true,
              hermeticReadsVerified: true
            })),
          replayOutputs: () => Effect.void
        })
        const executor: PlanScheduler.Executor = {
          execute: ({ boundary, node }) =>
            Effect.sync(() => {
              calls.push({ node: node.id, boundary })
              if (node.id === "self") files.set("out/self.txt", "self-after")
              if (node.id === "producer") {
                files.set("out/produced/item.txt", "produced-after")
                // An unrelated arrival cannot join the pinned source glob.
                files.set("out/arrival.txt", "unproduced-arrival")
              }
              if (node.id === "later") files.set("src/input.txt", "source-after")
              return { value: node.id }
            })
        }
        return runPromise(
          Effect.gen(function*() {
            yield* activate("files")
            const scheduler = implementation.make({
              runId: "files",
              sourceId: "files",
              owner,
              concurrency: { steps: 1 }
            })
            yield* scheduler.record(plan)
            const report = yield* scheduler.run(plan)
            const journal = yield* Journal.Journal
            const page = yield* journal.entries({ runId: "files" as never, limit: 512 })
            return {
              report,
              calls,
              records: page.entries.filter((entry) => /flows\.engine\.node-/.test(entry.eventType)).map((entry) => ({
                type: entry.eventType,
                payload: entry.payload
              }))
            }
          }).pipe(
            Effect.provide(Layer.succeed(StepBoundary.StepBoundary, boundary)),
            Effect.provide(Layer.succeed(FileSystem.FileSystem, fs)),
            Effect.provide(runtime(executor)),
            Effect.provide(TestStores.layerAt(":memory:")),
            Effect.scoped
          )
        )
      }
      const expected = await drive(true)
      expect(await drive(false)).toEqual(expected)
      expect(expected.calls.map(({ node }) => node)).toEqual(["self", "producer", "reader", "later"])
      expect(expected.calls[0]!.boundary.readSet).toEqual([{ path: "out/self.txt", digest: sha256("self-before") }])
      expect(expected.calls[2]!.boundary.readSet).toEqual([
        { path: "out/produced/item.txt", digest: sha256("produced-after") },
        { path: "out/self.txt", digest: sha256("self-after") },
        { path: "out/source.txt", digest: sha256("unproduced-source") },
        { path: "src/input.txt", digest: sha256("source-before") }
      ])
      expect(expected.report.settlements.map(({ outcome }) => outcome)).toEqual(["built", "built", "built", "built"])
    })
  }
})
