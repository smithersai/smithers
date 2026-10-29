import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Smithers } from "@smthrs/targets"
import { afterEach, describe, expect, it } from "vitest"
import { ImportRules } from "../src/ImportRules.ts"
import type { ImportRule } from "../src/ImportRulesCheck.ts"
import { check, formatViolation, listSources, run, validateRules } from "../src/ImportRulesCheck.ts"

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url))
const runner = fileURLToPath(new URL("../scripts/import-rules.mjs", import.meta.url))

const because = "Components render; the machine runs Effect. See apps/mvp/AGENTS.md."

/** The violations of `rules` in `sources`, one line each: `<file>:<line> <usage> (<kind>) #<rule>`. */
const violations = (rules: ReadonlyArray<ImportRule>, sources: Record<string, string>): ReadonlyArray<string> =>
  check(rules, Object.entries(sources).map(([path, text]) => ({ path, text }))).map((violation) =>
    `${violation.file}:${violation.line} ${violation.usage} (${violation.kind}) #${violation.rule}`
  )

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A scratch package directory holding `files`. */
const scratchPackage = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "import-rules-"))
  directories.push(directory)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  return directory
}

describe("validateRules", () => {
  const valid: ImportRule = { kind: "forbid", modules: ["effect"], because }

  it("returns valid rules unchanged", () => {
    const rules: ReadonlyArray<ImportRule> = [
      valid,
      { kind: "forbidNames", files: ["src/**/*.tsx"], modules: ["react"], names: ["useState"], allowTypeOnly: true, because },
      { kind: "rootImportsOnly", packages: ["@smthrs/*"], because },
      { kind: "forbidCalls", callees: ["Model.stream", "*.route", "*.#send", "*.$"], because },
      { kind: "forbidHostModules", because }
    ]
    expect(validateRules(rules)).toBe(rules)
  })

  it.each<[string, unknown, string]>([
    ["a non-array", { rules: [] }, "ImportRules needs a non-empty array of rules"],
    ["an empty list", [], "ImportRules needs a non-empty array of rules"],
    ["a null rule", [null], "ImportRules rule 0: must be an object"],
    ["an array rule", [[]], "ImportRules rule 0: must be an object"],
    ["a string rule", ["forbid"], "ImportRules rule 0: must be an object"],
    ["an unknown kind", [{ kind: "ban", because }], "ImportRules rule 0: `kind` must be one of forbid, forbidNames, rootImportsOnly, forbidCalls, forbidHostModules"],
    ["a misspelled key", [valid, { kind: "forbid", module: ["effect"], because }], "ImportRules rule 1: forbid does not take `module`"],
    ["a type option on calls", [{ kind: "forbidCalls", callees: ["f"], allowTypeOnly: true, because }], "ImportRules rule 0: forbidCalls does not take `allowTypeOnly`"],
    ["no reason", [{ kind: "forbid", modules: ["effect"] }], "ImportRules rule 0: `because` must say why, naming the AGENTS.md rule that governs it"],
    ["a blank reason", [{ ...valid, because: "  " }], "ImportRules rule 0: `because` must say why, naming the AGENTS.md rule that governs it"],
    ["files that are not a list", [{ ...valid, files: "src/**" }], "ImportRules rule 0: `files` must be a non-empty array of strings"],
    ["an empty files list", [{ ...valid, files: [] }], "ImportRules rule 0: `files` must be a non-empty array of strings"],
    ["a blank files glob", [{ ...valid, files: ["src/**", ""] }], "ImportRules rule 0: `files` must hold only non-empty strings"],
    ["an absolute files glob", [{ ...valid, files: ["/src/**"] }], "ImportRules rule 0: files glob \"/src/**\" must be package-relative"],
    ["a files glob leaving the package", [{ ...valid, files: ["../other/**"] }], "ImportRules rule 0: files glob \"../other/**\" must be package-relative"],
    ["no modules", [{ kind: "forbid", because }], "ImportRules rule 0: `modules` must be a non-empty array of strings"],
    ["a non-string name", [{ kind: "forbidNames", modules: ["react"], names: [1], because }], "ImportRules rule 0: `names` must hold only non-empty strings"],
    ["no packages", [{ kind: "rootImportsOnly", packages: [], because }], "ImportRules rule 0: `packages` must be a non-empty array of strings"],
    ["an allow list on rootImportsOnly", [{ kind: "rootImportsOnly", packages: ["@smthrs/*"], allow: ["@smthrs/cli/*"], because }], "ImportRules rule 0: rootImportsOnly does not take `allow`"],
    ["an allow list on forbid", [{ kind: "forbid", modules: ["effect"], allow: ["effect/Schema"], because }], "ImportRules rule 0: forbid does not take `allow`"],
    ["no callees", [{ kind: "forbidCalls", because }], "ImportRules rule 0: `callees` must be a non-empty array of strings"],
    ...["*", "*.", "*route", "page.*", "*.page.route", "*.route()", "**.route"].map((entry): [string, unknown, string] => [
      `the callee pattern ${entry}`,
      [{ kind: "forbidCalls", callees: ["page.route", entry], because }],
      `ImportRules rule 0: \`callees\` entry "${entry}" must be a callee or \`*.<member>\``
    ]),
    ["a non-boolean type option", [{ ...valid, allowTypeOnly: "yes" }], "ImportRules rule 0: `allowTypeOnly` must be a boolean"]
  ])("refuses %s", (_case, rules, message) => {
    expect(() => validateRules(rules)).toThrow(new TypeError(message))
  })
})

