/**
 * The workflow `smithers-ci apply` writes passes the YAML rules of the common
 * linters and formatters as written. The CI it is generated from has several
 * jobs, a matrix, an environment, a script of several lines and versions YAML
 * reads as something else than text; the generated workflow has a matrix, an
 * environment, scripts of several lines and those versions. Each tool is the
 * real one, run on the generated file.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parse } from "yaml"
import { workflowPath } from "../../src/generate/Render.ts"
import { node, program, project, removeProjects, tool } from "./project.ts"

afterAll(removeProjects)

const ci = [
  "name: CI",
  "on: [push, pull_request]",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/setup-python@v5",
  "        with:",
  "          python-version: '3.10'",
  "      - run: python3 -c 'print(1)'",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    strategy:",
  "      matrix:",
  "        node-version: ['>=20.19.0', 24.x]",
  "    env:",
  "      GREETING: 'a: b # c'",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: ${{ matrix.node-version }}",
  "      - run: |",
  "          echo \"$GREETING\"",
  "          node --version",
  ""
].join("\n")

const eslint = tool("eslint")
const prettier = tool("prettier")

/** The configurations of ESLint each case runs with: `@antfu/eslint-config` as ni has it, and the plugin's own sets. */
const configurations: Readonly<Record<string, string>> = {
  "eslint.antfu.mjs": `import antfu from "@antfu/eslint-config";\n\nexport default antfu();\n`,
  "eslint.standard.mjs": `import yml from "eslint-plugin-yml";\n\nexport default [...yml.configs["flat/standard"]];\n`,
  "eslint.prettier.mjs":
    `import yml from "eslint-plugin-yml";\n\nexport default [...yml.configs["flat/standard"], ...yml.configs["flat/prettier"]];\n`
}

let root = ""
let workflow = ""

beforeAll(() => {
  root = project({ ".github/workflows/ci.yml": ci, ".gitignore": "node_modules\n", ...configurations })
  const applied = node(root, program, ["apply"])
  expect(applied.status, applied.output).toBe(0)
  workflow = readFileSync(join(root, workflowPath), "utf8")
}, 600_000)

// The yamllint on the path, or `undefined` when the machine has none.
const yamllint = ((): string | undefined => {
  const found = spawnSync("yamllint", ["--version"], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.trim() : undefined
})()

describe("the workflow apply writes", () => {
  it("holds a matrix, an environment, scripts of several lines and versions written as text", () => {
    const read = parse(workflow) as {
      readonly jobs: {
        readonly ci: {
          readonly strategy: { readonly matrix: { readonly include: ReadonlyArray<Record<string, unknown>> } }
          readonly steps: ReadonlyArray<Record<string, unknown>>
        }
      }
    }
    expect(read.jobs.ci.strategy.matrix.include.map((leg) => leg["version-node"]).sort()).toEqual([
      "24.x",
      ">=20.19.0"
    ])
    const steps = read.jobs.ci.steps
    expect(steps.find((step) => step["uses"] === "actions/setup-python@v5")?.["with"]).toEqual({
      "python-version": "3.10"
    })
    expect(steps.some((step) => String(step["run"]).split("\n").length > 2)).toBe(true)
    expect(steps.some((step) => typeof step["env"] === "object")).toBe(true)
    // The text YAML would read as a number, and the text no plain scalar can hold, are block scalars.
    expect(workflow).toContain("python-version: >-\n            3.10\n")
    expect(workflow).toContain("version-node: >-\n              >=20.19.0\n")
    expect(workflow).not.toMatch(/: ["']/)
  })

  it.each(Object.keys(configurations))("passes ESLint with %s and no warning", (configuration) => {
    const linted = node(root, eslint, ["--config", configuration, "--max-warnings", "0", workflowPath])
    expect(linted.status, linted.output).toBe(0)
    expect(linted.output).toBe("")
  }, 300_000)

  // Why no quote: the two presets disagree on which one a string takes, so either quote fails one of them.
  it.each([
    ["\"x\"", "eslint.antfu.mjs", "yaml/quotes"],
    ["'x'", "eslint.standard.mjs", "yml/quotes"]
  ])("finds %s, which needs no quote, wrong under %s", (written, configuration, rule) => {
    const quoted = ".github/workflows/quoted.yml"
    writeFileSync(join(root, quoted), `---\nkey: ${written}\n`)
    const linted = node(root, eslint, ["--config", configuration, "--max-warnings", "0", quoted])
    expect(linted.status).toBe(1)
    expect(linted.output).toContain(rule)
  }, 300_000)

  it.each([[[]], [["--single-quote"]]] as const)("passes prettier --check %j as written", (flags) => {
    const checked = node(root, prettier, ["--check", ...flags, workflowPath])
    expect(checked.status, checked.output).toBe(0)
    // Without the lines that tell Prettier to leave it as written, too: Prettier writes it the same way.
    const bare = ".github/workflows/bare.yml"
    writeFileSync(join(root, bare), workflow.replaceAll("# prettier-ignore\n", ""))
    const formatted = node(root, prettier, [...flags, bare])
    expect(formatted.status, formatted.output).toBe(0)
    expect(formatted.stdout).toBe(workflow.replaceAll("# prettier-ignore\n", ""))
  }, 300_000)

  it.skipIf(yamllint === undefined)("passes yamllint's default configuration, with one warning for `on`", () => {
    const linted = spawnSync("yamllint", ["--format", "parsable", workflowPath], { cwd: root, encoding: "utf8" })
    expect(linted.status, `${yamllint}\n${linted.stdout}${linted.stderr}`).toBe(0)
    // GitHub fixes the key `on`, which YAML 1.1 reads as true.
    const line = workflow.split("\n").indexOf("on:") + 1
    expect(linted.stdout).toBe(
      `${workflowPath}:${line}:1: [warning] truthy value should be one of [false, true] (truthy)\n`
    )
  })
})
