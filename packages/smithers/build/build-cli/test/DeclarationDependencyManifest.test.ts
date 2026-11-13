import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertDeclarationDependencies } from "../src/internal/DeclarationDependencies.ts"
import { PackageError } from "../src/PackageError.ts"

let root: string

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-declaration-manifest-")))
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("declaration dependency manifest", () => {
  it("refuses an installed effect directory without a manifest in both modes, naming the filesystem error", async () => {
    const directory = await Fs.mkdtemp(Path.join(root, "workspace-"))
    await Fs.mkdir(Path.join(directory, "node_modules", "effect"), { recursive: true })
    await Fs.writeFile(Path.join(directory, "node_modules", "effect", "index.js"), "export default 1\n")
    const file = Path.join(directory, "PACKAGE.ts")
    for (const bootstrap of [false, true]) {
      let refusal: unknown
      try {
        assertDeclarationDependencies([file], { bootstrap })
      } catch (cause) {
        refusal = cause
      }
      expect(refusal).toBeInstanceOf(PackageError)
      expect(refusal).toMatchObject({
        code: "declaration_dependency_unresolved",
        path: file,
        cause: expect.objectContaining({ code: "ENOENT" })
      })
      expect((refusal as Error).message).toMatch(
        /^declaration_dependency_unresolved: cannot resolve effect; install the workspace dependencies and run its local CLI \(ENOENT: .*package\.json/
      )
    }
  })
})