describe("check: forbid", () => {
  const rule: ImportRule = { kind: "forbid", files: ["src/**/*.tsx"], modules: ["effect", "effect/**"], because }

  it("fails every import form of a forbidden module in the files it covers, and nothing else", () => {
    expect(violations([rule], {
      "src/View.tsx": [
        'import { Effect } from "effect"',
        'import type { Schema } from "effect/Schema"',
        'export { Stream } from "effect/Stream"',
        'const lazy = await import("effect/unstable/http")',
        'const old = require("effect")',
        'type Exit = import("effect").Exit',
        'import { useState } from "react"',
        'import { pipe } from "effect-ish"'
      ].join("\n"),
      "src/machine.ts": 'import { Effect } from "effect"'
    })).toEqual([
      'src/View.tsx:1 imports "effect" (forbid) #0',
      'src/View.tsx:2 imports "effect/Schema" (forbid) #0',
      'src/View.tsx:3 re-exports "effect/Stream" (forbid) #0',
      'src/View.tsx:4 imports "effect/unstable/http" (forbid) #0',
      'src/View.tsx:5 imports "effect" (forbid) #0',
      'src/View.tsx:6 imports "effect" (forbid) #0'
    ])
  })

  it("lets type-only references through only when the rule allows them", () => {
    const source = {
      "src/View.tsx": [
        'import type { Schema } from "effect"',
        'export type { Exit } from "effect"',
        'type Layer = import("effect").Layer',
        'import { type Option } from "effect"'
      ].join("\n")
    }
    expect(violations([{ ...rule, allowTypeOnly: true }], source)).toEqual([
      'src/View.tsx:4 imports "effect" (forbid) #0'
    ])
    expect(violations([rule], source)).toHaveLength(4)
  })

  it("reads every source when the rule names no files", () => {
    expect(violations([{ kind: "forbid", modules: ["ai"], because }], {
      "worker/Answer.ts": 'import { generateText } from "ai"',
      "e2e/chat.spec.ts": 'import { test } from "@playwright/test"'
    })).toEqual(['worker/Answer.ts:1 imports "ai" (forbid) #0'])
  })
})

