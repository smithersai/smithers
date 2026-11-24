/**
 * A host on a machine without jj (issue #3894).
 *
 * jj is what the engine snapshots a workspace with, and only compensable work
 * takes a snapshot. A program whose steps are all sealed, which is every
 * program the quickstart writes, must start and finish on a machine that has
 * never installed jj. A step that does need jj fails at that step with the
 * `not_installed` refusal and its remediation, not when the host is built.
 */
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { isJjError, Jj } from "@smthrs/jj"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const runnable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** This process's PATH with every entry that holds a `jj` removed, and nothing else. */
const pathWithoutJj = (path: string | undefined): string =>
  (path ?? "").split(delimiter).filter((entry) => entry !== "" && !runnable(join(entry, "jj"))).join(delimiter)

describe("NodeRuntime.layerHost without jj", () => {
  let directory = ""
  let previousPath: string | undefined
  let previousOverride: string | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "flows-no-jj-"))
    previousPath = process.env.PATH
    previousOverride = process.env.SMITHERS_JJ_PATH
    process.env.PATH = pathWithoutJj(previousPath)
    delete process.env.SMITHERS_JJ_PATH
  })

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousOverride === undefined) delete process.env.SMITHERS_JJ_PATH
    else process.env.SMITHERS_JJ_PATH = previousOverride
    rmSync(directory, { recursive: true, force: true })
  })

  const workspace = () => join(directory, "workspace")

  /** A plain sealed step: read a workspace file through the guarded host. */
  const ReadNote = Action.make({
    name: "no-jj/read-note",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "no-jj/read-note/v1",
    execute: Effect.gen(function*() {
      const files = yield* FileSystem.FileSystem
      return yield* Effect.orDie(files.readFileString(join(workspace(), "note.txt")))
    })
  })

  /** The engine takes a jj pre-image before this runs. */
  const Mutate = Action.make({
    name: "no-jj/mutate",
    success: Schema.String,
    tier: "compensable",
    idempotencyKey: "no-jj/mutate/v1",
    execute: Effect.succeed("mutated")
  })

  /** A sealed step that calls jj itself, and reports how jj refused. */
  const JjStatus = Action.make({
    name: "no-jj/jj-status",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "no-jj/jj-status/v1",
    execute: Effect.gen(function*() {
      const jj = yield* Jj
      return yield* jj.status().pipe(
        Effect.catch((error) => Effect.succeed(isJjError(error) ? `${error.code}: ${error.message}` : String(error)))
      )
    })
  })

  const Probe = Action.make("no-jj/probe", {
    payload: { what: Schema.String },
    success: Schema.String
  })

  const Host = Flow.make("no-jj/probe-flow", {
    payload: { what: Schema.String },
    success: Schema.String,
    body: (payload) => Probe.call(payload)
  })

  const flows = Interpreter.layer(Host).pipe(
    Layer.provideMerge(Probe.toLayer(({ what }) => what === "read" ? ReadNote : what === "status" ? JjStatus : Mutate)),
    Layer.provideMerge(Action.layerImplementations)
  )

  const host = () =>
    NodeRuntime.layerHost(
      {
        filename: join(workspace(), ".flows", "engine.db"),
        workspaceRoot: workspace(),
        owner: { hostId: "no-jj" },
        signals: [],
        rules: [
          new Permission.Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: join(workspace(), "**") })
          }),
          new Permission.Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "jj:status", resource: "*" })
          })
        ]
      },
      flows
    )

  it("refuses an unversioned reusable step before host dispatch", async () => {
    let calls = 0
    const keyed = Action.make("no-jj/unversioned", {
      payload: {},
      success: Schema.String,
      idempotencyKey: "shared"
    })
    const flow = Flow.make("no-jj/unversioned-flow", {
      payload: {},
      success: Schema.String,
      error: Interpreter.InterpreterError,
      body: () => keyed.call({})
    })
    const registrations = Layer.merge(
      Interpreter.layer(flow),
      keyed.toLayer(() =>
        Effect.sync(() => {
          calls++
          return "ran"
        })
      )
    ).pipe(Layer.provide(Action.layerImplementations))
    mkdirSync(workspace(), { recursive: true })
    const exit = await Effect.runPromiseExit(
      flow.execute({}, { executionId: "unversioned" }).pipe(
        Effect.provide(NodeRuntime.layerHost({
          filename: join(workspace(), "unversioned.sqlite"),
          workspaceRoot: workspace(),
          owner: { hostId: "unversioned" },
          signals: []
        }, registrations)),
        Effect.scoped
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "missing_implementation_version" })
    expect(calls).toBe(0)
  }, 60_000)

  it("starts the host and runs a sealed step", async () => {
    mkdirSync(workspace(), { recursive: true })
    writeFileSync(join(workspace(), "note.txt"), "the note")

    const exit = await Effect.runPromiseExit(
      Host.execute({ what: "read" }, { executionId: "no-jj-read" }).pipe(Effect.provide(host()), Effect.scoped)
    )

    expect(exit).toMatchObject({ _tag: "Success", value: "the note" })
  }, 60_000)

  it("refuses jj at the step that needs it, with not_installed and its remediation", async () => {
    mkdirSync(workspace(), { recursive: true })
    writeFileSync(join(workspace(), "note.txt"), "the note")
    const remediation = "jj: No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."

    // One host: the sealed run proves it started, so each refusal below is the
    // step's own, not the host's construction failing.
    const [read, status, mutate] = await Effect.runPromise(
      Effect.all([
        Effect.exit(Host.execute({ what: "read" }, { executionId: "no-jj-read" })),
        Effect.exit(Host.execute({ what: "status" }, { executionId: "no-jj-status" })),
        Effect.exit(Host.execute({ what: "mutate" }, { executionId: "no-jj-mutate" }))
      ]).pipe(Effect.provide(host()), Effect.scoped)
    )

    expect(read).toMatchObject({ _tag: "Success", value: "the note" })
    // A step that calls Jj receives the typed refusal.
    expect(status).toMatchObject({ _tag: "Success", value: `not_installed: ${remediation}` })
    // A compensable step fails before its body runs: the engine's pre-image
    // snapshot is what needs jj, and the run records that failure.
    expect(Exit.isFailure(mutate)).toBe(true)
    if (Exit.isFailure(mutate)) {
      expect(Cause.squash(mutate.cause)).toMatchObject({ name: "@smthrs/jj/JjError", message: remediation })
    }
  }, 60_000)
})
