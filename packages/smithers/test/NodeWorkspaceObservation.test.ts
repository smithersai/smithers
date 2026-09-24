import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Effect, Exit, FileSystem, Logger } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { host } from "../src/internal/NodeWorkspaceObservation.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, "locked"), 0o755)
    } catch {
      // Only the permission case creates it.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

const workspace = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-node-observation-")))
  roots.push(root)
  return root
}

const write = (root: string, relative: string, text: string): void => {
  mkdirSync(dirname(join(root, relative)), { recursive: true })
  writeFileSync(join(root, relative), text)
}

/** Every shape the walk has a rule for. */
const tree = (): string => {
  const root = workspace()
  write(root, "b.py", "two")
  write(root, "a.py", "one")
  write(root, "src/deep/c.ts", "three")
  write(root, "src/z.ts", "four")
  write(root, "node_modules/pkg/index.js", "derived")
  write(root, "module.pyc", "derived")
  mkdirSync(join(root, "empty"))
  symlinkSync(join(root, "a.py"), join(root, "link-to-file"))
  symlinkSync(join(root, "src"), join(root, "link-to-directory"))
  return root
}

const portable = (root: string, options?: WorkspaceObservation.Options) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => WorkspaceObservation.observe(fs, root, options)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )

const native = (root: string, options?: WorkspaceObservation.Options) =>
  Effect.runPromise(WorkspaceObservation.observeHost(host, root, options))

describe("NodeWorkspaceObservation.host", () => {
  it("measures the same tree the portable FileSystem walk measures", async () => {
    const root = tree()

    const [expected, actual] = await Promise.all([portable(root), native(root)])

    expect(actual).toEqual(expected)
    expect(actual.paths).toBe(4)
    expect(actual.complete).toBe(true)
  })

  it("stops at the same prefix as the portable walk and says it is partial", async () => {
    const root = tree()

    const [expected, actual] = await Promise.all([portable(root, { maxPaths: 3 }), native(root, { maxPaths: 3 })])

    expect(actual).toEqual(expected)
    expect(actual.complete).toBe(false)
  })

  it("moves when a file's size changes", async () => {
    const root = tree()
    const before = await native(root)

    write(root, "src/deep/c.ts", "three, longer")

    expect((await native(root)).digest).not.toBe(before.digest)
  })

  it("skips workspace caches and worktrees", async () => {
    const root = workspace()
    write(root, "kept.ts", "one")
    const before = await native(root)
    for (const name of [".artifacts", ".backend-go-modcache", ".pnpm-store", ".worktrees", "worktrees"]) {
      write(root, `${name}/generated.ts`, "generated")
    }
    expect(await native(root)).toEqual(before)
  })

  it("reports a missing directory as NotFound, so the walk reads it as movement", async () => {
    const root = workspace()

    const exit = await Effect.runPromise(Effect.exit(host.entries(join(root, "gone"), () => true)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("NotFound")
    }
  })

  it.skipIf(process.getuid?.() === 0)("reports an unreadable directory as incomplete coverage", async () => {
    const root = workspace()
    write(root, "kept.py", "visible")
    write(root, "locked/hidden.py", "unreadable")
    chmodSync(join(root, "locked"), 0o000)
    const diagnostics: Array<unknown> = []
    const capture = Logger.make((entry) => {
      diagnostics.push(entry.message)
    })

    const observation = await Effect.runPromise(
      WorkspaceObservation.observeHost(host, root).pipe(
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
      )
    )

    expect(observation.paths).toBe(1)
    expect(observation.complete).toBe(false)
    expect(diagnostics).toHaveLength(1)
    expect(JSON.stringify(diagnostics[0])).toContain("PermissionDenied")
  })
})
