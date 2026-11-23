import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"

const multiFilePatch = [
  "*** Begin Patch",
  ...Array.from({ length: 12 }, (_, i) => [
    `*** Update File: src/mod-${i}.ts`,
    "@@",
    ` export const a${i} = 1`,
    `-export const b${i} = 2`,
    `+export const b${i} = 3`
  ]).flat(),
  "*** End Patch"
].join("\n")

const treeStdoutA = "2489172341 51200\n1250\n"
const treeStdoutB = "2489172999 51240\n1251\n"

const nodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

describe("std hot paths", () => {
  let dir = ""
  let counter = 0

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "smithers-std-bench-"))
  })

  afterAll(() => {
    if (dir !== "") {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ApplyPatch.paths", async ({ bench }) => {
    await bench("extract paths from 12-file patch", () => {
      ApplyPatch.paths(multiFilePatch)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("TreeFingerprint.parse and moved", async ({ bench }) => {
    await bench("parse tree fingerprints + detect tree mutation", () => {
      const before = TreeFingerprint.parse(treeStdoutA)
      const after = TreeFingerprint.parse(treeStdoutB)
      TreeFingerprint.moved(before, after)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ApplyPatch.run on temp file", async ({ bench }) => {
    await bench("apply single-file patch via NodeFileSystem", async () => {
      const file = join(dir, `target-${counter++}.ts`)
      writeFileSync(file, "export const x = 1\nexport const y = 2\n")
      const patch = [
        "*** Begin Patch",
        `*** Update File: ${file}`,
        "@@",
        " export const x = 1",
        "-export const y = 2",
        "+export const y = 42",
        "*** End Patch"
      ].join("\n")
      await Effect.runPromise(
        ApplyPatch.run({ input: patch }).pipe(Effect.provide(nodeLayer))
      )
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })
})