describe("check: forbidNames", () => {
  const rule: ImportRule = {
    kind: "forbidNames",
    files: ["src/**/*.tsx"],
    modules: ["react"],
    names: ["useState", "useEffect", "default"],
    because
  }

  it("fails a named import, an alias, a re-export, a default import and a member read through a binding", () => {
    expect(violations([rule], {
      "src/Composer.tsx": [
        'import React, { useState, useEffect as onMount, useMemo } from "react"',
        'export { useState as useLocal } from "react"',
        'import * as R from "react"',
        "const [draft] = R.useState(\"\")",
        "R.useEffect(() => {})",
        "R.useMemo(() => 1)",
        'import { useState as other } from "preact/hooks"'
      ].join("\n"),
      "src/state.ts": 'import { useState } from "react"'
    })).toEqual([
      'src/Composer.tsx:1 imports default from "react" (forbidNames) #0',
      'src/Composer.tsx:1 imports useState from "react" (forbidNames) #0',
      'src/Composer.tsx:1 imports useEffect from "react" (forbidNames) #0',
      'src/Composer.tsx:2 re-exports useState from "react" (forbidNames) #0',
      'src/Composer.tsx:4 uses R.useState from "react" (forbidNames) #0',
      'src/Composer.tsx:5 uses R.useEffect from "react" (forbidNames) #0'
    ])
  })

  it("lets type-only names through only when the rule allows them", () => {
    const typeRule: ImportRule = { kind: "forbidNames", modules: ["react"], names: ["FC"], because }
    const source = {
      "src/View.tsx": [
        'import { type FC } from "react"',
        'import * as React from "react"',
        "const View: React.FC = () => null",
        'import { FC as Component } from "react"'
      ].join("\n")
    }
    expect(violations([{ ...typeRule, allowTypeOnly: true }], source)).toEqual([
      'src/View.tsx:4 imports FC from "react" (forbidNames) #0'
    ])
    expect(violations([typeRule], source)).toEqual([
      'src/View.tsx:1 imports FC from "react" (forbidNames) #0',
      'src/View.tsx:3 uses React.FC from "react" (forbidNames) #0',
      'src/View.tsx:4 imports FC from "react" (forbidNames) #0'
    ])
  })
})

describe("check: rootImportsOnly", () => {
  const rule: ImportRule = { kind: "rootImportsOnly", packages: ["@smthrs/*", "effect"], because }

  it("fails a deep import of a matching package and passes its root and everything else", () => {
    expect(violations([rule], {
      "worker/Answer.ts": [
        'import { Model } from "@smthrs/model"',
        'import * as ModelError from "@smthrs/model/ModelError"',
        'import { Schema } from "effect/Schema"',
        'import { Effect } from "effect"',
        'import { Pool } from "@effect/sql-pg/PgClient"',
        'import { readFileSync } from "node:fs"',
        'import { local } from "./local.ts"',
        'import { internal } from "#internal"',
        'import { home } from "~/home"',
        'export type { Route } from "@smthrs/rpc/ConfiguredModel"'
      ].join("\n")
    })).toEqual([
      'worker/Answer.ts:2 imports "@smthrs/model/ModelError", not the root "@smthrs/model" (rootImportsOnly) #0',
      'worker/Answer.ts:3 imports "effect/Schema", not the root "effect" (rootImportsOnly) #0',
      'worker/Answer.ts:10 re-exports "@smthrs/rpc/ConfiguredModel", not the root "@smthrs/rpc" (rootImportsOnly) #0'
    ])
  })

  it("lets a type-only deep import through only when the rule allows it", () => {
    const source = { "src/a.ts": 'import type { Model } from "@smthrs/model/Model"' }
    expect(violations([{ ...rule, allowTypeOnly: true }], source)).toEqual([])
    expect(violations([rule], source)).toHaveLength(1)
  })
})

describe("check: forbidCalls", () => {
  it("fails a call by its dotted callee text, and cannot see one reached through a variable", () => {
    expect(violations([{ kind: "forbidCalls", callees: ["Model.stream"], because }], {
      "worker/Answer.ts": [
        "const direct = Model.stream(request)",
        "const model = yield* Model.Model",
        "const indirect = model.stream(request)",
        "const other = Stream.stream(request)"
      ].join("\n")
    })).toEqual(["worker/Answer.ts:1 calls Model.stream (forbidCalls) #0"])
  })

  const interception = [
    "async function intercept() {",
    'await page.route("**/api", handler)',
    'await tab.page.route("**/api", handler)',
    'await device.context.route("**/api", handler)',
    'await page.context().route("**/api", handler)',
    'await page?.route("**/api", handler)',
    'await page.route?.("**/api", handler)',
    'await page["route"]("**/api", handler)',
    "await (await browser.newContext()).routeFromHAR(har)",
    "router.routes()",
    "reroute()",
    "route()",
    'page["re.route"]()',
    "}"
  ].join("\n")

  it("fails a call by its final member under `*.<member>`, whatever the receiver", () => {
    expect(violations([{ kind: "forbidCalls", callees: ["*.route", "*.routeFromHAR"], because }], {
      "e2e/chat.ts": interception
    })).toEqual([
      "e2e/chat.ts:2 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:3 calls tab.page.route (forbidCalls) #0",
      "e2e/chat.ts:4 calls device.context.route (forbidCalls) #0",
      "e2e/chat.ts:5 calls page.context().route (forbidCalls) #0",
      "e2e/chat.ts:6 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:7 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:8 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:9 calls (…).routeFromHAR (forbidCalls) #0"
    ])
  })

  it("keeps an exact callee exact, whatever the receiver's spelling", () => {
    expect(violations([{ kind: "forbidCalls", callees: ["page.route", "page.context().route"], because }], {
      "e2e/chat.ts": interception
    })).toEqual([
      "e2e/chat.ts:2 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:5 calls page.context().route (forbidCalls) #0",
      "e2e/chat.ts:6 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:7 calls page.route (forbidCalls) #0",
      "e2e/chat.ts:8 calls page.route (forbidCalls) #0"
    ])
  })
})

