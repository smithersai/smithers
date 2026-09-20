/**
 * What each standard helper actually binds.
 *
 * A host composes `StandardFlows.filesystem(services)`, not the seven bindings
 * inside it, so the catalog a helper produces is this package's contract with
 * the model and with `docs/guides/capabilities.md`. Losing one line from a
 * binding array is invisible until a run reaches for the capability and finds
 * nothing there, which is the failure the filesystem list was written to end:
 * with only `read` and `write` bound, the built-in harness emitted
 * `apply_patch` heredocs into `bash`, watched the shell report
 * `apply_patch: command not found`, and finished runs claiming fixes it never
 * applied. These tests read the catalog each source produces and compare it
 * with the documented set, and run the two search bindings to prove they are
 * handed the `Search` the host supplied rather than the bare filesystem
 * context.
 */
import type { FlowRuntime } from "@smthrs/flow"
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Classifiers from "@smthrs/std/Classifiers"
import * as Search from "@smthrs/std/Search"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type * as Crypto from "effect/Crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as StandardFlows from "../src/StandardFlows.ts"

/** The posix path service, materialized once so bindings can be given a context. */
const pathServices: Context.Context<Path.Path> = Effect.runSync(
  Effect.provide(Effect.context<Path.Path>(), Path.layer)
)

/**
 * The host slices each helper takes. A catalog is the binding list a source
 * declares, so the services behind it never run here and a refusing stub is
 * the honest stand-in for every one of them.
 */
const filesystemServices = Context.merge(
  Context.make(FileSystem.FileSystem, FileSystem.makeNoop({})),
  pathServices
)

const shellServices = Context.merge(
  Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()),
  pathServices
)

const evaluatorServices = (layer: Layer.Layer<Evaluator.Evaluator>): Context.Context<Evaluator.Evaluator> =>
  Effect.runSync(Effect.provide(Effect.context<Evaluator.Evaluator>(), layer))

const testServices = Context.make(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.makeNoop()
).pipe(
  Context.add(TestRunner.TestRunner, TestRunner.makeNoop()),
  // The `test` flow attributes a non-zero exit with Jev. A host without a key
  // binds this, and the flow fails rather than reporting an unjudged run.
  Context.merge(evaluatorServices(Evaluator.layerUnavailable()))
)

const memoryServices = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
  Context.add(Recall.Recall, Recall.makeNoop())
)

const clockServices = Context.empty() as Context.Context<
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
>

/** The catalog `docs/guides/capabilities.md` promises, helper by helper. */
const promised: ReadonlyArray<{
  readonly source: FlowBinding.Source
  readonly flows: ReadonlyArray<string>
}> = [
  {
    source: StandardFlows.filesystem(filesystemServices),
    flows: ["read", "write", "edit", "apply_patch", "ls", "glob", "grep"]
  },
  { source: StandardFlows.shell(shellServices), flows: ["bash"] },
  { source: StandardFlows.tests(testServices), flows: ["test"] },
  { source: StandardFlows.memory(memoryServices), flows: ["remember", "recall"] },
  { source: StandardFlows.clock(clockServices), flows: ["wait"] },
  { source: StandardFlows.approval(StandardFlows.askerNoop()), flows: ["ask"] },
  {
    source: StandardFlows.classify(evaluatorServices(Evaluator.layerUnavailable())),
    flows: ["classify", "classify/triage/relevance", "classify/check/verdict", "classify/edit/risk"]
  }
]

/** One synthetic call, so a binding runs without the controller around it. */
const callOf = (flowName: string, input: unknown): Cell.Call =>
  ({
    flowName,
    input,
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    identity: {
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: `${flowName}-declaration`,
      layers: []
    }
  }) as unknown as Cell.Call

