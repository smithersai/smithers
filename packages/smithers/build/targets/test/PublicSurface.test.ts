import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as Reference from "../src/Reference.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Shell from "../src/Shell.ts"
import * as S from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"

const require = createRequire(import.meta.url)

describe("published policy boundary", () => {
  it("does not export or ship repository-specific policies", () => {
    for (
      const name of [
        "StandardPackage",
        "DurableIdentityGuard",
        "DocsReferenceSync",
        "JsdocTruthfulness",
        "reviewPrompt"
      ]
    ) {
      expect(name in S).toBe(false)
    }
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.exports["./*"]).toBeUndefined()
    expect(manifest.publishConfig.exports["./*"]).toBeUndefined()
    expect("SafeFs" in S).toBe(false)
    expect(Object.keys(S).some((name) => name.endsWith("Live"))).toBe(false)
    for (const name of ["StandardPackage", "ReviewLint"]) {
      expect(manifest.exports[`./${name}`]).toBeNull()
      expect(manifest.publishConfig.exports[`./${name}`]).toBeNull()
      expect(() => require.resolve(`@smthrs/targets/${name}`)).toThrow(/not defined by "exports"/)
      expect(existsSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)))).toBe(false)
      for (const format of ["esm", "cjs"]) {
        expect(existsSync(fileURLToPath(new URL(`../dist/${format}/${name}.js`, import.meta.url)))).toBe(false)
      }
    }
    expect(typeof S.LlmLint).toBe("function")
  })

  it.each(
    [
      ["RemoteCache", "publicReadTokenPrefix", RemoteCache],
      ["PackageJson", "targetSuffixes", PackageJson],
      ["RustToolchain", "isRustToolchain", RustToolchain],
      ["Reference", "cargoBin", Reference],
      ["Owners", "teamShape", Owners]
    ] as const
  )("%s does not export the unused %s", (_, name, module) => {
    expect(name in module).toBe(false)
  })

  it("names the Rust toolchain module once, as Rust", () => {
    expect("RustToolchain" in S).toBe(false)
    expect(S.Rust.Toolchain).toBe(RustToolchain.Toolchain)
    expect(S.Rust.Pinned).toBe(RustToolchain.Pinned)
  })
})

describe("shell executable contract", () => {
  it("preserves shell text and direct argument boundaries", () => {
    expect(Shell.execPayload({ shell: "printf '%s' \"$HOME\"" }).argv).toEqual([
      "/bin/sh",
      "-c",
      "printf '%s' \"$HOME\""
    ])
    expect(Shell.execPayload({ bin: S.Runtime.bin, args: ["--eval", "console.log('two words')", "a b", ""] }).argv)
      .toEqual([Shell.toolToken(S.Runtime.bin), "--eval", "console.log('two words')", "a b", ""])
  })

  it.each([
    {},
    { shell: "node", args: ["--version"] },
    { shell: "true", args: [] },
    { shell: "true", runtimeArgs: [] },
    { shell: "true", using: {} },
    { shell: "true", bin: S.Runtime.bin },
    { bun: "console.log(1)", args: ["lost"] },
    { bun: "console.log(1)", runtimeArgs: ["lost"] },
    { bin: S.Runtime.bin, using: {} },
    { script: S.file("check.sh"), runtimeArgs: [] }
  ])("rejects unsupported executable combinations at the schema boundary: %j", (attrs) => {
    for (const schema of [Shell.BuildAttrs, Shell.TestAttrs, Shell.RunAttrs, Shell.ServeAttrs, Shell.DiffAttrs]) {
      expect(() => Schema.decodeUnknownSync(schema)({ ...attrs, changes: [] })).toThrow()
    }
    expect(() => Shell.Test(attrs as never)).toThrow()
    expect(() => Shell.execPayload(attrs as never)).toThrow()
  })

  it("names the selected executables in the schema's own diagnostic", () => {
    for (const schema of [Shell.BuildAttrs, Shell.TestAttrs, Shell.RunAttrs, Shell.ServeAttrs, Shell.DiffAttrs]) {
      expect(() => Schema.decodeUnknownSync(schema)({ outDirs: ["dist"], changes: [] }))
        .toThrow(/requires exactly one of bin, bun, shell, script; received none/)
      expect(() => Schema.decodeUnknownSync(schema)({ shell: "true", bun: "1", outDirs: ["dist"], changes: [] }))
        .toThrow(/received bun, shell/)
    }
    expect(() => Schema.decodeUnknownSync(Shell.BuildAttrs)({ shell: "true" }))
      .toThrow(/at least one outDirs or outFiles/)
  })

  it("exports each rule with its attrs schema as the only validator", () => {
    expect([Shell.Build, Shell.Test, Shell.Run, Shell.Serve, Shell.Diff].map((rule) => [rule.id, rule.attrs])).toEqual([
      ["Shell.Build", Shell.BuildAttrs],
      ["Shell.Test", Shell.TestAttrs],
      ["Shell.Run", Shell.RunAttrs],
      ["Shell.Serve", Shell.ServeAttrs],
      ["Shell.Diff", Shell.DiffAttrs]
    ])
  })
})