describe("check: ordering", () => {
  it("orders violations by file, line and rule", () => {
    const rules: ReadonlyArray<ImportRule> = [
      { kind: "forbidCalls", callees: ["Effect.runPromise"], because },
      { kind: "forbid", modules: ["effect"], because }
    ]
    expect(violations(rules, {
      "src/c.ts": 'import { Effect } from "effect"; Effect.runPromise(main)',
      "src/a.ts": 'Effect.runPromise(main)\nimport { Effect } from "effect"',
      "src/b.ts": 'import { Effect } from "effect"'
    })).toEqual([
      "src/a.ts:1 calls Effect.runPromise (forbidCalls) #0",
      'src/a.ts:2 imports "effect" (forbid) #1',
      'src/b.ts:1 imports "effect" (forbid) #1',
      "src/c.ts:1 calls Effect.runPromise (forbidCalls) #0",
      'src/c.ts:1 imports "effect" (forbid) #1'
    ])
  })
})

describe("check: source coverage", () => {
  it("refuses a stale .ts scope after its only source migrates to .vibe", () => {
    expect(() => check([
      { kind: "forbid", files: ["src/Answer.ts", "src/other/**/*.ts"], modules: ["ai"], because }
    ], [{ path: "src/Answer.vibe", text: "export const answer = 42" }])).toThrow(
      `ImportRules rule 0 (forbid) matches no source files; files: ["src/Answer.ts","src/other/**/*.ts"]. ${because}`
    )
  })

  it("names every empty rule, including a default scope in an empty package", () => {
    expect(() => check([
      { kind: "forbid", modules: ["ai"], because },
      { kind: "forbidCalls", files: ["test/**"], callees: ["setTimeout"], because }
    ], [])).toThrow([
      `ImportRules rule 0 (forbid) matches no source files; files: ["**/*"]. ${because}`,
      `ImportRules rule 1 (forbidCalls) matches no source files; files: ["test/**"]. ${because}`
    ].join("\n"))
  })

  it("accepts a scope when any one pattern matches a source", () => {
    expect(check([
      { kind: "forbid", files: ["src/old.ts", "src/Answer.{ts,vibe}"], modules: ["ai"], because }
    ], [{ path: "src/Answer.ts", text: "export const answer = 42" }])).toEqual([])
  })
})

describe("listSources", () => {
  it("lists source files, skipping dependencies, output, dot-directories, nested packages and links", () => {
    const directory = scratchPackage({
      "src/View.tsx": "",
      "src/machine.ts": "",
      "src/Route.vibe": "",
      "src/legacy.jsx": "",
      "worker/index.mts": "",
      "worker/config.cts": "",
      "db/migrate.js": "",
      "e2e/gifs.mjs": "",
      "bench/run.cjs": "",
      "README.md": "",
      "styles.css": "",
      "node_modules/dep/index.js": "",
      "dist/index.js": "",
      "coverage/x.js": "",
      "target/x.js": "",
      "tmp/x.js": "",
      "test-results/x.js": "",
      "playwright-report/x.js": "",
      ".alchemy/state.ts": "",
      "fixtures/nested/package.json": "{}",
      "fixtures/nested/index.ts": "",
      "fixtures/odd/package.json/index.ts": ""
    })
    symlinkSync(join(directory, "src/machine.ts"), join(directory, "src/linked.ts"))
    expect(listSources(directory)).toEqual([
      "bench/run.cjs",
      "db/migrate.js",
      "e2e/gifs.mjs",
      "fixtures/odd/package.json/index.ts",
      "src/Route.vibe",
      "src/View.tsx",
      "src/legacy.jsx",
      "src/machine.ts",
      "worker/config.cts",
      "worker/index.mts"
    ])
  })
})

