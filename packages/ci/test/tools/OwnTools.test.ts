/**
 * A repository's own tools never read a file Smithers CI wrote as one of
 * theirs. Each case is a real project in a temporary git repository and a
 * real tool: the tool passes on the project, `smithers-ci apply` writes its
 * files, and the tool passes again without naming one of them.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { legsPath, notesPath, packIgnorePath, workflowPath, workspacePath } from "../../src/generate/Render.ts"
import { seenIn } from "../../src/replay/Summary.ts"
import {
  commit,
  dprintPlugins,
  moduleOf,
  node,
  ownWorkflow,
  program,
  project,
  type Ran,
  removeProjects,
  run,
  tool,
  write
} from "./project.ts"

afterAll(removeProjects)

const json = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`

/** What every project holds: one TypeScript module and the repository's own CI. */
const base: Readonly<Record<string, string>> = {
  "package.json": json({ name: "own-tools", version: "1.0.0", type: "module", main: "src/index.ts", license: "MIT" }),
  "src/index.ts": "export const add = (left: number, right: number): number => left + right;\n",
  ".gitignore": "node_modules\n",
  ".github/workflows/ci.yml": ownWorkflow("node --test")
}

const tsconfig = (include?: ReadonlyArray<string>): string =>
  json({
    compilerOptions: { strict: true, noEmit: true, module: "nodenext", target: "es2022", skipLibCheck: true },
    ...(include === undefined ? {} : { include })
  })

const typed = (parserOptions: string): string =>
  [
    `import js from "@eslint/js";`,
    `import tseslint from "typescript-eslint";`,
    ``,
    `export default tseslint.config(js.configs.recommended, {`,
    `  files: ["**/*.ts"],`,
    `  extends: [...tseslint.configs.recommendedTypeChecked],`,
    `  languageOptions: { parserOptions: { ${parserOptions}, tsconfigRootDir: import.meta.dirname } },`,
    `});`,
    ``
  ].join("\n")

/** One tool in one configuration. `format` first makes the project one the tool passes. */
interface Case {
  readonly name: string
  readonly files?: Readonly<Record<string, string>>
  readonly format?: (root: string) => Ran
  readonly check: (root: string) => Ran
}

const tsc = tool("typescript", "tsc")
const eslint = tool("eslint")
const prettier = tool("prettier")
const biome = tool("@biomejs/biome", "biome")
const dprint = tool("dprint")
const vitest = tool("vitest")
const jest = tool("jest")
const mocha = tool("mocha")
const knip = tool("knip")
const cspell = tool("cspell")

const nodeTest =
  `import assert from "node:assert/strict";\nimport test from "node:test";\n\ntest("adds", () => {\n  assert.equal(1 + 2, 3);\n});\n`

