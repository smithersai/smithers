import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import { Repository } from "../src/index.ts"
import { quoteGitPatchPaths } from "../src/internal/gitPatchPaths.ts"

const blobText = Array.from(
  { length: 64 },
  (_, index) => `export const value_${index} = "${"x".repeat(48)}";\n`
).join("")

const sampleBlobOid = await Effect.runPromise(Repository.hashBlob(blobText))

const treeEntries: ReadonlyArray<Repository.TreeEntry> = Array.from({ length: 32 }, (_, index) => ({
  name: `module-${String(index).padStart(2, "0")}.ts`,
  mode: "100644" as const,
  oid: sampleBlobOid
}))

const sampleTreeOid = await Effect.runPromise(Repository.hashTree(treeEntries))

const person: Repository.Person = {
  name: "Smithers Bench",
  email: "bench@smithers.sh",
  seconds: 1_763_856_000
}

const commitObject: Repository.CommitObject = {
  tree: sampleTreeOid,
  parents: [],
  author: person,
  committer: person,
  message: "feat: benchmark commit object encoding and hashing"
}

// Build a realistic 20-file unified git diff + jj JSON path metadata.
const diffChunks: Array<string> = []
const pathLines: Array<string> = []
for (let i = 0; i < 20; i++) {
  const file = i % 5 === 0
    ? `packages/smithers/flows/dir with space/file_${i}.ts`
    : `packages/smithers/flows/src/file_${i}.ts`
  pathLines.push(JSON.stringify(file), JSON.stringify(file))
  diffChunks.push(
    `diff --git a/${file} b/${file}\n` +
      `index 1111111..2222222 100644\n` +
      `--- a/${file}\n` +
      `+++ b/${file}\n` +
      `@@ -1,3 +1,4 @@\n` +
      ` export const a = ${i}\n` +
      `+export const b = ${i + 1}\n` +
      ` export const c = ${i + 2}\n`
  )
}
const unifiedPatch = diffChunks.join("")
const pathMetadata = `${pathLines.join("\n")}\n`

const repo = Repository.makeMemory()
let refSeq = 0
let currentTip: Repository.ObjectId | null = null

const repoWriteAndSwap = Effect.gen(function*() {
  const b = yield* repo.writeBlob(`change-${refSeq++}`)
  const t = yield* repo.writeTree([{ name: "state.txt", mode: "100644", oid: b }])
  const c = yield* repo.writeCommit({
    tree: t,
    parents: currentTip === null ? [] : [currentTip],
    author: person,
    committer: person,
    message: `commit ${refSeq}`
  })
  yield* repo.updateRefs({
    operation: `bench-cas-${refSeq}`,
    updates: [{ ref: "refs/heads/bench", before: currentTip, after: c }]
  })
  currentTip = c
})

const hashBlobEffect = Repository.hashBlob(blobText)
const hashTreeEffect = Repository.hashTree(treeEntries)
const hashCommitEffect = Repository.hashCommit(commitObject)
const isRefNameFn = Repository.isRefName
const quotePatchFn = quoteGitPatchPaths
const runPromise = Effect.runPromise
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/jj", () => {
  test("Repository.hashBlob (4 KB)", async ({ bench }) => {
    await bench("hashBlob (4 KB)", () => runPromise(hashBlobEffect)).run(opts)
  })

  test("Repository.hashTree (32 entries)", async ({ bench }) => {
    await bench("hashTree (32 entries)", () => runPromise(hashTreeEffect)).run(opts)
  })

  test("Repository.hashCommit", async ({ bench }) => {
    await bench("hashCommit", () => runPromise(hashCommitEffect)).run(opts)
  })

  test("Repository.makeMemory blob + tree + commit + CAS updateRefs", async ({ bench }) => {
    await bench("MemoryRepository write + CAS", () => runPromise(repoWriteAndSwap)).run(opts)
  })

  test("Repository.isRefName validation", async ({ bench }) => {
    await bench("isRefName", () => {
      isRefNameFn("refs/heads/feature/bench-perf-123")
    }).run(opts)
  })

  test("quoteGitPatchPaths on 20-file unified diff", async ({ bench }) => {
    await bench("quoteGitPatchPaths (20 files)", () => {
      quotePatchFn(unifiedPatch, pathMetadata)
    }).run(opts)
  })
})
