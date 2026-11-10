/**
 * Cache replay writes and deletes whatever boundary evidence names. The
 * lexical `FileSet.workspaceRelative` check refuses absolute and upward
 * spellings, but a lexically valid path can still leave the workspace through
 * a symlink planted on it. Production hands the boundary the raw host
 * (`AtomicFileSystem.layer`, not the kernel guard), so replay must confine its
 * own mutations: every write, removal, and prune walk goes through
 * `@smthrs/kernel/FileSystem`'s `confined` view, and a host that cannot be
 * confined refuses replay before touching anything.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as StepBoundary from "../src/StepBoundary.vibe"
import { sha256, withCrypto } from "./Sha256.ts"
import { win32Host } from "./Win32Host.ts"

const bytes = new TextEncoder().encode("replayed")

const written = (path: string) => ({
  path,
  digest: sha256(bytes),
  sizeBytes: bytes.length,
  content: Base64.encode(bytes)
})

const evidence = (
  outputs: ReadonlyArray<unknown>,
  trees?: ReadonlyArray<{ readonly path: string; readonly identity: string }>
): StepBoundary.BoundaryEvidence => ({
  declaredOutputs: { outputs, ...(trees === undefined ? {} : { trees }) },
  diffIdentity: "confinement"
})

/** A workspace and a directory outside it, both disposable. */
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "step-boundary-confinement-"))
  const workspace = join(base, "workspace")
  const external = join(base, "external")
  mkdirSync(workspace)
  mkdirSync(external)
  writeFileSync(join(external, "victim"), "keep me")
  return { base, workspace, external, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/** The composition `NativeRuntime.layerHost` hands the boundary. */
const productionHost = (root: string) =>
  StepBoundary.layer.pipe(
    Layer.provide(Layer.succeed(ArtifactStore.ArtifactStore)(ArtifactStore.makeMemory())),
    Layer.provide(Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer, KernelWorkspace.layer(root)))
  )

const replay = (
  layer: Layer.Layer<StepBoundary.Service>,
  recorded: StepBoundary.BoundaryEvidence
) =>
  withCrypto(
    Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.exit(boundary.replayOutputs(recorded))
    }).pipe(Effect.provide(layer))
  )

const refusedWith = (exit: unknown) =>
  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: { reasons: [{ error: { _tag: "@smthrs/engine-store/UnsupportedBoundary" } }] }
  })

