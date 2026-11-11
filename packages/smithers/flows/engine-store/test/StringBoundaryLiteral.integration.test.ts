/**
 * A plain string in a file boundary means one literal path everywhere it is
 * read (#2440): static overlap, hard sandbox admission, copy-back, capture,
 * removal, and replay. A path holding `*` used to be a pattern to the sandbox
 * and to `FileSet.overlaps` but a literal file name to `StepBoundary`, so a
 * transaction could copy back `out/a.js` and then fail settlement looking for
 * a file named `out/*.js`. Each case here runs the real filesystem-backed
 * sandbox and the real filesystem `StepBoundary` over one temporary workspace.
 */
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as FileSet from "@smthrs/plan/FileSet"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const encoder = new TextEncoder()

const boundary = (input: Partial<FileBoundary>): FileBoundary => ({
  readSet: input.readSet ?? [],
  writeSet: input.writeSet ?? [],
  ...(input.removes === undefined ? {} : { removes: input.removes }),
  boundaryMode: "hard"
})

/** The kernel-guarded Node host a step body and its boundary see, rooted at the workspace. */
const host = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provideMerge(NodePath.layer),
    Layer.provide(AtomicFileSystem.layer),
    Layer.provide(KernelWorkspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

type Step = {
  readonly write?: ReadonlyArray<string>
  readonly remove?: ReadonlyArray<string>
  readonly beforeMaterialize?: (root: string) => void
}

/**
 * Prepares the boundary, runs the body through the hard sandbox, copies an
 * accepted result back, settles the boundary, and replays the settled
 * evidence onto a second workspace, as `ActionPersistence` sequences them.
 */
const run = (seed: Record<string, string>, descriptor: FileBoundary, step: Step) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "string-boundary-")))
  const root = join(base, "run")
  const replayRoot = join(base, "replay")
  for (const workspace of [root, replayRoot]) {
    mkdirSync(workspace)
    for (const [path, content] of Object.entries(seed)) {
      mkdirSync(join(workspace, path, ".."), { recursive: true })
      writeFileSync(join(workspace, path), content)
    }
  }
  const artifacts = ArtifactStore.makeMemory()
  const program = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, artifacts, root)
    const stepBoundary = StepBoundary.makeFileSystem(fs, hostPath, artifacts)
    const prepared = yield* stepBoundary.prepare(descriptor)
    const execution = yield* sandbox.execute({
      descriptor,
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        for (const path of step.write ?? []) yield* workspace.writeFile(path, encoder.encode(`bytes of ${path}`))
        for (const path of step.remove ?? []) yield* workspace.removeFile(path)
        return null
      })
    })
    if (execution._tag !== "Accepted") return { execution, settled: undefined }
    step.beforeMaterialize?.(root)
    yield* sandbox.materialize(execution)
    const settled = yield* Effect.exit(stepBoundary.settle(prepared))
    return { execution, settled }
  }).pipe(Effect.provide(host(root)))
  const replay = (evidence: StepBoundary.BoundaryEvidence) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* StepBoundary.makeFileSystem(fs, hostPath, artifacts).replayOutputs(evidence)
    }).pipe(Effect.provide(host(replayRoot)))
  return {
    root,
    replayRoot,
    program: withCrypto(program),
    replay: (evidence: StepBoundary.BoundaryEvidence) => withCrypto(replay(evidence)),
    dispose: () => rmSync(base, { recursive: true, force: true })
  }
}

const outputs = (evidence: StepBoundary.BoundaryEvidence) =>
  (evidence.declaredOutputs as {
    readonly outputs: ReadonlyArray<{ readonly path: string; readonly digest: string | null }>
  }).outputs.map(({ digest, path }) => ({ path, digest }))

