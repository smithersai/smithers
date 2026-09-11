import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GraphNode } from "@smthrs/rpc/TargetGraph"
import { computeAffected, declarationInputs } from "./Affected"

test("affected matches declared inputs and propagates through reverse dependencies", () => {
  const result = computeAffected({
    repoId: "repo", base: "abc", changedFiles: ["src/App.tsx", "README.md"],
    nodes: [
      { label: "//src:srcs", package: "//src", name: "srcs", rule: "Filegroup", kinds: [], private: false },
      { label: "//src:test", package: "//src", name: "test", rule: "Shell.Test", kinds: ["test"], private: false },
      { label: "//:docs", package: "//", name: "docs", rule: "Docs", kinds: ["docs"], private: false, plan: { inputs: ["README.md"] } }
    ],
    edges: [{ from: "//src:test", to: "//src:srcs", kind: "data" }],
    declarations: new Map([["//src:srcs", [{ pattern: "src/**", source: "declaration" as const }]]])
  })
  expect(result.affected).toEqual([
    { label: "//:docs", reason: "declared input: README.md" },
    { label: "//src:srcs", reason: "declared input: src/App.tsx" },
    { label: "//src:test", reason: "transitive via //src:srcs" }
  ])
  expect(result.signal).toContain("reverse graph")
})

const graphNode = (label = "//:check"): GraphNode => ({ label, package: "//", name: label.split(":")[1]!, rule: "Shell.Test", kinds: [], private: false })

const extract = async (source: string) => {
  const repo = await mkdtemp(join(tmpdir(), "affected-inputs-"))
  try {
    await mkdir(join(repo, "apps/app"), { recursive: true })
    await writeFile(join(repo, "apps/app/PACKAGE.ts"), source)
    return await declarationInputs(repo, ["apps/app/PACKAGE.ts"])
  } finally { await rm(repo, { recursive: true, force: true }) }
}

test("bare Smithers import, string globs and exported targets retain their inputs", async () => {
  const inputs = await extract(`import { Smithers } from "@smthrs/targets"
const sources = Smithers.glob("//apps/app/src/**/*.ts")
export const check = Smithers.Shell.Test({ data: [sources] })
const lint = Smithers.Shell.Test({ data: [Smithers.file("eslint.config.ts")] })
`)
  expect([...inputs.keys()]).toEqual(["//apps/app:sources", "//apps/app:check", "//apps/app:lint"])
  expect(inputs.get("//apps/app:check")).toEqual([
    { pattern: "apps/app/src/**/*.ts", source: "declaration" },
    { pattern: "apps/app/PACKAGE.ts", source: "declaration" }
  ])
  expect(inputs.get("//apps/app:lint")?.map((input) => input.pattern)).toEqual(["apps/app/eslint.config.ts", "apps/app/PACKAGE.ts"])
})

test.each(["S", "Build"])("adjacent exported and indented declarations keep separate inputs using alias %s", async (alias) => {
  const inputs = await extract(`import { Smithers as ${alias} } from "@smthrs/targets"
const first = ${alias}.file("first.ts")
export const second = ${alias}.glob(["second.ts", "!ignored.ts"])
  export const third = ${alias}.glob("third.ts")
`)
  for (const name of ["first", "second", "third"]) {
    expect(inputs.get(`//apps/app:${name}`)?.map((input) => input.pattern)).toEqual([`apps/app/${name}.ts`, "apps/app/PACKAGE.ts"])
  }
})

