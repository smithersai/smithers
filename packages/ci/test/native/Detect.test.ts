import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { generatedMark, replaced, workspace } from "../../src/native/index.ts"
import { ownPackage, ownWorkspace, repository } from "./repo.ts"
import { unreadable } from "./support.vibe"

const made: Array<string> = []
const repo = (files: Readonly<Record<string, string>>): string => {
  const root = repository(files)
  made.push(root)
  return root
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const onNode = <A>(work: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.provide(work, NodeServices.layer))

const generatedText = `${generatedMark} Do not edit.\n`
const generatedFiles = [
  { path: ".smithers/WORKSPACE.ts", content: generatedText },
  { path: "PACKAGE.ts", content: generatedText },
  { path: ".github/workflows/smithers-ci.yml", content: "# generated\n" }
]

describe("workspace", { timeout: 300_000 }, () => {
  it("finds the workspace an owner wrote, at the root or under .smithers", async () => {
    expect(await onNode(workspace(repo({ "WORKSPACE.ts": ownWorkspace })))).toBe("WORKSPACE.ts")
    expect(await onNode(workspace(repo({ ".smithers/WORKSPACE.ts": ownWorkspace })))).toBe(".smithers/WORKSPACE.ts")
    const both = repo({ ".smithers/WORKSPACE.ts": ownWorkspace, "WORKSPACE.ts": ownWorkspace })
    expect(await onNode(workspace(both))).toBe(".smithers/WORKSPACE.ts")
  })

  it("finds none in a repository without one, or with one smithers-ci generated", async () => {
    expect(await onNode(workspace(repo({ "README.md": "plain\n" })))).toBeUndefined()
    expect(await onNode(workspace(repo({ ".smithers/WORKSPACE.ts": generatedText })))).toBeUndefined()
    const mixed = repo({ ".smithers/WORKSPACE.ts": generatedText, "WORKSPACE.ts": ownWorkspace })
    expect(await onNode(workspace(mixed))).toBe("WORKSPACE.ts")
  })

  it("counts a workspace file it cannot read as the owner's", async () => {
    const root = repo({ "README.md": "plain\n" })
    const found = await onNode(Effect.provide(workspace(root), unreadable))
    expect(found).toBe(".smithers/WORKSPACE.ts")
  })
})

describe("replaced", { timeout: 300_000 }, () => {
  it("lists the generated build files that would replace an owner's file", async () => {
    const root = repo({ "PACKAGE.ts": ownPackage, ".github/workflows/smithers-ci.yml": "on: [push]\n" })
    expect(await onNode(replaced(root, generatedFiles))).toEqual(["PACKAGE.ts"])
  })

  it("lists nothing when the files are absent or were generated", async () => {
    expect(await onNode(replaced(repo({ "README.md": "plain\n" }), generatedFiles))).toEqual([])
    const applied = repo({ "PACKAGE.ts": generatedText, ".smithers/WORKSPACE.ts": generatedText })
    expect(await onNode(replaced(applied, generatedFiles))).toEqual([])
  })

  it("counts a build file it cannot read as the owner's", async () => {
    const root = repo({ "README.md": "plain\n" })
    expect(await onNode(Effect.provide(replaced(root, generatedFiles), unreadable))).toEqual([
      ".smithers/WORKSPACE.ts",
      "PACKAGE.ts"
    ])
  })
})