const cases: ReadonlyArray<Case> = [
  ...([undefined, ["**/*"], ["src"], ["**/*.ts"]] as const).map((include): Case => ({
    name: `tsc, include ${include === undefined ? "absent" : JSON.stringify(include)}`,
    files: { "tsconfig.json": tsconfig(include) },
    check: (root) => node(root, tsc, ["-p", "."])
  })),
  {
    name: "ESLint, flat config, typescript-eslint",
    files: {
      "eslint.config.js":
        `import js from "@eslint/js";\nimport tseslint from "typescript-eslint";\n\nexport default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended);\n`
    },
    check: (root) => node(root, eslint, [".", "--max-warnings", "0"])
  },
  {
    name: "ESLint, flat config, typed with parserOptions.project",
    files: { "tsconfig.json": tsconfig(["**/*.ts"]), "eslint.config.js": typed(`project: "./tsconfig.json"`) },
    check: (root) => node(root, eslint, [".", "--max-warnings", "0"])
  },
  {
    name: "ESLint, flat config, typed with projectService",
    files: { "tsconfig.json": tsconfig(["**/*.ts"]), "eslint.config.js": typed(`projectService: true`) },
    check: (root) => node(root, eslint, [".", "--max-warnings", "0"])
  },
  {
    name: "ESLint 8, .eslintrc",
    files: {
      ".eslintrc.json": json({
        root: true,
        parser: moduleOf("typescript-eslint", "@typescript-eslint/parser"),
        parserOptions: { sourceType: "module", ecmaVersion: 2022 },
        extends: ["eslint:recommended"]
      })
    },
    check: (root) => node(root, tool("eslint-8", "eslint"), [".", "--ext", ".ts"], { ESLINT_USE_FLAT_CONFIG: "false" })
  },
  ...([undefined, { singleQuote: true }, { tabWidth: 4 }, { useTabs: true, proseWrap: "always" }] as const).map((
    options
  ): Case => ({
    name: `Prettier --check ., ${options === undefined ? "no configuration" : JSON.stringify(options)}`,
    files: options === undefined ? {} : { ".prettierrc": json(options) },
    format: (root) => node(root, prettier, ["--write", "."]),
    check: (root) => node(root, prettier, ["--check", "."])
  })),
  ...([undefined, { formatter: { indentStyle: "space", indentWidth: 4 } }] as const).map((options): Case => ({
    name: `Biome ci ., ${options === undefined ? "no configuration" : JSON.stringify(options)}`,
    files: options === undefined ? {} : { "biome.json": json(options) },
    format: (root) => node(root, biome, ["check", "--write", "."]),
    check: (root) => node(root, biome, ["ci", "."])
  })),
  {
    name: "dprint check, TypeScript, JSON and Markdown",
    files: {
      "dprint.json": json({
        typescript: {},
        json: {},
        markdown: {},
        excludes: ["**/node_modules", "**/*-lock.json"],
        plugins: dprintPlugins
      })
    },
    format: (root) => node(root, dprint, ["fmt"]),
    check: (root) => node(root, dprint, ["check"])
  },
  ...([[], ["--coverage", "--coverage.include=**/*.ts", "--coverage.reporter=text"]] as const).map((flags): Case => ({
    name: `Vitest run${flags.length === 0 ? "" : ", coverage of **/*.ts"}`,
    files: {
      "src/index.test.ts":
        `import { expect, test } from "vitest";\nimport { add } from "./index.ts";\n\ntest("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`
    },
    check: (root) => node(root, vitest, ["run", ...flags])
  })),
  ...([[], ["--coverage", "--collectCoverageFrom=**/*.cjs"]] as const).map((flags): Case => ({
    name: `Jest${flags.length === 0 ? "" : ", coverage of every source file"}`,
    files: {
      "lib/add.cjs": "module.exports = { add: (left, right) => left + right };\n",
      "lib/add.test.cjs":
        `const { add } = require("./add.cjs");\n\ntest("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`,
      "jest.config.cjs":
        `module.exports = { testMatch: ["**/*.test.cjs"], moduleFileExtensions: ["cjs", "js", "json"] };\n`
    },
    check: (root) => node(root, jest, flags)
  })),
  {
    name: "node --test",
    files: { "test/add.test.js": nodeTest },
    check: (root) => node(root, undefined, ["--test"])
  },
  {
    name: "Mocha",
    files: {
      "test/add.test.js":
        `import assert from "node:assert/strict";\n\ndescribe("add", () => {\n  it("adds", () => {\n    assert.equal(1 + 2, 3);\n  });\n});\n`
    },
    check: (root) => node(root, mocha, [])
  },
  { name: "knip", check: (root) => node(root, knip, []) },
  { name: "cspell .", check: (root) => node(root, cspell, ["--no-progress", "."]) },
  { name: `cspell "**"`, check: (root) => node(root, cspell, ["--no-progress", "**"]) }
]

/** What `smithers-ci apply` writes into a repository with this CI, by path. */
let written: Readonly<Record<string, string>> = {}

