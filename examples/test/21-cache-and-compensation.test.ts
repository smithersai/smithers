import { afterAll, afterEach, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { cached, compensated, directoryJj } from "../src/21-cache-and-compensation.ts"

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return { ...fs, cpSync: vi.fn(fs.cpSync), renameSync: vi.fn(fs.renameSync) }
})

afterEach(() => {
  vi.mocked(cpSync).mockReset()
  vi.mocked(renameSync).mockReset()
})

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

const fixture = () => {
  const root = mkdtempSync(join(directory, "adapter-"))
  const workspace = join(root, "workspace")
  const snapshots = join(root, "snapshots")
  mkdirSync(workspace)
  mkdirSync(snapshots)
  writeFileSync(join(workspace, "state.txt"), "original pre-image")
  const layer = () => directoryJj({ workspace, snapshots, log: { snapshots: [], restores: [] } })
  const snapshot = () => Effect.gen(function*() {
    const jj = yield* Jj.Jj
    return yield* jj.snapshot("attempt 1")
  }).pipe(Effect.provide(layer()))
  const restore = (id: string) => Effect.gen(function*() {
    const jj = yield* Jj.Jj
    yield* jj.restore(id as never)
  }).pipe(Effect.provide(layer()))
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
    vi.mocked(cpSync).mockImplementationOnce((_source, destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(String(destination), "partial.txt"), "partial copy")
      throw new Error("injected copy failure")
    })
    const result = yield* Effect.exit(f.restore(saved.commitId))
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
    vi.mocked(cpSync).mockImplementationOnce((_source, destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(String(destination), "partial.txt"), "partial copy")
      throw new Error("injected copy failure")
    })
    const result = yield* Effect.exit(f.snapshot())
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
    const fs = yield* Effect.promise(() => vi.importActual<typeof import("node:fs")>("node:fs"))
    vi.mocked(renameSync)
      .mockImplementationOnce(fs.renameSync)
      .mockImplementationOnce(() => { throw new Error("injected swap failure") })
    const result = yield* Effect.exit(f.restore(saved.commitId))
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
    const fs = yield* Effect.promise(() => vi.importActual<typeof import("node:fs")>("node:fs"))
    vi.mocked(renameSync)
      .mockImplementationOnce(fs.renameSync)
      .mockImplementationOnce(() => { throw new Error("injected swap failure") })
      .mockImplementationOnce(() => { throw new Error("injected rollback failure") })
    const result = yield* Effect.exit(f.restore(saved.commitId))
    expect(result._tag).toBe("Failure")
    const retained = readdirSync(f.root).filter((name) => name.startsWith(".restore-"))
    expect(retained).toHaveLength(1)
    expect(readFileSync(join(f.root, retained[0]!, "backup", "state.txt"), "utf8"))
      .toBe("only surviving workspace data")
  }))