describe("opaque target contract", () => {
  it.each([
    Shell.Test({ shell: "true" }),
    Shell.Build({ shell: "true", outFiles: ["report.txt"] }),
    Shell.Run({ shell: "true" }),
    Shell.Diff({ shell: "true", changes: [] })
  ])("keeps the execution report for $_tag", (target) => {
    const report = Exec.Result.make({ exitCode: 0, stdout: "report", stderr: "" })
    expect(Target.metadata(target).decodeSuccess(report)).toEqual(report)
    expect(() => Target.metadata(target).decodeSuccess("invalid report")).toThrow()
  })

  it("exposes explicit lowering without inherited Flow execution methods", () => {
    const target = S.Shell.Test({ shell: "true" })
    expect(Target.isTarget(target)).toBe(true)
    expect("@smthrs/flow/Flow" in target).toBe(false)
    for (const name of ["execute", "asNode", "body", "poll", "resume", "executionId"]) {
      expect(name in target).toBe(false)
    }
    expect(Target.plan(target).ast._tag).toBe("ActionCall")
  })

  it.each(
    [
      ["30s", 30_000],
      ["250ms", 250],
      ["2m", 120_000],
      ["1h", 3_600_000],
      [undefined, Shell.packageExecTimeoutMs]
    ] as const
  )("preserves the Shell timeout when explicitly lowering: %s", (timeout, timeoutMs) => {
    const target = Shell.Test({ shell: "true", ...(timeout === undefined ? {} : { timeout }) })
    const ast = Target.plan(target).ast
    expect(ast._tag).toBe("ActionCall")
    if (ast._tag === "ActionCall") expect(ast.payload).toHaveProperty("timeoutMs", timeoutMs)
  })

  it("lowers package-only catalog rules to their explicit unsupported action", () => {
    const target = S.Shell.Serve({ shell: "node server.js" })
    const ast = Target.plan(target).ast
    expect(ast._tag).toBe("ActionCall")
    if (ast._tag === "ActionCall") expect(ast.action).toBe("smithers-build/not-implemented")
  })

  it("rejects a marker-only object with no lowering implementation", () => {
    expect(() => Target.plan({ _tag: "forged" } as never)).toThrow("target has no registered plan implementation")
  })
})

// These assertions are compiled by tsconfig.test.json; they never execute.
const authoringContract = () => {
  const declaration = Shell.Test({ shell: "true" })
  // @ts-expect-error Targets are opaque declarations, not executable flows.
  declaration.execute({})
  // @ts-expect-error Targets cannot masquerade as child flows.
  declaration.asNode({})
  // @ts-expect-error Flow interpreters require an explicit lowering host.
  const flow: Flow.Any = declaration
  void flow
  // @ts-expect-error No selector.
  Shell.Test({})
  // @ts-expect-error Shell text cannot take argv arguments.
  Shell.Test({ shell: "node", args: ["--version"] })
  const conflicting = { shell: "node", bin: S.Runtime.bin }
  // @ts-expect-error Exclusivity applies to non-literal arguments too.
  Shell.Test(conflicting)
  // @ts-expect-error Old ambiguous selector was removed.
  Shell.Test({ command: "true" })
  // @ts-expect-error Bun templates cannot take ignored runtime flags.
  Shell.Test({ bun: "true", runtimeArgs: [] })
  Shell.Test({ shell: "true" })
  Shell.Test({ bin: S.Runtime.bin, args: ["--version"] })
  // @ts-expect-error The Rust toolchain module has one facade name, Rust.
  void S.RustToolchain
  const pinned: RustToolchain.RustToolchain = S.Rust.Pinned({})
  const layer: S.Rust = S.Rust.Toolchain({ channel: "1.91" })
  void pinned
  void layer
}
void authoringContract
