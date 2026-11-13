import { afterAll, expect, it } from "@effect/vitest"
import { EngineStore } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { NodeHost } from "@smthrs/platform-node"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cached, compensated, directoryJj, engine, Package } from "../../examples/21-cache-and-compensation.ts"

const failure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    description: `injected ${method} failure`
  })
type Fault = (fs: FileSystem.FileSystem) => FileSystem.FileSystem
const faulty = (fault: Fault) =>
  Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, fault)).pipe(
    Layer.provide(NodeHost.NodeFileSystem.layer)
  )

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("serves a second run from the recorded row while the policy admits it", () =>
  Effect.gen(function*() {
    const summary = yield* cached(join(directory, "fresh.sqlite"), {
      ttlMs: 600_000,
      pauseMs: 0,
      prefix: join(directory, "fresh")
    })

    expect(summary.results[0]).toBe("dist/server.js?target=server")
    expect(summary.results[1]).toBe(summary.results[0])
    // One execution across two runs: the second dispatch read the row.
    expect(summary.executions).toBe(1)
    // And it said so durably, rather than leaving the hit invisible.
    expect(summary.verdicts).toEqual(["admitted"])
  }))

it.live("executes again once the declared time to live has aged the row out", () =>
  Effect.gen(function*() {
    const summary = yield* cached(join(directory, "stale.sqlite"), {
      ttlMs: 1,
      pauseMs: 30,
      prefix: join(directory, "stale")
    })

    expect(summary.executions).toBe(2)
    expect(summary.verdicts).toEqual(["expired"])
  }), { timeout: 60_000 })

it.effect("restores the pre-image before retrying a compensable step", () =>
  Effect.gen(function*() {
    const summary = yield* compensated(join(directory, "migrate.sqlite"), {
      workspace: join(directory, "workspace"),
      snapshots: join(directory, "snapshots")
    })

    expect(summary.result).toBe("0007-lane:applied")
    expect(summary.attempts).toEqual([1, 2])
    // Two pre-images per attempt, the dispatch's rollback boundary and the
    // attempt row's own, plus a post-image the boundary diffs against.
    expect(summary.snapshots).toEqual([
      "attempt-1-pre",
      "attempt-1-pre",
      "attempt-1-post",
      "attempt-2-pre",
      "attempt-2-pre",
      "attempt-2-post"
    ])
    // Both attempt-one pre-images went back before attempt two ran.
    expect(summary.restores).toEqual(["attempt-1-pre", "attempt-1-pre"])
    // The evidence: one migration on disk, not two.
    expect(summary.workspace).toBe("-- base\nALTER TABLE runs ADD COLUMN lane;\n")
  }))

const partialCopy: Fault = (fs) => ({
  ...fs,
  copy: (_source, destination) =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(destination, { recursive: true })
      yield* fs.writeFileString(join(destination, "partial.txt"), "partial copy")
      return yield* Effect.fail(failure("copy"))
    })
})
const failedSwap = (rollback: boolean): Fault => (fs) => ({
  ...fs,
  rename: (source, destination) =>
    source.endsWith("/workspace") && source.includes(".restore-") || rollback && source.endsWith("/backup")
      ? Effect.fail(failure("rename"))
      : fs.rename(source, destination)
})

const fixture = () => {
  const root = mkdtempSync(join(directory, "adapter-"))
  const workspace = join(root, "workspace")
  const snapshots = join(root, "snapshots")
  mkdirSync(workspace)
  mkdirSync(snapshots)
  writeFileSync(join(workspace, "state.txt"), "original pre-image")
  const layer = (fault?: Fault) =>
    directoryJj(
      { workspace, snapshots, log: { snapshots: [], restores: [] } },
      fault === undefined ? NodeHost.NodeFileSystem.layer : faulty(fault)
    )
  const snapshot = (fault?: Fault) =>
    Effect.gen(function*() {
      const jj = yield* Jj.Jj
      return yield* jj.snapshot("attempt 1")
    }).pipe(Effect.provide(layer(fault)))
  const restore = (id: string, fault?: Fault) =>
    Effect.gen(function*() {
      const jj = yield* Jj.Jj
      yield* jj.restore(id as never)
    }).pipe(Effect.provide(layer(fault)))
  return { root, workspace, snapshots, snapshot, restore }
}

it.effect("a missing snapshot fails without deleting the workspace", () =>
  Effect.gen(function*() {
    const f = fixture()
    const result = yield* Effect.exit(f.restore("missing-snapshot"))
    expect(result._tag).toBe("Failure")
    expect(existsSync(f.workspace)).toBe(true)
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("original pre-image")
    expect(readdirSync(f.root).sort()).toEqual(["snapshots", "workspace"])
  }))

it.effect("fresh layers keep distinct immutable snapshots that can both be restored", () =>
  Effect.gen(function*() {
    const f = fixture()
    const first = yield* f.snapshot()
    writeFileSync(join(f.workspace, "state.txt"), "partially applied write")
    const second = yield* f.snapshot()
    yield* f.restore(first.commitId)
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("original pre-image")
    expect(first.commitId).not.toBe(second.commitId)
    expect(readFileSync(join(f.snapshots, first.commitId, "state.txt"), "utf8")).toBe("original pre-image")
    yield* f.restore(second.commitId)
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("partially applied write")
    expect(readdirSync(f.root).sort()).toEqual(["snapshots", "workspace"])
  }))

