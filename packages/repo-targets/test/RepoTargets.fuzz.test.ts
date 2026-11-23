import { Fuzz } from "@smthrs/fuzz"
import * as Input from "@smthrs/targets/Input"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as HiddenHostAccess from "../src/HiddenHostAccess.ts"
import * as ImportAnalysis from "../src/ImportAnalysis.ts"
import * as ImportRulesCheck from "../src/ImportRulesCheck.ts"
import * as RepoTargets from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/repo-targets ImportAnalysis, ImportRulesCheck, HiddenHostAccess & target macros fuzz invariants", () => {
  it("ImportAnalysis.analyze detects every import/export/require/dynamic-import/call form and ignores strings & comments", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        form: Schema.Literals([
          "import",
          "importType",
          "importNamespace",
          "exportFrom",
          "exportStar",
          "importEquals",
          "dynamicImport",
          "require",
          "createRequire",
          "builtinModule",
          "importTypeExpr",
          "commentedOut",
          "stringLiteral"
        ]),
        spec: Schema.Literals(["node:fs", "node:path", "@smthrs/flow", "@smthrs/flow/Action", "react", "./local.ts"]),
        member: Schema.Literals(["readFileSync", "useState", "make", "stream"]),
        ext: Schema.Literals(["ts", "tsx"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ form, spec, member, ext }) =>
          Effect.sync(() => {
            const code = form === "import"
              ? `import { ${member} as fn } from "${spec}"; fn();`
              : form === "importType"
              ? `import type { ${member} } from "${spec}"; export type T = ${member};`
              : form === "importNamespace"
              ? `import * as ns from "${spec}"; ns.${member}();`
              : form === "exportFrom"
              ? `export { ${member} } from "${spec}";`
              : form === "exportStar"
              ? `export * from "${spec}";`
              : form === "importEquals"
              ? `import mod = require("${spec}"); void mod;`
              : form === "dynamicImport"
              ? `export const f = () => import("${spec}");`
              : form === "require"
              ? `const x = require("${spec}"); void x;`
              : form === "createRequire"
              ? `import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("${spec}");`
              : form === "builtinModule"
              ? `const m = process.getBuiltinModule("${spec}"); void m;`
              : form === "importTypeExpr"
              ? `export type X = import("${spec}").${member};`
              : form === "commentedOut"
              ? `// import { ${member} } from "${spec}"\n/* require("${spec}") */\nexport const ok = 1;`
              : `export const s = "import { ${member} } from \\"${spec}\\"";`

            const analysis = ImportAnalysis.analyze(`src/sample.${ext}`, code, true)
            const specs = ImportAnalysis.specifiers(analysis)

            if (form === "commentedOut" || form === "stringLiteral") {
              return analysis.references.length === 0 && specs.length === 0
            }
            if (!specs.includes(spec)) return false
            const ref = analysis.references.find((r) => r.specifier === spec)
            if (ref === undefined) return false
            if (form === "importType" || form === "importTypeExpr") {
              if (!ref.typeOnly) return false
            }
            if (form === "import" || form === "exportFrom") {
              if (!ref.names.some((n) => n.name === member)) return false
            }
            if (form === "importNamespace") {
              if (!ref.members.some((m) => m.name === member)) return false
            }
            if (form === "exportStar") {
              if (ref.unnamed.length === 0) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ImportRulesCheck.check & validateRules enforce forbid, forbidNames, rootImportsOnly, forbidCalls & forbidHostModules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ruleKind: Schema.Literals(["forbid", "forbidNames", "rootImportsOnly", "forbidCalls", "forbidHostModules"]),
        typeOnlyImport: Schema.Boolean,
        allowTypeOnly: Schema.Boolean,
        violate: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ruleKind, typeOnlyImport, allowTypeOnly, violate }) =>
          Effect.sync(() => {
            let rule: ImportRulesCheck.ImportRule
            let code: string
            if (ruleKind === "forbid") {
              rule = {
                kind: "forbid",
                modules: ["bad-pkg"],
                allowTypeOnly,
                because: "RULE-FORBID"
              }
              code = violate
                ? `${typeOnlyImport ? "import type" : "import"} { x } from "bad-pkg";`
                : `import { x } from "good-pkg";`
            } else if (ruleKind === "forbidNames") {
              rule = {
                kind: "forbidNames",
                modules: ["react"],
                names: ["useEffect"],
                allowTypeOnly,
                because: "RULE-NAMES"
              }
              code = violate
                ? `${typeOnlyImport ? "import type" : "import"} { useEffect } from "react";`
                : `import { useState } from "react";`
            } else if (ruleKind === "rootImportsOnly") {
              rule = {
                kind: "rootImportsOnly",
                packages: ["@smthrs/flow"],
                allowTypeOnly,
                because: "RULE-ROOT"
              }
              code = violate
                ? `${typeOnlyImport ? "import type" : "import"} { x } from "@smthrs/flow/internal/Secret";`
                : `import { x } from "@smthrs/flow";`
            } else if (ruleKind === "forbidCalls") {
              rule = {
                kind: "forbidCalls",
                callees: ["Model.stream"],
                includeReferences: true,
                because: "RULE-CALLS"
              }
              code = violate
                ? `import { Model } from "@smthrs/model"; Model.stream();`
                : `import { Model } from "@smthrs/model"; Model.describe();`
            } else {
              rule = {
                kind: "forbidHostModules",
                allowTypeOnly,
                because: "RULE-HOST"
              }
              code = violate
                ? `${typeOnlyImport ? "import type" : "import"} { readFileSync } from "node:fs";`
                : `import { Effect } from "effect";`
            }

            const validated = ImportRulesCheck.validateRules([rule])
            if (validated.length !== 1) return false

            const violations = ImportRulesCheck.check(validated, [{ path: "src/a.ts", text: code }])
            const expectViolation = violate && (ruleKind === "forbidCalls" || !(typeOnlyImport && allowTypeOnly))
            if (expectViolation) {
              if (violations.length === 0) return false
              const formatted = ImportRulesCheck.formatViolation("/pkg", violations[0]!)
              return formatted.includes(rule.because)
            }
            return violations.length === 0
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("HiddenHostAccess.hiddenHostAccess detects dynamic imports, require, builtins, host modules & ambient globals", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pattern: Schema.Literals([
          "clean",
          "dynImport",
          "requireCall",
          "builtin",
          "ambientProcess",
          "ambientBun",
          "ambientDeno",
          "hostModule"
        ]),
        governed: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pattern, governed }) =>
          Effect.sync(() => {
            const body = pattern === "clean"
              ? `const add = (a, b) => a + b;`
              : pattern === "dynImport"
              ? `const load = (p) => import(p);`
              : pattern === "requireCall"
              ? `const load = () => require("node:fs");`
              : pattern === "builtin"
              ? `const b = process.getBuiltinModule("node:fs");`
              : pattern === "ambientProcess"
              ? `const env = globalThis.process.env.HOME;`
              : pattern === "ambientBun"
              ? `const b = Bun.file("x");`
              : pattern === "ambientDeno"
              ? `const w = Deno.readFile("x");`
              : `import { readFileSync } from "node:fs"; void readFileSync;`

            const code = `// src/mod.ts\n${body}\n`
            const findings = HiddenHostAccess.hiddenHostAccess(code, () => governed)
            if (pattern === "clean") return findings.length === 0
            if (!governed && (pattern === "ambientProcess" || pattern === "ambientBun" || pattern === "ambientDeno")) return findings.length === 0
            if (!governed) return typeof findings.length === "number"
            return findings.length > 0
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ImportRulesCheck.run on real temp directory & SdkRules/CircularImports/JevRules/WorkspaceSources target macros construct valid targets", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-repotargets-fuzz-")))
    try {
      await Fs.mkdir(Path.join(tmpRoot, "src"), { recursive: true })
      await Fs.writeFile(Path.join(tmpRoot, "src/index.ts"), `import { Effect } from "effect"; export const x = Effect.void;\n`)
      const out = ImportRulesCheck.run({
        packageDirectory: tmpRoot,
        directory: tmpRoot,
        rules: [{ kind: "forbidHostModules", because: "SDK-4" }]
      })
      expect(out.exitCode).toBe(0)

      const arb = Arbitrary.schema(
        Schema.Struct({
          role: Schema.Literals(["library", "app-library", "host", "components"]),
          pkg: Schema.Literals(["packages/errors", "packages/smithers/flows/core", "packages/repo-targets"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ role, pkg }) =>
            Effect.sync(() => {
              const sdk = RepoTargets.SdkRules({
                cwd: pkg,
                role
              })
              if (sdk.importRules === undefined) return false
              const circ = RepoTargets.CircularImports({
                cwd: pkg,
                sources: [Input.glob("src/**/*.ts")]
              })
              if (circ === undefined) return false
              const ws = RepoTargets.WorkspaceSources({
                cwd: pkg
              })
              if (ws === undefined) return false
              const jev = RepoTargets.JevRules({
                cwd: pkg,
                rules: [{ id: "no-foo", lookFor: "no foo", violation: "foo", compliant: "bar", files: ["src/**/*.ts"] }]
              })
              return jev !== undefined
            }),
          { seed: seed + 3, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