describe("the standard capability catalog", () => {
  it.each([
    {
      flow: "glob",
      input: { pattern: "**/add.mjs", limit: 10 },
      value: { paths: ["add.mjs", "nested/add.mjs"], total: 2, truncated: false }
    },
    {
      flow: "grep",
      input: { pattern: "a + b", fixedStrings: true, limit: 10 },
      value: {
        matches: [
          expect.objectContaining({ file: "add.mjs", line: 1 }),
          expect.objectContaining({ file: "nested/add.mjs", line: 1 })
        ],
        filesSearched: 2,
        truncated: false
      }
    },
    {
      flow: "ls",
      input: { path: "." },
      value: {
        entries: [{ name: "nested/", kind: "directory" }, { name: "add.mjs", kind: "file" }],
        total: 2,
        truncated: false
      }
    }
  ])("searches the guarded disk workspace through $flow without an absolute root", async (fixture) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-standard-search-")))
    try {
      await mkdir(join(root, "nested"))
      await writeFile(join(root, "add.mjs"), "export const add = (a, b) => a + b\n")
      await writeFile(join(root, "nested/add.mjs"), "export const sum = (a, b) => a + b\n")
      const guarded = KernelFileSystem.layer.pipe(
        Layer.provide(AtomicFileSystem.layer),
        Layer.provideMerge(Path.layer),
        Layer.provide(Workspace.layer(root)),
        Layer.provide(GrantStore.layerNoop)
      )
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
          const bindings = yield* StandardFlows.filesystem(services).bindings()
          return yield* bindings.find((binding) => binding.descriptor.name === fixture.flow)!
            .run(callOf(fixture.flow, fixture.input))
        }).pipe(Effect.provide(guarded), Effect.scoped)
      )

      expect(result).toMatchObject({ outcome: "success", value: fixture.value })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const entry of promised) {
    it(`binds exactly the flows ${entry.source.name} promises`, async () => {
      const bindings = await Effect.runPromise(entry.source.bindings())
      expect(bindings.map((binding) => binding.descriptor.name)).toEqual(entry.flows)
    })
  }

  /**
   * What each standard flow says a call to it does, on the descriptor a run
   * journals and a card reads.
   *
   * These are the words the compatibility table in `apps/app` `RunTrace.ts`
   * guesses for a journal recorded before a declaration could say anything, so
   * a record with metadata and one without must read identically. `bash`
   * declares no activity on purpose and is the one row that says so.
   */
  it("declares what a call to each standard flow does and how it reads", async () => {
    const bound = await Effect.runPromise(
      Effect.forEach(
        [
          StandardFlows.filesystem(filesystemServices),
          StandardFlows.shell(shellServices),
          StandardFlows.tests(
            testServices
          )
        ],
        (source) => source.bindings()
      )
    )
    const declared = new Map(
      bound.flat().map((binding) => [
        binding.descriptor.name,
        [binding.descriptor.activity, binding.descriptor.presentation] as const
      ])
    )
    expect(
      [...declared].map((
        [name, [activity, presentation]]
      ) => [name, activity, presentation?.verb.success, presentation?.subject, presentation?.result])
    ).toEqual([
      ["read", "reads", "read", "path", "read"],
      ["write", "writes", "wrote", "path", "write"],
      ["edit", "writes", "edited", "path", "edit"],
      ["apply_patch", "writes", "patched", "patch", "patch"],
      ["ls", "reads", "listed", "path", "entries"],
      ["glob", "reads", "listed", "pattern", "paths"],
      ["grep", "reads", "searched", "pattern", "matches"],
      ["bash", undefined, "ran", "command", "command"],
      ["test", "tests", "ran", "selection", "tests"]
    ])
    // Display fields grant nothing: the identity a plan approves and a call
    // replays against is the same number with and without them.
    const read = bound.flat().find((binding) => binding.descriptor.name === "read")!.descriptor
    const { activity: _activity, presentation: _presentation, ...bare } = read
    expect(Descriptor.declarationDigest(new Descriptor.FlowDescriptor(bare))).toBe(
      Descriptor.declarationDigest(read)
    )
  })

  it("names its sources so a composed catalog says where each flow came from", () => {
    expect(promised.map((entry) => entry.source.name)).toEqual([
      "std/filesystem",
      "std/shell",
      "std/tests",
      "memory",
      "engine/clock",
      "host/approval",
      "std/classify"
    ])
  })

  it("binds the ad-hoc classify flow alone when the host names no classifiers", async () => {
    const bindings = await Effect.runPromise(
      StandardFlows.classify(evaluatorServices(Evaluator.layerUnavailable()), { classifiers: [] }).bindings()
    )
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["classify"])
  })

  it("names a curated classify flow after its classifier and folds the digest into the declaration", async () => {
    const bindings = await Effect.runPromise(
      StandardFlows.classify(evaluatorServices(Evaluator.layerUnavailable()), {
        classifiers: [Classifiers.checkVerdict]
      }).bindings()
    )
    const curated = bindings[1]!.descriptor
    expect(curated.name).toBe("classify/check/verdict")
    expect(curated.description).toContain(Classifiers.checkVerdict.description)
    expect(curated.description).toContain("rightReason boolean { value, probability }")
    expect(curated.body.contentDigest).toBe(Classifiers.checkVerdict.digest)
    expect(curated.effects.tier).toBe("sealed")
    expect(curated.capabilities).toEqual(["model:call:*"])
  })

  it("publishes the evaluator's code first when a classify call is refused", async () => {
    const unavailable = StandardFlows.classify(evaluatorServices(Evaluator.layerUnavailable()))
    const bindings = await Effect.runPromise(unavailable.bindings())
    const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]))
    const questions = { ok: { type: "boolean", instructions: "Is it done?" } }
    const refused = await Effect.runPromise(byName.get("classify")!.run(callOf("classify", { state: 1, questions })))
    expect(refused).toMatchObject({
      outcome: "failure",
      code: "flow_failed",
      message: "Flow classify failed: unreachable: No evaluator is installed on this host"
    })
    const curated = await Effect.runPromise(
      byName.get("classify/check/verdict")!.run(
        callOf("classify/check/verdict", { task: "keep km", command: "pytest", exitCode: 1, output: "E assert" })
      )
    )
    expect(curated).toMatchObject({
      outcome: "failure",
      code: "flow_failed",
      message: /^Flow classify\/check\/verdict failed: unreachable:/
    })
  })

  it("answers a classify call through the evaluator the host supplied", async () => {
    const scripted = Evaluator.layerScripted(() => ({
      rightReason: { probability: 0.9 },
      invalidProbe: { probability: 0.1 }
    }))
    const bindings = await Effect.runPromise(StandardFlows.classify(evaluatorServices(scripted)).bindings())
    const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]))
    const answered = await Effect.runPromise(
      byName.get("classify/check/verdict")!.run(
        callOf("classify/check/verdict", {
          states: [{ task: "keep km", command: "pytest", exitCode: 1, output: "E assert" }]
        })
      )
    )
    expect(answered).toMatchObject({
      outcome: "success",
      value: {
        results: [{
          ok: true,
          answers: { rightReason: { value: true, probability: 0.9 }, invalidProbe: { value: false, probability: 0.1 } }
        }]
      }
    })
  })

  it("hands glob and grep the search the host supplied, not the bare filesystem context", async () => {
    const asked: Array<string> = []
    const search = Search.make({
      glob: (input) =>
        Effect.sync(() => {
          asked.push(`glob ${input.pattern} in ${input.root}`)
          return { paths: ["/repo/alpha.md"], total: 1, truncated: false }
        }),
      grep: (input) =>
        Effect.sync(() => {
          asked.push(`grep ${input.pattern} in ${input.root}`)
          return { matches: [], files: [], filesSearched: 1, skippedBinary: 0, truncated: false }
        })
    })
    const bindings = await Effect.runPromise(
      StandardFlows.filesystem(filesystemServices, search).bindings()
    )
    const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]))

    const globbed = await Effect.runPromise(
      byName.get("glob")!.run(callOf("glob", { pattern: "*.md", root: "/repo" }))
    )
    const grepped = await Effect.runPromise(
      byName.get("grep")!.run(callOf("grep", { pattern: "second", root: "/repo" }))
    )

    // The filesystem context alone cannot answer either call: both handlers
    // require `Search`, and only the search context carries it.
    expect(globbed).toMatchObject({
      outcome: "success",
      value: { paths: ["/repo/alpha.md"], total: 1, truncated: false }
    })
    expect(grepped).toMatchObject({ outcome: "success", value: { filesSearched: 1 } })
    expect(asked).toEqual(["glob *.md in /repo", "grep second in /repo"])
  })
})