it.effect("a partial restore copy fails without touching the workspace", () =>
  Effect.gen(function*() {
    const f = fixture()
    const saved = yield* f.snapshot()
    writeFileSync(join(f.workspace, "state.txt"), "only surviving workspace data")
    const result = yield* Effect.exit(f.restore(saved.commitId, partialCopy))
    expect(result._tag).toBe("Failure")
    expect(readdirSync(f.workspace)).toEqual(["state.txt"])
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("only surviving workspace data")
    expect(readdirSync(f.root).sort()).toEqual(["snapshots", "workspace"])
  }))

it.effect("a failed snapshot copy publishes nothing and preserves earlier snapshots", () =>
  Effect.gen(function*() {
    const f = fixture()
    const first = yield* f.snapshot()
    writeFileSync(join(f.workspace, "state.txt"), "partially applied write")
    const result = yield* Effect.exit(f.snapshot(partialCopy))
    expect(result._tag).toBe("Failure")
    expect(readdirSync(f.snapshots)).toEqual([first.commitId])
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("partially applied write")
    yield* f.restore(first.commitId)
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("original pre-image")
  }))

it.effect("a failed staged swap rolls the original workspace back", () =>
  Effect.gen(function*() {
    const f = fixture()
    const saved = yield* f.snapshot()
    writeFileSync(join(f.workspace, "state.txt"), "only surviving workspace data")
    const result = yield* Effect.exit(f.restore(saved.commitId, failedSwap(false)))
    expect(result._tag).toBe("Failure")
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("only surviving workspace data")
    expect(readdirSync(f.root).sort()).toEqual(["snapshots", "workspace"])
  }))

it.effect("a corrupt non-directory snapshot fails without touching the workspace", () =>
  Effect.gen(function*() {
    const f = fixture()
    writeFileSync(join(f.snapshots, "corrupt"), "not a directory")
    const result = yield* Effect.exit(f.restore("corrupt"))
    expect(result._tag).toBe("Failure")
    expect(readFileSync(join(f.workspace, "state.txt"), "utf8")).toBe("original pre-image")
    expect(readdirSync(f.root).sort()).toEqual(["snapshots", "workspace"])
  }))

it.effect("retains the original backup if both the swap and rollback fail", () =>
  Effect.gen(function*() {
    const f = fixture()
    const saved = yield* f.snapshot()
    writeFileSync(join(f.workspace, "state.txt"), "only surviving workspace data")
    const result = yield* Effect.exit(f.restore(saved.commitId, failedSwap(true)))
    expect(result._tag).toBe("Failure")
    const retained = readdirSync(f.root).filter((name) => name.startsWith(".restore-"))
    expect(retained).toHaveLength(1)
    expect(readFileSync(join(f.root, retained[0]!, "backup", "state.txt"), "utf8"))
      .toBe("only surviving workspace data")
  }))

it.effect("preserves the migrated schema when replaying the fixed execution", () =>
  Effect.gen(function*() {
    const filename = join(directory, "replay.sqlite")
    const directories = {
      workspace: join(directory, "replay-workspace"),
      snapshots: join(directory, "replay-snapshots")
    }
    const first = yield* compensated(filename, directories)
    const replay = yield* compensated(filename, directories)
    expect(first.workspace).toBe("-- base\nALTER TABLE runs ADD COLUMN lane;\n")
    expect(replay.result).toBe(first.result)
    expect(replay.attempts).toEqual([])
    expect(replay.workspace).toBe(first.workspace)
  }))

it.effect("does not take an expired run from an owner whose process is still alive", () =>
  Effect.gen(function*() {
    const f = fixture()
    const hostId = "examples-live-owner"
    yield* Effect.gen(function*() {
      const flows = yield* FlowRuntime.FlowRuntime
      const runs = yield* RunStore.RunStore
      let executions = 0
      yield* flows.register(Package, () =>
        Effect.sync(() => {
          executions++
          return "stolen"
        }))
      const runId = "live-owner"
      yield* runs.create(
        runId,
        JSON.stringify({
          capabilityCeilings: [[]],
          version: 1,
          flowName: Package._tag,
          payload: { target: "live-owner" }
        })
      )
      const row = yield* runs.get(runId)
      const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
      const owner = { hostId, pid: process.ppid, nonce: "other-engine" }
      const claim = yield* runs.claim(runId, expected, owner, 0)
      expect(claim).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      expect(yield* runs.activate(runId, owner, 0, expected)).toEqual({ _tag: "Activated" })
      const driven = yield* EngineStore.drive(Package, { executionId: runId, payload: { target: "live-owner" } })
      expect(driven._tag).toBe("Parked")
      expect(executions).toBe(0)
      expect((yield* runs.get(runId)).owner).toEqual(owner)
    }).pipe(
      Effect.provide(engine(
        join(f.root, "engine.sqlite"),
        hostId,
        directoryJj({
          workspace: f.workspace,
          snapshots: f.snapshots,
          log: { snapshots: [], restores: [] }
        })
      )),
      Effect.scoped
    )
  }))
