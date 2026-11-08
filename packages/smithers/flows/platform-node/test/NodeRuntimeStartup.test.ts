import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/jj"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as PlatformError from "effect/PlatformError"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeHost from "../src/NodeHost.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"

it("builds the host before the runtime creates its repository and database parent, spawning nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-startup-"))
  const root = join(directory, "missing", "repository")
  const filename = join(root, "runtime.sqlite")
  try {
    await Effect.runPromise(Effect.provide(Jj, NodeHost.layerAt(root)))
    expect(existsSync(join(directory, "missing"))).toBe(false)
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename, workspaceRoot: root, owner: { hostId: "startup" }, signals: [] },
            Layer.empty
          )
        ),
        Effect.scoped
      )
    )
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      // The contained jj layer checks its executable on its first operation,
      // so a host that runs nothing starts no process at all.
      expect(database.prepare("SELECT event_type FROM flows_journal_events ORDER BY seq").all()).toEqual([])
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("logs what registration recovered once, at Info, when the host starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-startup-recovery-"))
  const Step = Action.make("startup-recovery/step", { payload: {}, success: Schema.String })
  const Started = Flow.make("startup-recovery/flow", { payload: {}, success: Schema.String, body: () => Step.call({}) })
  const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((entry) => {
    lines.push(Logger.formatStructured.log(entry))
  })
  try {
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: join(directory, "engine.sqlite"),
              workspaceRoot: directory,
              owner: { hostId: "recovery" },
              signals: []
            },
            Interpreter.layer(Started).pipe(
              Layer.provideMerge(Step.toLayer(() => Effect.succeed("done"))),
              Layer.provideMerge(Action.layerImplementations)
            )
          )
        ),
        Effect.scoped,
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const summary = lines.filter((line) => line.message === "engine-store.registration.recovered")
  expect(summary.map((line) => line.level)).toEqual(["INFO"])
  // The flow, its step's flow form and the interpreter's system flows, recovered at once in that report.
  expect(summary[0]!.annotations["registrations"]).toBeGreaterThan(1)
  expect(lines.filter((line) => line.message === "engine-store.registration.flow.recovered")).toEqual([])
})

/** The injected filesystem a host confines to its workspace, which refuses any
 * directory outside it. A host that keeps `engine.db` out of the checkout it
 * serves hits exactly this refusal on every start.
 */
const confinedTo = (pinned: string) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
      ...fs,
      makeDirectory: (path, options) =>
        path === pinned
          ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "makeDirectory",
              pathOrDescriptor: path,
              description: "outside the pinned workspace root"
            })
          )
          : fs.makeDirectory(path, options)
    }))
  ).pipe(Layer.provide(NodeFileSystem.layer))

/** The same confinement, but the refusal is the run being interrupted. */
const interruptedAt = (pinned: string) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
      ...fs,
      makeDirectory: (path, options) => path === pinned ? Effect.interrupt : fs.makeDirectory(path, options)
    }))
  ).pipe(Layer.provide(NodeFileSystem.layer))

it("creates the database directory with the host's own mkdir when the injected filesystem refuses it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-refused-database-"))
  const filename = join(directory, "outside-the-workspace", "engine.sqlite")
  const parent = dirname(filename)
  try {
    expect(existsSync(parent)).toBe(false)
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(NodeRuntime.storage(filename)),
        Effect.provide(Layer.merge(confinedTo(parent), NodeCrypto.layer)),
        Effect.scoped
      )
    )
    expect(existsSync(filename)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("leaves an interrupted directory creation interrupted instead of retrying it on the host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-interrupted-database-"))
  const filename = join(directory, "outside-the-workspace", "engine.sqlite")
  const parent = dirname(filename)
  try {
    const exit = await Effect.runPromiseExit(
      Effect.void.pipe(
        Effect.provide(NodeRuntime.storage(filename)),
        Effect.provide(Layer.merge(interruptedAt(parent), NodeCrypto.layer)),
        Effect.scoped
      )
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(existsSync(parent)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
