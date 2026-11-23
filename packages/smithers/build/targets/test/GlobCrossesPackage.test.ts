import { describe, expect, it } from "@effect/vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll } from "vitest"
import { expand as expandFilegroup } from "../src/Filegroup.ts"
import { Smithers as S } from "../src/index.ts"
import { expandGlob, GlobCrossesPackage } from "../src/Input.ts"

let root = ""
const nested = "packages/compiler"
const literals = ["generate-directive-readers.mjs", "vibe-directive.mjs"]

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "glob-crosses-pkg-"))
  for (
    const [relative, content] of Object.entries({
      "PACKAGE.ts": "",
      "package.json": "{}",
      "root.ts": "root",
      "packages/compiler/PACKAGE.ts": "",
      "packages/compiler/generate-directive-readers.mjs": "generator",
      "packages/compiler/vibe-directive.mjs": "directive",
      "packages/runner/PACKAGE.vibe": "",
      "packages/runner/other.mjs": "runner"
    })
  ) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

const expectCrosses = async (promise: Promise<unknown>, pattern: string, packages: ReadonlyArray<string>) => {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(GlobCrossesPackage)
  const err = caught as GlobCrossesPackage
  expect(err.pattern).toBe(pattern)
  expect(err.packages).toEqual(packages)
  for (const directory of packages) {
    expect(err.message).toContain(`//${directory}:<target>`)
  }
}

describe("GlobCrossesPackage (#4964)", () => {
  it("root Filegroup rejects literal array form naming nested package files", async () => {
    const paths = literals.map((file) => `${nested}/${file}`)
    await expectCrosses(expandFilegroup(root, S.glob(paths)), paths[0]!, [nested])
  })

  it("broad parent glob reports only matching nested packages in order", async () => {
    const pattern = "packages/*/*.mjs"
    await expectCrosses(expandGlob(root, "", S.glob(pattern)), pattern, [nested, "packages/runner"])
    await expectCrosses(
      expandGlob(root, "", S.glob(pattern, { exclude: ["packages/runner/**"] })),
      pattern,
      [nested]
    )
  })

  it("legitimately empty or excluded globs stay empty without error", async () => {
    expect(await expandGlob(root, "", S.glob("packages/*/*.missing"))).toEqual([])
    expect(await expandGlob(root, "", S.glob("packages/no-directory/**"))).toEqual([])
    expect(await expandGlob(root, "", S.glob("packages/*/*.mjs", { exclude: ["packages/**"] }))).toEqual([])
    expect(await expandGlob(root, "", S.glob("does-not-exist"))).toEqual([])
  })

  it("keeps scope intact for in-package, mixed, and raw expansion", async () => {
    expect(await expandGlob(root, nested, S.glob("*.mjs"))).toEqual(literals.map((file) => `${nested}/${file}`))
    expect(await expandGlob(root, "", S.glob("**/*.ts"))).toEqual(["PACKAGE.ts", "root.ts"])
    expect(await expandGlob(root, "", S.glob("packages/*/*.mjs"), { packageScoped: true })).toEqual([])
    expect(await expandGlob(root, "", S.glob("packages/*/*.mjs"), { packageScoped: false })).toEqual([
      ...literals.map((file) => `${nested}/${file}`),
      "packages/runner/other.mjs"
    ])
  })

  it("allowEmpty opts out for both glob forms without importing nested files", async () => {
    const pattern = "packages/*/*.mjs"
    expect(await expandGlob(root, "", S.glob(pattern, { allowEmpty: true }))).toEqual([])
    const declared = S.glob([pattern, "!packages/runner/**"], {
      allowEmpty: true,
      exclude: ["packages/compiler/generate-directive-readers.mjs"]
    })
    expect(declared[0]!.allowEmpty).toBe(true)
    expect(declared[0]!.exclude).toEqual(["packages/compiler/generate-directive-readers.mjs", "packages/runner/**"])
    expect(await expandFilegroup(root, declared)).toEqual([])
    await expectCrosses(
      expandGlob(root, "", S.glob(pattern, { allowEmpty: false })),
      pattern,
      [nested, "packages/runner"]
    )
  })

  it("non-root parent diagnoses nested package and respects gitignore", async () => {
    const parent = "packages/compiler"
    const tools = `${parent}/tools`
    await mkdir(join(root, tools), { recursive: true })
    await writeFile(join(root, tools, "PACKAGE.ts"), "")
    await writeFile(join(root, tools, ".gitignore"), "ignored.sh\n")
    await writeFile(join(root, tools, "tool.sh"), "tool")
    await writeFile(join(root, tools, "ignored.sh"), "ignored")
    await expectCrosses(expandGlob(root, parent, S.glob("tools/*.sh")), "tools/*.sh", [tools])
    expect(await expandGlob(root, parent, S.glob("tools/ignored.sh"))).toEqual([])
  })
})
