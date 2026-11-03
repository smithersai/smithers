import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cell, CellHistory } from "@smthrs/harness"
import { MemoryError, MemoryStore } from "@smthrs/memory"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Evaluator } from "@smthrs/model"
import { Registry, RegistryError } from "@smthrs/registry"
import { Context, Deferred, Effect, FileSystem, Option, Path, Result, Schema, Scope, Tracer } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FlowStore from "../src/FlowStore.ts"
import * as Memory from "../src/Memory.ts"
import * as MemoryCalibration from "../src/MemoryCalibration.vibe"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as PromoteFlows from "../src/PromoteFlows.vibe"

const directory = fileURLToPath(new URL(".", import.meta.url))
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

const current = MemoryCalibration.Current

const fitted = (tau: number, reliability: ReadonlyArray<number> | null): MemoryCalibration.Thresholds => ({
  ...MemoryCalibration.initial,
  decisions: {
    ...MemoryCalibration.initial.decisions,
    fact: { ...MemoryCalibration.initial.decisions.fact, tau, reliability }
  }
})

const saved = {
  id: "saved-flow",
  description: "PRIVATE DESCRIPTION ghp_A1b2C3d4A1b2C3d4A1b2C3d4A1b2C3d4A1b2C3d4",
  flowSource: "export default {}",
  testSource: "",
  fixtureJson: "{}"
}

const save = (store: FlowStore.Service) => {
  const source = PromoteFlows.source(
    Context.make(CellHistory.CellHistory, CellHistory.makeCells([])).pipe(
      Context.add(FlowStore.FlowStore, store)
    )
  )
  return Effect.gen(function*() {
    const bindings = yield* source.bindings()
    const binding = bindings.find((entry) => entry.descriptor.name === "flows/write-flow")!
    return yield* binding.run(
      new Cell.Call({
        flowName: "flows/write-flow",
        input: saved,
        capabilities: [],
        effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
        placement: Option.none(),
        identity: new Cell.CallIdentity({
          session: "regression",
          frame: 0,
          cell: "cell",
          ordinal: 0,
          declaration: "declaration",
          layers: []
        })
      })
    )
  })
}

