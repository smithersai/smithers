import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { generatedMark, workspace } from "../../src/native/index.ts"
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

describe("workspace", { timeout: 300_000 }, () => {
  it("finds the workspace an owner wrote, at the root or under .smithers", async () => {
    expect(await onNode(workspace(repo({ "WORKSPACE.ts": ownWorkspace })))).toBe("WORKSPACE.ts")
    expect(await onNode(workspace(repo({ ".smithers/WORKSPACE.ts": ownWorkspace })))).toBe(".smithers/WORKSPACE.ts")
    const both = repo({ ".smithers/WORKSPACE.ts": ownWorkspace, "WORKSPACE.ts": ownWorkspace })
    expect(await onNode(workspace(both))).toBe(".smithers/WORKSPACE.ts")
  })

  it("finds an owner's plain workspace file, after .smithers/WORKSPACE.ts and before the root", async () => {
    const plain = ".smithers/WORKSPACE.smithers"
    expect(await onNode(workspace(repo({ [plain]: "an owner wrote this\n" })))).toBe(plain)
    expect(await onNode(workspace(repo({ [plain]: generatedText })))).toBeUndefined()
    expect(await onNode(workspace(repo({ [plain]: "an owner wrote this\n", "WORKSPACE.ts": ownWorkspace })))).toBe(
      plain
    )
    const typed = repo({ ".smithers/WORKSPACE.ts": ownWorkspace, [plain]: "an owner wrote this\n" })
    expect(await onNode(workspace(typed))).toBe(".smithers/WORKSPACE.ts")
    expect(await onNode(workspace(repo({ [plain]: generatedText, "WORKSPACE.ts": ownWorkspace })))).toBe("WORKSPACE.ts")
  })

  it("finds none in a repository without one, or with one smithers-ci generated", async () => {
    expect(await onNode(workspace(repo({ "README.md": "plain\n" })))).toBeUndefined()
    expect(await onNode(workspace(repo({ ".smithers/WORKSPACE.ts": generatedText })))).toBeUndefined()
    const mixed = repo({ ".smithers/WORKSPACE.ts": generatedText, "WORKSPACE.ts": ownWorkspace })
    expect(await onNode(workspace(mixed))).toBe("WORKSPACE.ts")
  })

  it("finds none where a file stands in place of the directory, and still finds one at the root", async () => {
    expect(await onNode(workspace(repo({ ".smithers": "a file\n" })))).toBeUndefined()
    expect(await onNode(workspace(repo({ ".smithers": "a file\n", "WORKSPACE.ts": ownWorkspace })))).toBe(
      "WORKSPACE.ts"
    )
  })

  it("counts a directory at the workspace file's path as the owner's", async () => {
    const root = repo({ ".smithers/WORKSPACE.ts/kept": "x\n" })
    expect(await onNode(workspace(root))).toBe(".smithers/WORKSPACE.ts")
  })

  it("counts a workspace file it cannot read as the owner's", async () => {
    const root = repo({ "README.md": "plain\n" })
    const found = await onNode(Effect.provide(workspace(root), unreadable))
    expect(found).toBe(".smithers/WORKSPACE.ts")
  })
})