describe("a plain string file boundary is one literal path end to end", () => {
  it.effect("refuses a concrete write under a string holding *, which static overlap also keeps apart", () =>
    Effect.gen(function*() {
      const descriptor = boundary({ writeSet: ["out/*.js"] })
      expect(FileSet.overlaps("out/*.js", "out/a.js")).toBe(false)
      const fixture = run({}, descriptor, { write: ["out/a.js"] })
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution).toMatchObject({
          _tag: "Invalidated",
          violations: [{ kind: "undeclared-write", resource: { kind: "file", id: "out/a.js" } }]
        })
        expect(settled).toBeUndefined()
        expect(existsSync(join(fixture.root, "out/a.js"))).toBe(false)
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("admits, captures, and replays a file literally named with *", () =>
    Effect.gen(function*() {
      const descriptor = boundary({ writeSet: ["out/*.js"] })
      expect(FileSet.overlaps("out/*.js", "out/*.js")).toBe(true)
      const fixture = run({}, descriptor, { write: ["out/*.js"] })
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution._tag).toBe("Accepted")
        expect(settled?._tag).toBe("Success")
        if (settled?._tag !== "Success") throw new Error("expected settlement")
        expect(outputs(settled.value)).toEqual([{ path: "out/*.js", digest: sha256("bytes of out/*.js") }])
        yield* fixture.replay(settled.value)
        expect(readFileSync(join(fixture.replayRoot, "out/*.js"), "utf8")).toBe("bytes of out/*.js")
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("keeps wildcard matching in a Glob, from admission through capture", () =>
    Effect.gen(function*() {
      const descriptor = boundary({ writeSet: [{ _tag: "Glob", include: ["out/*.js"] }] })
      expect(FileSet.overlaps({ _tag: "Glob", include: ["out/*.js"] }, "out/a.js")).toBe(true)
      const fixture = run({}, descriptor, { write: ["out/a.js"] })
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution._tag).toBe("Accepted")
        if (settled?._tag !== "Success") throw new Error("expected settlement")
        expect(outputs(settled.value)).toEqual([{ path: "out/a.js", digest: sha256("bytes of out/a.js") }])
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("removes only the literal path a string removal names, and replays that removal", () =>
    Effect.gen(function*() {
      const seed = { "old/*.txt": "star", "old/a.txt": "kept" }
      const descriptor = boundary({ removes: ["old/*.txt"] })
      const fixture = run(seed, descriptor, { remove: ["old/*.txt"] })
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution._tag).toBe("Accepted")
        if (settled?._tag !== "Success") throw new Error("expected settlement")
        expect(outputs(settled.value)).toEqual([{ path: "old/*.txt", digest: null }])
        expect(existsSync(join(fixture.root, "old/*.txt"))).toBe(false)
        expect(readFileSync(join(fixture.root, "old/a.txt"), "utf8")).toBe("kept")
        yield* fixture.replay(settled.value)
        expect(existsSync(join(fixture.replayRoot, "old/*.txt"))).toBe(false)
        expect(readFileSync(join(fixture.replayRoot, "old/a.txt"), "utf8")).toBe("kept")
      } finally {
        fixture.dispose()
      }

      // A declared read is visible to the body, but deleting it still needs
      // a matching write or removal declaration.
      const concrete = run(
        seed,
        boundary({ readSet: [{ path: "old/a.txt", digest: sha256("kept") }], removes: ["old/*.txt"] }),
        { remove: ["old/a.txt"] }
      )
      try {
        const { execution } = yield* concrete.program
        expect(execution).toMatchObject({
          _tag: "Invalidated",
          violations: [{ kind: "undeclared-write", resource: { kind: "file", id: "old/a.txt" } }]
        })
        expect(readFileSync(join(concrete.root, "old/a.txt"), "utf8")).toBe("kept")
      } finally {
        concrete.dispose()
      }
    }))
})

describe("sandbox output ownership", () => {
  for (
    const write of [
      { _tag: "TreeArtifact" as const, path: "out" },
      { _tag: "Glob" as const, include: ["out/**"] as [string] }
    ]
  ) {
    it.effect(`captures and replays only transaction files for a ${write._tag} output`, () =>
      Effect.gen(function*() {
        const seed = { "out/stale.js": "stale", "out/.hidden.js": "hidden", "other/keep.js": "keep" }
        const fixture = run(seed, boundary({ writeSet: [write] }), {
          write: ["out/new.js"],
          beforeMaterialize: (root) => {
            expect(readFileSync(join(root, "out/stale.js"), "utf8")).toBe("stale")
            expect(existsSync(join(root, "out/new.js"))).toBe(false)
          }
        })
        try {
          const { execution, settled } = yield* fixture.program
          expect(execution._tag).toBe("Accepted")
          if (execution._tag !== "Accepted") throw new Error("expected execution")
          expect(
            execution.result.files.map(({ path, beforeDigest, afterDigest }) => ({ path, beforeDigest, afterDigest }))
          )
            .toEqual([
              { path: "out/.hidden.js", beforeDigest: sha256("hidden"), afterDigest: undefined },
              { path: "out/new.js", beforeDigest: undefined, afterDigest: sha256("bytes of out/new.js") },
              { path: "out/stale.js", beforeDigest: sha256("stale"), afterDigest: undefined }
            ])
          if (settled?._tag !== "Success") throw new Error("expected settlement")
          expect(outputs(settled.value)).toEqual([{ path: "out/new.js", digest: sha256("bytes of out/new.js") }])
          expect(existsSync(join(fixture.root, "out/stale.js"))).toBe(false)
          expect(existsSync(join(fixture.root, "out/.hidden.js"))).toBe(false)
          expect(readFileSync(join(fixture.root, "other/keep.js"), "utf8")).toBe("keep")
          yield* fixture.replay(settled.value)
          expect(readFileSync(join(fixture.replayRoot, "out/new.js"), "utf8")).toBe("bytes of out/new.js")
          if (write._tag === "TreeArtifact") {
            expect(existsSync(join(fixture.replayRoot, "out/stale.js"))).toBe(false)
          }
        } finally {
          fixture.dispose()
        }
      }))
  }

  it.effect("does not let an old literal output satisfy a hard boundary when the body produces nothing", () =>
    Effect.gen(function*() {
      const fixture = run({ "old.txt": "old" }, boundary({ writeSet: ["old.txt"] }), {})
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution._tag).toBe("Accepted")
        expect(existsSync(join(fixture.root, "old.txt"))).toBe(false)
        if (settled?._tag !== "Failure") throw new Error("expected missing declared output")
        expect(Cause.squash(settled.cause)).toMatchObject({
          _tag: "@smthrs/engine-store/MissingDeclaredOutput",
          paths: ["old.txt"]
        })
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("copies back an explicit delete of an unseeded host file", () =>
    Effect.gen(function*() {
      const fixture = run({ "old.txt": "old" }, boundary({ writeSet: ["old.txt"] }), { remove: ["old.txt"] })
      try {
        const { execution } = yield* fixture.program
        if (execution._tag !== "Accepted") throw new Error("expected execution")
        expect(execution.result.files).toEqual([{
          path: "old.txt",
          beforeDigest: sha256("old"),
          afterDigest: undefined
        }])
        expect(existsSync(join(fixture.root, "old.txt"))).toBe(false)
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("refuses an undeclared delete of an unseeded host file", () =>
    Effect.gen(function*() {
      const fixture = run({ "keep.txt": "keep" }, boundary({}), { remove: ["keep.txt"] })
      try {
        const { execution, settled } = yield* fixture.program
        expect(execution).toMatchObject({
          _tag: "Invalidated",
          violations: [{ kind: "undeclared-write", resource: { kind: "file", id: "keep.txt" } }]
        })
        expect(settled).toBeUndefined()
        expect(readFileSync(join(fixture.root, "keep.txt"), "utf8")).toBe("keep")
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("refuses stale-output cleanup if its host precondition changes before copy-back", () =>
    Effect.gen(function*() {
      const fixture = run(
        { "out/stale.js": "stale" },
        boundary({
          writeSet: [{ _tag: "TreeArtifact", path: "out" }]
        }),
        {
          write: ["out/new.js"],
          beforeMaterialize: (root) => writeFileSync(join(root, "out/stale.js"), "concurrent")
        }
      )
      try {
        expect(yield* Effect.flip(fixture.program)).toMatchObject({
          _tag: "@smthrs/engine-store/MaterializationConflict",
          paths: ["out/stale.js"]
        })
        expect(readFileSync(join(fixture.root, "out/stale.js"), "utf8")).toBe("concurrent")
        expect(existsSync(join(fixture.root, "out/new.js"))).toBe(false)
      } finally {
        fixture.dispose()
      }
    }))

  it.effect("preserves excluded glob members and declared read bytes", () =>
    Effect.gen(function*() {
      const seed = { "out/stale.js": "stale", "out/keep.js": "keep", "out/input.js": "input" }
      const fixture = run(
        seed,
        boundary({
          readSet: [{ path: "out/input.js", digest: sha256("input") }],
          writeSet: [{ _tag: "Glob", include: ["out/**"], exclude: ["out/keep.js"] }]
        }),
        { write: ["out/new.js"] }
      )
      try {
        const { settled } = yield* fixture.program
        if (settled?._tag !== "Success") throw new Error("expected settlement")
        expect(outputs(settled.value)).toEqual([
          { path: "out/input.js", digest: sha256("input") },
          { path: "out/new.js", digest: sha256("bytes of out/new.js") }
        ])
        expect(existsSync(join(fixture.root, "out/stale.js"))).toBe(false)
        expect(readFileSync(join(fixture.root, "out/keep.js"), "utf8")).toBe("keep")
      } finally {
        fixture.dispose()
      }
    }))
})