describe("run", () => {
  const rules: ReadonlyArray<ImportRule> = [
    { kind: "forbid", files: ["src/**/*.tsx"], modules: ["effect", "effect/**"], because },
    { kind: "forbidCalls", callees: ["Model.stream"], because: "Model calls are flow steps. See AGENTS.md." }
  ]

  it("reports each violation with the package path, line, kind and reason, and exits 1", () => {
    const directory = scratchPackage({
      "src/View.tsx": 'import { Effect } from "effect"',
      "worker/Answer.ts": "\n\nconst events = Model.stream(request)"
    })
    expect(run({ packageDirectory: "apps/mvp", directory, rules })).toEqual({
      exitCode: 1,
      output: [
        "ImportRules failed in apps/mvp: 2 violations of 2 rules over 2 source files.",
        "",
        `- apps/mvp/src/View.tsx:1 imports "effect" (forbid). ${because}`,
        "- apps/mvp/worker/Answer.ts:3 calls Model.stream (forbidCalls). Model calls are flow steps. See AGENTS.md."
      ].join("\n")
    })
  })

  it("checks VibeLang sources like TypeScript ones", () => {
    const directory = scratchPackage({
      "src/Answer.vibe": [
        'import * as Model from "@smthrs/model/Model"',
        'import { NodeHost } from "@smthrs/platform-node"',
        "",
        "error Refused { reason: string }",
        "",
        "export function answer(request: Model.Request): string!Refused {",
        "  const reply = Model.stream<Model.Reply>(request) catch (e) => match (e) {",
        "    when Model.ModelError: throw new Refused({ reason: e.message });",
        "  }",
        "  return reply.text",
        "}"
      ].join("\n"),
      "src/View.tsx": ""
    })
    const vibeRules: ReadonlyArray<ImportRule> = [
      { kind: "forbid", modules: ["@smthrs/platform-node", "@smthrs/platform-node/**"], because },
      rules[1]!
    ]
    expect(run({ packageDirectory: "packages/agent", directory, rules: vibeRules })).toEqual({
      exitCode: 1,
      output: [
        "ImportRules failed in packages/agent: 2 violations of 2 rules over 2 source files.",
        "",
        `- packages/agent/src/Answer.vibe:2 imports "@smthrs/platform-node" (forbid). ${because}`,
        "- packages/agent/src/Answer.vibe:7 calls Model.stream (forbidCalls). Model calls are flow steps. See AGENTS.md."
      ].join("\n")
    })
  })

  it("names one violation, rule and file in the singular", () => {
    const directory = scratchPackage({ "src/View.tsx": 'import { Effect } from "effect"' })
    expect(run({ packageDirectory: "apps/mvp", directory, rules: rules.slice(0, 1) }).output.split("\n")[0])
      .toBe("ImportRules failed in apps/mvp: 1 violation of 1 rule over 1 source file.")
  })

  it("passes and exits 0 when nothing breaks a rule", () => {
    const directory = scratchPackage({ "src/View.tsx": 'import { Button } from "@smthrs/ui"', "src/a.ts": "" })
    expect(run({ packageDirectory: "apps/mvp", directory, rules })).toEqual({
      exitCode: 0,
      output: "ImportRules passed in apps/mvp: 2 rules over 2 source files."
    })
  })

  it("throws on invalid rules before reading a file", () => {
    expect(() => run({ packageDirectory: "apps/mvp", directory: "/nonexistent", rules: [] })).toThrow(TypeError)
  })

  it("formats one violation as the report does", () => {
    expect(formatViolation("apps/mvp", {
      file: "src/View.tsx",
      line: 7,
      rule: 2,
      kind: "forbidNames",
      usage: 'imports useState from "react"',
      because: "UI state is a local-only collection. See apps/mvp/AGENTS.md, \"State (flux)\"."
    })).toBe(
      "- apps/mvp/src/View.tsx:7 imports useState from \"react\" (forbidNames). " +
        "UI state is a local-only collection. See apps/mvp/AGENTS.md, \"State (flux)\"."
    )
  })
})

