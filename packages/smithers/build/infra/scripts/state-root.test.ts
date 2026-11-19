import { existsSync } from "node:fs"
import type { realpath } from "node:fs/promises"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveStateRoot } from "./state-root.ts"

/** A case-insensitive filesystem's answer for one spelling, on any host. */
const alias = vi.hoisted(() => ({ spelling: "", resolves: "" }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<{ realpath: typeof realpath }>()
  return {
    ...fs,
    realpath: async (path: string) => path === alias.spelling ? alias.resolves : fs.realpath(path)
  }
})

let root: string

beforeEach(async () => {
  const { realpath: resolve } = await vi.importActual<{ realpath: typeof realpath }>("node:fs/promises")
  root = await resolve(await mkdtemp(NodePath.join(tmpdir(), "smithers-state-root-")))
  await mkdir(NodePath.join(root, "prod"))
})

afterEach(async () => {
  alias.spelling = ""
  await rm(root, { recursive: true, force: true })
})

describe("resolveStateRoot", () => {
  /**
   * Stage names differ by case (`Prod`, `prod`) where a case-insensitive
   * filesystem keeps one directory. Blaming a symbolic link sent the operator
   * looking for a link that does not exist.
   */
  it("names another spelling of an existing directory as an alias, not a symbolic link", async () => {
    alias.spelling = NodePath.join(root, "Prod")
    alias.resolves = NodePath.join(root, "prod")

    const refusal = resolveStateRoot(alias.spelling)
    await expect(refusal).rejects.toThrow(
      `Alchemy state directory ${alias.spelling} is the existing directory ${alias.resolves} spelled differently`
    )
    await expect(refusal).rejects.not.toThrow(/symbolic link/)
  })

  it("gives the same answer on this host's own filesystem", async () => {
    const spelling = NodePath.join(root, "Prod")
    if (existsSync(spelling)) {
      await expect(resolveStateRoot(spelling)).rejects.toThrow("spelled differently")
    } else {
      // A case-sensitive filesystem has no alias: the stage has no state yet.
      await expect(resolveStateRoot(spelling)).resolves.toBeNull()
    }
  })

  it("still names a symbolic link as one", async () => {
    await symlink(NodePath.join(root, "prod"), NodePath.join(root, "linked"))

    await expect(resolveStateRoot(NodePath.join(root, "linked"))).rejects.toThrow(
      `symbolic links are not allowed in the Alchemy state root: ${NodePath.join(root, "linked")}`
    )
  })
})