test.each([
  ["packages/foo/**/*.test.ts", "packages/foo/index.test.ts", "packages/foo/deep/index.test.ts", "packages/bar/index.test.ts"],
  ["Apps/**/*Routes.ts", "Apps/HomeRoutes.ts", "Apps/deep/HomeRoutes.ts", "Apps/Home.ts"],
  ["src/**/__stories__/**", "src/__stories__/a.tsx", "src/deep/__stories__/nested/a.tsx", "src/a.tsx"],
  ["flows/**/fixtures/**", "flows/fixtures/a.ts", "flows/deep/fixtures/a.ts", "flows/a.ts"],
  ["src/**", "src/a.ts", "src/deep/a.ts", "other/a.ts"]
])("glob %s agrees with Bun.Glob for zero and multiple segments", (pattern, direct, nested, unrelated) => {
  const files = [direct, nested, unrelated]
  const result = computeAffected({ repoId: "repo", base: "abc", changedFiles: files, nodes: [{ ...graphNode(), plan: { inputs: [pattern] } }], edges: [], declarations: new Map() })
  const expected = files.filter((file) => new Bun.Glob(pattern).match(file))
  expect(expected).toEqual(files.slice(0, 2))
  expect(result.affected).toEqual([{ label: "//:check", reason: `declared input: ${expected.join(", ")}` }])
})

test.each([false, true])("each unique glob compiles once for 500 targets and 200 changed files (shared: %s)", (shared) => {
  const patterns = ["src/**/*.ts", "tests/**/*.ts", "lib/**/*.ts", "docs/**", "README.md"]
  const nodes = Array.from({ length: 500 }, (_, index) => ({ ...graphNode(`//:target${index}`), plan: { inputs: shared ? patterns : Array.from({ length: 5 }, (_, group) => `packages/p${index}/group${group}/**/*.ts`) } }))
  const changedFiles = Array.from({ length: 200 }, (_, index) => `other/file${index}.ts`)
  if (shared) changedFiles[0] = "README.md"
  else for (let index = 0; index < changedFiles.length; index++) changedFiles[index] = `packages/p${index}/group${index % 5}/src/file${index}.ts`
  const OriginalRegExp = globalThis.RegExp
  let compilations = 0
  let result: ReturnType<typeof computeAffected>
  try {
    globalThis.RegExp = new Proxy(OriginalRegExp, { construct(target, args) { compilations++; return Reflect.construct(target, args) } })
    result = computeAffected({ repoId: "repo", base: "abc", changedFiles, nodes, edges: [], declarations: new Map() })
  } finally { globalThis.RegExp = OriginalRegExp }
  expect(result.affected).toHaveLength(shared ? 500 : 200)
  if (shared) expect(result.affected.every((entry) => entry.reason === "declared input: README.md")).toBe(true)
  else expect(result.affected.map((entry) => entry.label).sort()).toEqual(nodes.slice(0, 200).map((node) => node.label).sort())
  expect(compilations).toBe(shared ? patterns.length : 2500)
})

test("plan inputs take precedence, including empty lists, while declaration edits remain inputs", () => {
  const declarations = new Map([["//:check", ["stale.ts", "PACKAGE.ts"].map((pattern) => ({ pattern, source: "declaration" as const }))]])
  for (const inputs of [["planned.ts"], []]) {
    const result = computeAffected({ repoId: "repo", base: "abc", changedFiles: ["stale.ts", "planned.ts", "PACKAGE.ts"], nodes: [{ ...graphNode(), plan: { inputs } }], edges: [], declarations })
    expect(result.affected).toEqual([{ label: "//:check", reason: `declared input: ${[...inputs, "PACKAGE.ts"].join(", ")}` }])
  }
})

test("signal reports only input sources actually available", () => {
  const result = computeAffected({ repoId: "repo", base: "abc", changedFiles: [], nodes: [graphNode()], edges: [], declarations: new Map() })
  expect(result.signal).not.toContain("static")
  expect(result.signal).not.toContain("plan inputs")
})

test("trailing globstar includes an edit to the input directory itself", () => {
  const result = computeAffected({ repoId: "repo", base: "abc", changedFiles: ["src"], nodes: [{ ...graphNode(), plan: { inputs: ["src/**"] } }], edges: [], declarations: new Map() })
  expect(result.affected).toEqual([{ label: "//:check", reason: "declared input: src" }])
})
