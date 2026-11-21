/**
 * A step that leaves a directory deeper than the longest path the system
 * takes (PATH_MAX, 4096 bytes on Linux). The sixth ship review's rec6long: the
 * replay could not remove the job's copy before the next commit and ended
 * with exit 4. It now gives every commit's verdict, as the CI `apply` writes
 * already does.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { files } from "../../src/generate/index.ts"
import { removeTree } from "../../src/replay/Confine.vibe"
import { Options, run } from "../../src/replay/index.ts"
import { keptRemoving, noRemoving } from "./Dying.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const path of created) execFileSync("rm", ["-rf", "--", path])
})

/** Makes, under `build`, 45 directories of 100 bytes each, one in the other: 4,500 bytes, past PATH_MAX. */
const deep =
  "mkdir -p build && cd build && i=0 && while [ $i -lt 45 ]; do d=d$i$(printf '%097d' 0); mkdir -p $d && cd $d; i=$((i+1)); done && echo deep > leaf"

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Deep", "-c", "user.email=deep@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

const replay = (root: string, commits: number) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"] }, { ...parts("none"), files } as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs] as const,
          reruns: 0,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

describe("a step that leaves a directory deeper than the longest path", { timeout: 900_000 }, () => {
  it("gives every commit its verdict, both ways", async () => {
    const root = makeSmallRepository([job("deep", deep)])
    created.push(root)
    git(root, "commit", "--quiet", "--allow-empty", "-m", "two")
    git(root, "commit", "--quiet", "--allow-empty", "-m", "three")
    const report = await replay(root, 3)
    expect(report.stopped).toBeUndefined()
    expect(report.commits).toHaveLength(3)
    for (const replayed of report.commits) {
      expect([replayed.baseline.ok, replayed.normal.ok]).toEqual([true, true])
    }
    expect(report.mismatches).toBe(0)
  })
})

describe("removing a tree", { timeout: 120_000 }, () => {
  const made = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "remove-tree-"))
    created.push(directory)
    execFileSync("sh", ["-c", deep], { cwd: directory })
    return join(directory, "build")
  }
  const removing = (directory: string, layer: Layer.Layer<never> | undefined = undefined) =>
    Effect.runPromise(
      (layer === undefined ? removeTree(directory) : Effect.provide(removeTree(directory), layer)).pipe(
        Effect.provide(NodeServices.layer)
      ) as Effect.Effect<void, unknown>
    )

  it("removes one deeper than the longest path, which the platform's removal cannot", async () => {
    const tree = made()
    await removing(tree)
    expect(existsSync(tree)).toBe(false)
    // Where the platform's removal fails for any reason, rm removes the tree.
    const again = made()
    await removing(again, noRemoving as never)
    expect(existsSync(again)).toBe(false)
  })

  it("fails with the platform's error when the tree is still there after rm", async () => {
    const tree = made()
    await expect(removing(tree, keptRemoving as never)).rejects.toMatchObject({ _tag: "PlatformError" })
  })
})