describe("the import-rules program", () => {
  const rules = JSON.stringify([{ kind: "forbid", modules: ["effect"], because }])
  const program = (directory: string, args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [runner, ...args], { cwd: directory, encoding: "utf8", timeout: 60_000 })

  it("prints violations to stderr and exits 1, and prints the pass line and exits 0", () => {
    const directory = scratchPackage({ "src/a.ts": 'import { Effect } from "effect"' })
    const failed = program(directory, ["apps/x", rules])
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(`- apps/x/src/a.ts:1 imports "effect" (forbid). ${because}`)
    const clean = scratchPackage({ "src/a.ts": "export const ok = 1" })
    const passed = program(clean, ["apps/x", rules])
    expect(passed.status).toBe(0)
    expect(passed.stdout).toBe("ImportRules passed in apps/x: 1 rule over 1 source file.\n")
  })

  it("exits 2 on missing arguments and on invalid rules", () => {
    const directory = scratchPackage({ "src/a.ts": "" })
    const usage = program(directory, ["apps/x"])
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain("usage: import-rules.mjs <package directory> '<rules JSON>'")
    const invalid = program(directory, ["apps/x", "[]"])
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain("ImportRules needs a non-empty array of rules")
    const malformed = program(directory, ["apps/x", "{"])
    expect(malformed.status).toBe(2)
  })

  it("fails loudly when a rule's file patterns cover nothing", () => {
    const directory = scratchPackage({ "src/Answer.vibe": "export const answer = 42" })
    const empty = program(directory, ["apps/x", JSON.stringify([
      { kind: "forbid", files: ["src/Answer.ts"], modules: ["ai"], because }
    ])])
    expect(empty.status).toBe(2)
    expect(empty.stderr).toContain(
      `ImportRules rule 0 (forbid) matches no source files; files: ["src/Answer.ts"]. ${because}`
    )
    expect(empty.stdout).not.toContain("passed")
  })
})

describe("ImportRules", () => {
  const rules: ReadonlyArray<ImportRule> = [{ kind: "forbid", files: ["src/**/*.tsx"], modules: ["effect"], because }]

  it("declares one uncached test target that runs the program in the package with the rules", () => {
    const target = ImportRules({ cwd: "apps/mvp", rules })
    const metadata = Smithers.Target.metadata(target)
    expect(metadata.target).toBe("NodeTest")
    expect(metadata.kinds).toEqual(["test"])
    expect(metadata.cacheable).toBe(false)
    const attrs = metadata.attrs as {
      readonly cwd: string
      readonly runner: { readonly entry: { readonly path: string }; readonly args: ReadonlyArray<string> }
      readonly srcs: ReadonlyArray<unknown>
    }
    expect(attrs.cwd).toBe("apps/mvp")
    expect(attrs.runner.entry.path).toBe("//packages/repo-targets/scripts/import-rules.mjs")
    expect(attrs.runner.args).toEqual(["apps/mvp", JSON.stringify(rules)])
    expect(attrs.srcs).toEqual([
      { _tag: "Glob", pattern: "//apps/mvp/**/*{.ts,.tsx,.mts,.cts,.js,.jsx,.mjs,.cjs,.vibe}", exclude: [] },
      { _tag: "File", path: "//packages/repo-targets/scripts/import-rules.mjs" },
      { _tag: "File", path: "//packages/repo-targets/src/ImportRulesCheck.ts" },
      { _tag: "File", path: "//packages/repo-targets/src/ImportAnalysis.ts" }
    ])
  })

  it("keys on every source of the package", async () => {
    const target = ImportRules({ cwd: "packages/repo-targets", rules })
    const [sources] = (Smithers.Target.metadata(target).attrs as { readonly srcs: ReadonlyArray<Smithers.Input.Glob> }).srcs
    const keyed = await Smithers.Input.expandGlob(workspaceRoot, "", sources!, { packageScoped: false })
    expect(keyed).toContain("packages/repo-targets/src/ImportRules.ts")
    expect(keyed).toContain("packages/repo-targets/scripts/import-rules.mjs")
    expect(keyed).toContain("packages/repo-targets/test-utils/effect-property.d.mts")
    expect(keyed.filter((file) => file.includes("node_modules"))).toEqual([])
  })

  it.each(["", "/apps/mvp", "../apps/mvp"])("refuses the cwd %j", (cwd) => {
    expect(() => ImportRules({ cwd, rules })).toThrow(
      new TypeError(`ImportRules cwd "${cwd}" must be a workspace-relative package directory`)
    )
  })

  it("refuses invalid rules when the declaration is made", () => {
    expect(() => ImportRules({ cwd: "apps/mvp", rules: [] })).toThrow(
      new TypeError("ImportRules needs a non-empty array of rules")
    )
  })
})
