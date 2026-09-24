/**
 * What a host declares about the tree its flows were read out of.
 *
 * A node record carries where its action was declared — a path and a line —
 * and neither says which bytes were at that line: a working tree moves, so
 * the same path after an edit is a different file. A host that can name the
 * revision it loaded from declares it once, here, and every recorded graph
 * page of every run carries it, so a reader can open the declared file AT
 * that revision. A host that declares none records none, which is what a
 * reader must see rather than code it cannot bind (D-068).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { afterAll, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Action, EngineStore as EngineStorePackage, Flow, Interpreter, Kernel } from "../src/index.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const { StepBoundary, WorkspaceSandbox } = EngineStorePackage
const { Jj } = Kernel

const directory = mkdtempSync(join(tmpdir(), "flows-source-revision-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "source-revision" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const host = Layer.mergeAll(NodeCrypto.layer, AtomicFileSystem.layer, stubJj)

const Step = Action.make("source-revision/step", {
  payload: { label: Schema.String },
  success: Schema.String
})

const Named = Flow.make("source-revision/flow", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: ({ label }) => Step.call({ label })
})

const registerFlows = Interpreter.layer(Named).pipe(
  Layer.provideMerge(Step.toLayer(({ label }: { readonly label: string }) => Effect.succeed(`step:${label}`))),
  Layer.provideMerge(Action.layerImplementations)
)

/** One run, and the revision every recorded page of its graph claims. */
const revisionsOf = (
  name: string,
  sourceRevision?: string | (() => string | undefined),
  afterStartup?: () => void
) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* NodeRuntime.make(
      {
        filename: join(directory, name, "engine.sqlite"),
        workspaceRoot: join(directory, name),
        owner: { hostId: name },
        isAlive: () => Effect.succeed(false),
        ...(sourceRevision === undefined ? {} : { sourceRevision })
      },
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      registerFlows
    )
    afterStartup?.()
    yield* Named.execute({ label: "one" }, { executionId: `${name}-run` }).pipe(Effect.provide(context))
    const journal = yield* Journal.Journal.pipe(Effect.provide(context))
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(`${name}-run`), limit: 1000 })
    return page.entries
      .filter((entry) =>
        entry.eventType === "flows.engine.plan-recorded" || entry.eventType === "flows.engine.subgraph-appended"
      )
      .map((entry) =>
        ((entry.payload as Record<string, unknown>)["graph"] as Record<string, unknown> | undefined)?.["sourceRevision"]
      )
  })).pipe(Effect.provide(host))

it("records nothing about the source while the host names no revision", async () => {
  const pages = await Effect.runPromise(revisionsOf("absent"))

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => undefined))
}, 120_000)

it("records the host's revision on every page of the graph it drove", async () => {
  const revision = "d".repeat(40)
  const pages = await Effect.runPromise(revisionsOf("declared", revision))

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => revision))
}, 120_000)

/*
 * A host that does not know its revision while this runtime is being built
 * declares a reader instead. The native host is one: the modules whose sites
 * these records carry are read during registration, the last startup phase, so
 * a string handed over at construction would be one nobody had verified yet.
 * The reader below answers nothing until the runtime is built, and every page
 * still carries the answer it gave afterwards.
 */
it("asks the host for its revision after the runtime was built", async () => {
  const revision = "e".repeat(40)
  let answer: string | undefined
  const pages = await Effect.runPromise(revisionsOf("deferred", () => answer, () => {
    answer = revision
  }))

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => revision))
}, 120_000)

/* A reader with no answer records nothing, exactly as no declaration does. */
it("records nothing while the reader the host declared answers nothing", async () => {
  const pages = await Effect.runPromise(revisionsOf("deferred-absent", () => undefined))

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => undefined))
}, 120_000)

/*
 * `layerHost` is the native host composition embedders use. It carries the
 * same declaration `layer` does; a host built through it that names its
 * revision records it on every page too.
 */
it("records the revision a layerHost host declares", async () => {
  const revision = "f".repeat(40)
  const Sealed = Action.make("source-revision/host-step", {
    payload: { label: Schema.String },
    success: Schema.String,
    tier: "sealed"
  })
  const HostFlow = Flow.make("source-revision/host-flow", {
    payload: { label: Schema.String },
    success: Schema.String,
    body: ({ label }) => Sealed.call({ label })
  })
  const flows = Interpreter.layer(HostFlow).pipe(
    Layer.provideMerge(Sealed.toLayer(({ label }: { readonly label: string }) => Effect.succeed(`host:${label}`))),
    Layer.provideMerge(Action.layerImplementations)
  )
  const root = join(directory, "host")
  const pages = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(NodeRuntime.layerHost(
      {
        filename: join(root, "engine.sqlite"),
        workspaceRoot: root,
        owner: { hostId: "host" },
        signals: [],
        sourceRevision: revision
      },
      flows
    ))
    yield* HostFlow.execute({ label: "one" }, { executionId: "host-run" }).pipe(Effect.provide(context))
    const journal = yield* Journal.Journal.pipe(Effect.provide(context))
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make("host-run"), limit: 1000 })
    return page.entries
      .filter((entry) =>
        entry.eventType === "flows.engine.plan-recorded" || entry.eventType === "flows.engine.subgraph-appended"
      )
      .map((entry) =>
        ((entry.payload as Record<string, unknown>)["graph"] as Record<string, unknown> | undefined)?.["sourceRevision"]
      )
  })))

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => revision))
}, 120_000)