describe("StepBoundary replay confinement", () => {
  it.effect("refuses a write and a removal through a symlinked parent on the production host", () =>
    Effect.gen(function*() {
      const paths = fixture()
      try {
        symlinkSync(paths.external, join(paths.workspace, "out"))
        const exit = yield* replay(
          productionHost(paths.workspace),
          evidence([written("safe.txt"), written("out/result"), { path: "out/victim", digest: null }])
        )
        refusedWith(exit)
        // The unlinked path landed first, so the refusal is the symlink, not
        // a host that could not run at all.
        expect(readFileSync(join(paths.workspace, "safe.txt"), "utf8")).toBe("replayed")
        expect(existsSync(join(paths.external, "result"))).toBe(false)
        expect(readFileSync(join(paths.external, "victim"), "utf8")).toBe("keep me")
      } finally {
        paths.dispose()
      }
    }))

  it.effect("refuses a removal-only evidence through a symlinked parent", () =>
    Effect.gen(function*() {
      const paths = fixture()
      try {
        symlinkSync(paths.external, join(paths.workspace, "out"))
        writeFileSync(join(paths.workspace, "gone.txt"), "stale")
        const exit = yield* replay(
          productionHost(paths.workspace),
          evidence([{ path: "gone.txt", digest: null }, { path: "out/victim", digest: null }])
        )
        refusedWith(exit)
        expect(existsSync(join(paths.workspace, "gone.txt"))).toBe(false)
        expect(readFileSync(join(paths.external, "victim"), "utf8")).toBe("keep me")
      } finally {
        paths.dispose()
      }
    }))

  it.effect("never prunes through a symlinked directory inside a replayed tree", () =>
    Effect.gen(function*() {
      const paths = fixture()
      try {
        mkdirSync(join(paths.workspace, "dist"))
        writeFileSync(join(paths.workspace, "dist/stale.txt"), "stale")
        symlinkSync(paths.external, join(paths.workspace, "dist/linked"))
        const exit = yield* replay(
          productionHost(paths.workspace),
          evidence([written("dist/a.txt")], [{ path: "dist", identity: "tree" }])
        )
        refusedWith(exit)
        expect(existsSync(join(paths.workspace, "dist/linked"))).toBe(true)
        expect(readFileSync(join(paths.external, "victim"), "utf8")).toBe("keep me")
      } finally {
        paths.dispose()
      }
    }))

  it.effect("materializes under the workspace root, not the process working directory", () =>
    Effect.gen(function*() {
      const paths = fixture()
      try {
        writeFileSync(join(paths.workspace, "stale.txt"), "stale")
        const exit = yield* replay(
          productionHost(paths.workspace),
          evidence([written("out/nested/result"), { path: "stale.txt", digest: null }])
        )
        expect(exit).toMatchObject({ _tag: "Success" })
        expect(readFileSync(join(paths.workspace, "out/nested/result"), "utf8")).toBe("replayed")
        expect(existsSync(join(paths.workspace, "stale.txt"))).toBe(false)
        expect(existsSync(join(process.cwd(), "out/nested/result"))).toBe(false)
      } finally {
        paths.dispose()
      }
    }))

  it.effect("refuses replay over a path-based host before any host call", () =>
    Effect.gen(function*() {
      const paths = fixture()
      try {
        const layer = StepBoundary.layer.pipe(
          Layer.provide(Layer.succeed(ArtifactStore.ArtifactStore)(ArtifactStore.makeMemory())),
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, KernelWorkspace.layer(paths.workspace)))
        )
        const exit = yield* replay(layer, evidence([written("result"), { path: "gone", digest: null }]))
        refusedWith(exit)
        expect(existsSync(join(paths.workspace, "result"))).toBe(false)
      } finally {
        paths.dispose()
      }
    }))

  /**
   * Issue #3911: `prepare` and `settle` handed the raw host workspace-relative
   * paths, which a path-based host resolves against the process working
   * directory. A same-named file there answered the dirty check, so a stale
   * declaration passed and a cache hit served a result computed from other
   * bytes. Every measurement resolves against the workspace root, the root the
   * step's own FileSystem sees.
   */
  it.effect("measures reads and writes under the workspace root, not the process working directory", () =>
    Effect.gen(function*() {
      const paths = fixture()
      const cwd = join(paths.base, "cwd")
      const plant = (root: string, files: Record<string, string>) => {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(join(root, path, ".."), { recursive: true })
          writeFileSync(join(root, path), content)
        }
      }
      plant(paths.workspace, {
        "docs/a.md": "workspace",
        "docs/only-workspace.md": "w",
        "out/result": "built",
        "dist/x.txt": "tree"
      })
      plant(cwd, { "docs/a.md": "cwd", "docs/only-cwd.md": "c", "out/result": "stale", "dist/y.txt": "other" })
      const previous = process.cwd()
      process.chdir(cwd)
      try {
        const measured = yield* withCrypto(
          Effect.gen(function*() {
            const boundary = yield* StepBoundary.StepBoundary
            const exact = (digest: string) =>
              boundary.prepare({ readSet: [{ path: "docs/a.md", digest }], writeSet: [], boundaryMode: "hard" })
            const workspaceDeclared = yield* exact(sha256("workspace"))
            const cwdDeclared = yield* exact(sha256("cwd"))
            const globbed = yield* boundary.prepare({
              readSet: [{ _tag: "Glob", include: ["docs/**"] }],
              writeSet: [],
              boundaryMode: "hard"
            })
            const settled = yield* boundary.settle(
              yield* boundary.prepare({
                readSet: [],
                writeSet: ["out/result", { _tag: "TreeArtifact", path: "dist" }],
                boundaryMode: "hard"
              })
            )
            return { workspaceDeclared, cwdDeclared, globbed, settled }
          }).pipe(Effect.provide(productionHost(paths.workspace)))
        )
        expect(measured.workspaceDeclared.readSnapshot).toEqual([{ path: "docs/a.md", digest: sha256("workspace") }])
        expect(StepBoundary.readSetMatches(measured.workspaceDeclared)).toBe(true)
        expect(StepBoundary.readSetMatches(measured.cwdDeclared)).toBe(false)
        expect(measured.globbed.readSnapshot).toEqual([
          { path: "docs/a.md", digest: sha256("workspace") },
          { path: "docs/only-workspace.md", digest: sha256("w") }
        ])
        expect(measured.settled.deviation).toBeUndefined()
        expect(measured.settled.declaredOutputs).toMatchObject({
          outputs: [
            { path: "dist/x.txt", digest: sha256("tree") },
            { path: "out/result", digest: sha256("built") }
          ],
          trees: [{ path: "dist" }]
        })
      } finally {
        process.chdir(previous)
        paths.dispose()
      }
    }))

  it.effect("pins replay to a Windows drive root through the host Path", () =>
    Effect.gen(function*() {
      const root = "D:\\a\\kernel"
      const host = win32Host(root)
      const layer = StepBoundary.layer.pipe(
        Layer.provide(Layer.succeed(ArtifactStore.ArtifactStore)(ArtifactStore.makeMemory())),
        Layer.provide(Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem)(host.fs),
          NodePath.layerWin32,
          KernelWorkspace.layer(root)
        ))
      )
      const exit = yield* replay(layer, evidence([{ path: "gone.txt", digest: null }]))
      expect(exit).toMatchObject({ _tag: "Success" })
      expect(host.realPaths).toEqual([root])
      expect(host.requests).toMatchObject([
        { operation: "remove", path: "D:\\a\\kernel\\gone.txt", logicalRoot: root, boundaryRoot: root }
      ])
    }))
})