/** Adds what `apply` wrote to `root`, as `apply` leaves it, and commits. */
const apply = (root: string): void => {
  write(root, written)
  commit(root, "smithers-ci apply")
}

beforeAll(() => {
  const root = project(base, false)
  const outcome = node(root, program, ["apply"])
  expect(outcome.status, outcome.output).toBe(0)
  const paths = [...outcome.output.matchAll(/^wrote (.+)$/gm)].map((match) => match[1] as string)
  // Every kind of file the generator writes is in play: this CI needs two machines and leaves a note.
  expect([...paths].sort()).toEqual([workflowPath, packIgnorePath, workspacePath, legsPath, notesPath].sort())
  written = Object.fromEntries([...paths, ".gitignore"].map((path) => [path, readFileSync(join(root, path), "utf8")]))
  // Nothing at the repository's root, and nothing in a directory of its sources.
  expect(paths.every((path) => path.startsWith(".smithers/") || path === workflowPath)).toBe(true)
  expect(existsSync(join(root, "PACKAGE.ts"))).toBe(false)
}, 600_000)

describe("a repository's own tools, after smithers-ci apply", () => {
  it.each(cases)("$name passes and names no file Smithers CI wrote", ({ check, files, format }) => {
    const root = project({ ...base, ...files })
    if (format !== undefined) {
      const formatted = format(root)
      expect(formatted.status, formatted.output).toBe(0)
      commit(root, "formatted")
    }
    const before = check(root)
    expect(before.status, before.output).toBe(0)
    apply(root)
    const after = check(root)
    expect(after.status, after.output).toBe(0)
    expect(after.output).not.toContain(".smithers")
    expect(after.output).not.toContain("smithers-ci.yml")
  }, 900_000)

  it("npm pack ships nothing from .smithers, with no files list and no ignore file", () => {
    const root = project(base, false)
    const packed = (): ReadonlyArray<string> => {
      const outcome = run(root, "npm", ["pack", "--dry-run", "--json"])
      expect(outcome.status, outcome.output).toBe(0)
      const [tarball] = JSON.parse(outcome.stdout) as ReadonlyArray<{
        readonly files: ReadonlyArray<{ readonly path: string }>
      }>
      return (tarball as { readonly files: ReadonlyArray<{ readonly path: string }> }).files.map((file) => file.path)
    }
    const before = packed()
    apply(root)
    const after = packed()
    expect(after.filter((path) => path.startsWith(".smithers"))).toEqual([])
    // The workflow ships exactly as the repository's own workflow already did.
    expect(before).toContain(".github/workflows/ci.yml")
    expect(after.filter((path) => !before.includes(path))).toEqual([workflowPath])
  }, 900_000)
})

describe("a tool that is told to read everything", () => {
  const paths = [workflowPath, workspacePath, packIgnorePath, legsPath, notesPath]

  it("cspell --dot reads the generated workspace, and the report line says what to add", () => {
    const root = project(base)
    const check = (): Ran => node(root, cspell, ["--no-progress", "--dot", "--no-must-find-files", ".smithers/**"])
    expect(check().status).toBe(0)
    apply(root)
    const after = check()
    expect(after.status).toBe(1)
    expect(seenIn(after.output, paths)).toBe(
      `cspell read ${workspacePath}, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.`
    )
  }, 900_000)

  it("Prettier with another line ending reads the workflow, and the report line says what to add", () => {
    const root = project(base)
    expect(node(root, prettier, ["--write", "."]).status).toBe(0)
    commit(root, "formatted")
    const check = (): Ran => node(root, prettier, ["--check", "--end-of-line", "crlf", ".github"])
    apply(root)
    const after = check()
    expect(after.status).toBe(1)
    expect(seenIn(after.output, paths)).toBe(
      `Prettier read ${workflowPath}, which Smithers CI wrote. Add ${workflowPath} to .prettierignore.`
    )
  }, 900_000)
})