describe("confirmed memory and promotion findings", () => {
  it.each(["file", "parent"])("does not load thresholds through an escaping %s symlink", async (kind) => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const scratch = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".thresholds-" })
      const root = path.join(scratch, "repo")
      const outside = path.join(scratch, "repo-other")
      yield* fs.makeDirectory(root)
      yield* fs.makeDirectory(outside)
      yield* fs.writeFileString(path.join(outside, "memory-thresholds.json"), JSON.stringify(fitted(0.1, null)))
      if (kind === "parent") {
        yield* fs.symlink(outside, path.join(root, ".smithers"))
      } else {
        yield* fs.makeDirectory(path.join(root, ".smithers"))
        yield* fs.symlink(path.join(outside, "memory-thresholds.json"), path.join(root, MemoryCalibration.file))
      }
      const result = yield* Effect.result(Memory.thresholds(root))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.code).toBe("thresholds_invalid")
    }))
  })

  it.each([0, 1, 9, 11])("refuses a reliability table with %i buckets", (length) => {
    expect(() =>
      Schema.decodeUnknownSync(MemoryCalibration.Thresholds)(
        fitted(0.5, Array.from({ length }, () => 0.8))
      )
    ).toThrow()
  })

  it.each([
    { miss: -1, extra: 1 },
    { miss: 1, extra: -1 },
    { miss: 0, extra: 0 },
    { miss: Infinity, extra: 1 },
    { miss: 1, extra: Infinity },
    { miss: NaN, extra: 1 }
  ])("refuses invalid costs %j", (costs) => {
    expect(() => Schema.decodeUnknownSync(MemoryCalibration.Costs)(costs)).toThrow()
  })

  it.each([-0.01, 1.01, Infinity, -Infinity, NaN])("refuses invalid probability %s", (p) => {
    const base = MemoryCalibration.initial.decisions.fact
    expect(() => Schema.decodeUnknownSync(MemoryCalibration.Decided)({ ...base, tau: p })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MemoryCalibration.Decided)({
        ...base,
        reliability: Array.from({ length: 10 }, () => p)
      })
    ).toThrow()
  })

  it.each(
    [
      [0.6, null, 0.65, true],
      [0.8, null, 0.75, false],
      [0.7, Array.from({ length: 10 }, () => 0.9), 0.1, true],
      [0.7, Array.from({ length: 10 }, () => 0.2), 0.9, false]
    ] as const
  )("mines facts with the host calibration (%s, %j, %s)", async (tau, table, p, accepted) => {
    const candidates = [{ text: "Builds use pnpm.", seq: 1 }]
    const judged = await Effect.runPromise(
      MemoryMine.judge("remember", candidates).pipe(
        Effect.provideService(current, fitted(tau, table)),
        Effect.provide(Evaluator.layerScripted(() => ({
          durable_0: { probability: p },
          issue_0: { probability: p }
        })))
      )
    )
    expect(judged.facts).toEqual(accepted ? candidates : [])
    expect(judged.issues).toEqual(accepted ? candidates : [])
  })

  it("accepts the calibration domain boundaries and complete tables", () => {
    for (const costs of [{ miss: 0, extra: 1 }, { miss: 1, extra: 0 }]) {
      expect(Schema.decodeUnknownSync(MemoryCalibration.Costs)(costs)).toEqual(costs)
    }
    for (const tau of [0, 1]) {
      const thresholds = fitted(tau, Array.from({ length: 10 }, (_, index) => index % 2))
      expect(Schema.decodeUnknownSync(MemoryCalibration.Thresholds)(thresholds)).toEqual(thresholds)
    }
  })

  it("loads an in-root link and preserves defaults for absent thresholds", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".thresholds-" })
      expect(yield* Memory.thresholds(root)).toEqual(MemoryCalibration.initial)
      expect(yield* Memory.thresholds(path.join(root, "absent"))).toEqual(MemoryCalibration.initial)
      yield* fs.makeDirectory(path.join(root, ".smithers"))
      const settings = fitted(0.6, Array.from({ length: 10 }, () => 0.9))
      yield* fs.writeFileString(path.join(root, "fit.json"), JSON.stringify(settings))
      yield* fs.symlink(path.join(root, "fit.json"), path.join(root, MemoryCalibration.file))
      expect(yield* Memory.thresholds(root)).toEqual(settings)
    }))
  })

  it.each(["store", "supersede_conflict"] as const)("preserves an unrecoverable %s write failure", async (code) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const failure = new MemoryError.MemoryError({ code, message: "injected write failure" })
        const failed = { ...store, putNote: () => Effect.fail(failure) }
        const result = yield* Effect.result(MemoryMine.write(failed, {
          bank: "flow-build",
          runId: "one",
          text: "Builds use pnpm."
        }))
        expect(result).toEqual(Result.fail(failure))
      }).pipe(Effect.provide(TestMemory.layer))
    )
  })

  it("returns the first note to simultaneous writers of the same normalized fact", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const ready = yield* Deferred.make<void>()
        let reads = 0
        // Hold both real reads at the race boundary before either real insert.
        const concurrent: MemoryStore.Service = {
          ...store,
          getNote: (input) =>
            store.getNote(input).pipe(Effect.tap(() =>
              Effect.gen(function*() {
                reads += 1
                if (reads === 2) yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(ready)
              })
            ))
        }
        const notes = yield* Effect.all([
          MemoryMine.write(concurrent, { bank: "flow-build", runId: "one", text: "Builds use pnpm." }),
          MemoryMine.write(concurrent, { bank: "flow-build", runId: "two", text: "BUILDS  use pnpm." })
        ], { concurrency: 2 })
        expect(notes[0]).toEqual(notes[1])
        expect(yield* store.listNotes({ namespace: "flow-build" })).toEqual([notes[0]])
      }).pipe(Effect.provide(TestMemory.layer))
    )
  })

  it.each(["text", "namespace", "tags"])("does not hide a concurrent note's conflicting %s", async (field) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const text = "Builds use pnpm."
        const concurrent: MemoryStore.Service = {
          ...store,
          putNote: (input) =>
            Effect.gen(function*() {
              yield* store.putNote({
                ...input,
                text: field === "text" ? "Other fact." : text,
                namespace: field === "namespace" ? "flow-other" : input.namespace,
                tags: field === "tags" ? ["source:other"] : input.tags,
                provenance: { runId: "other" }
              })
              return yield* store.putNote(input)
            })
        }
        const result = yield* Effect.result(MemoryMine.write(concurrent, { bank: "flow-build", runId: "one", text }))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("supersede_conflict")
      }).pipe(Effect.provide(TestMemory.layer))
    )
  })

  it("keeps the model's description out of telemetry", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const result = await Effect.runPromise(
      save(FlowStore.makeMemory()).pipe(
        Effect.withSpan("save"),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    expect(result.outcome).toBe("success")
    expect(spans.some((span) => span.attributes.get("flow") === saved.id)).toBe(true)
    const attributes = JSON.stringify(spans.map((span) => [...span.attributes]))
    expect(attributes).not.toContain("PRIVATE DESCRIPTION")
    expect(attributes).not.toContain("ghp_")
  })

  it("reports failed discovery while returning the saved files", async () => {
    const written = new Map<string, string>()
    const result = await Effect.runPromise(
      save(FlowStore.makeMemory(written)).pipe(
        Effect.provideService(
          Registry.Registry,
          Registry.makeNoop({
            refresh: () =>
              Effect.fail(
                new RegistryError.DiscoveryError({
                  code: "read_failed",
                  message: "PRIVATE registry detail"
                })
              )
          })
        )
      )
    )
    expect(result.outcome).toBe("success")
    expect(written.size).toBe(3)
    expect(result.value).toMatchObject({
      files: [...written.keys()],
      warning: expect.stringContaining("registry refresh failed (read_failed)")
    })
    expect(JSON.stringify(result)).not.toContain("PRIVATE registry detail")
  })
})
