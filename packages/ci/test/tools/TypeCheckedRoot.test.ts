/**
 * The commander.js shape, end to end: a repository whose CI type-checks,
 * lints and formats everything under its root. `tsc` reads `**\/*.ts`, typed
 * ESLint reads every file its flat configuration matches, dot directories
 * included, and Prettier checks `.`. The check also fails when the checkout
 * holds a file that is changed or not committed. A replay of such a
 * repository reports no mismatch, and the same check still passes after
 * `smithers-ci apply`.
 */

import * as Schema from "effect/Schema"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { workspacePath } from "../../src/generate/Render.ts"
import { commit, moduleOf, node, ownWorkflow, program, project, removeProjects, run, tool } from "./project.ts"

afterAll(removeProjects)

const json = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`
const quoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`
const url = (path: string): string => JSON.stringify(pathToFileURL(path).href)

// A fresh clone has no node_modules, as a replay's copies have none: the check names each tool where it is
// installed, in place of the `npm ci` commander.js runs first.
const check = [
  "set -e",
  `node ${quoted(tool("typescript", "tsc"))} -p tsconfig.json`,
  `node ${quoted(tool("eslint"))} . --max-warnings 0`,
  `node ${quoted(tool("prettier"))} --check .`,
  // Nothing in the checkout is changed or left uncommitted.
  `test -z "$(git status --porcelain)"`,
  ""
].join("\n")

const files: Readonly<Record<string, string>> = {
  "package.json": json({ name: "type-checked-root", version: "1.0.0", type: "module", license: "MIT" }),
  "src/index.ts": "export const add = (left: number, right: number): number => left + right;\n",
  "typings/index.d.ts": "export declare const version: string;\n",
  // As commander.js: every TypeScript file under the root.
  "tsconfig.json": json({
    compilerOptions: { strict: true, noEmit: true, module: "nodenext", target: "es2022", types: [] },
    include: ["**/*.ts", "**/*.mts"]
  }),
  // As commander.js: typed linting of every TypeScript file, with the project that type-checks them.
  "eslint.config.js": [
    `import js from ${url(moduleOf("eslint", "@eslint/js"))};`,
    `import tseslint from ${url(moduleOf("typescript-eslint", "typescript-eslint"))};`,
    ``,
    `export default tseslint.config(js.configs.recommended, {`,
    `  files: ["**/*.{ts,mts}"],`,
    `  extends: [...tseslint.configs.recommended],`,
    `  languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },`,
    `});`,
    ``
  ].join("\n"),
  ".prettierrc": json({ singleQuote: true }),
  // As most repositories: an ignore file that does not name Smithers CI's cache directory.
  ".gitignore": "node_modules\n",
  "check.sh": check,
  ".github/workflows/tests.yml": ownWorkflow("sh check.sh")
}

describe("a repository whose CI type-checks, lints and formats its root", () => {
  it("replays with no mismatch, and its own check still passes after apply", () => {
    const root = project(files, false)
    expect(node(root, tool("prettier"), ["--write", "."]).status).toBe(0)
    commit(root, "formatted")
    const ownCheck = () => run(root, "sh", ["check.sh"])
    const first = ownCheck()
    expect(first.status, first.output).toBe(0)

    const replayed = node(root, program, ["--commits", "1", "--no-apply-check", "--json"])
    expect(replayed.status, replayed.output).toBe(0)
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.mismatches).toBe(0)
    expect(report.commits).toHaveLength(1)
    expect(report.commits[0]).toMatchObject({ baseline: { ok: true }, normal: { ok: true }, mismatches: [] })
    // Both machines of the matrix ran the check, in the baseline and as targets.
    expect(report.commits[0]?.baseline.counts.ran).toBeGreaterThanOrEqual(2)
    expect(report.commits[0]?.normal.counts.failed).toBe(0)
    // The replay wrote nothing to the repository.
    expect(run(root, "git", ["status", "--porcelain"]).stdout).toBe("")

    const applied = node(root, program, ["apply"])
    expect(applied.status, applied.output).toBe(0)
    expect(applied.output).toContain(`wrote ${workspacePath}\n`)
    expect(existsSync(join(root, "PACKAGE.ts"))).toBe(false)
    commit(root, "smithers-ci apply")
    const after = ownCheck()
    expect(after.status, after.output).toBe(0)

    // A second apply writes the same bytes.
    const paths = [...applied.output.matchAll(/^wrote (.+)$/gm)].map((match) => match[1] as string)
    const bytes = () => paths.map((path) => readFileSync(join(root, path), "utf8"))
    const before = bytes()
    expect(node(root, program, ["apply"]).status).toBe(0)
    expect(bytes()).toEqual(before)
    // Nothing changed, so the check that refuses a changed checkout still passes.
    expect(ownCheck().status).toBe(0)
  }, 3_600_000)
})
