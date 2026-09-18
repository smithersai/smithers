import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeRuntime from "../src/NodeRuntime.ts"

it("builds the host before the runtime creates its repository and database parent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-startup-"))
  const previous = process.env.SMITHERS_JJ_PATH
  const binary = join(directory, "jj")
  writeFileSync(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.39.0\"; fi\n", { mode: 0o755 })
  process.env.SMITHERS_JJ_PATH = binary
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
      // The contained jj layer validates its pinned executable at startup.
      expect(database.prepare("SELECT event_type FROM flows_journal_events ORDER BY seq").all()).toEqual([
        { event_type: "flows.host.process-spawned.v1" },
        { event_type: "flows.host.process-exited.v1" }
      ])
    } finally {
      database.close()
    }
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
    else process.env.SMITHERS_JJ_PATH = previous
    rmSync(directory, { recursive: true, force: true })
  }
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
