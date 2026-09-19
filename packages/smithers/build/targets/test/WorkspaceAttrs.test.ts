/**
 * The attrs a rule resolves from the workspace rather than from a PACKAGE.ts.
 *
 * A package declaration no longer names the package manager or the runtime:
 * the workspace declares them once and the executor fills them in before it
 * keys and runs the node. Three claims hold that up, and each is asserted
 * here: a rule names which attrs it expects filled, a rule whose attr was
 * never filled refuses by name rather than spawning whatever is on PATH, and a
 * declaration that overrides the interpreter still overrides the tool argv.
 */
import { describe, expect, it } from "vitest"
import { Dprint } from "../src/Dprint.ts"
import { EsLint } from "../src/EsLint.ts"
import * as Input from "../src/Input.ts"
import { entrypoint, NodeTest } from "../src/NodeTest.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Target from "../src/Target.ts"
import { TsBuild } from "../src/TsBuild.ts"
import { Typecheck } from "../src/Typecheck.ts"
import { Vitest } from "../src/Vitest.ts"
import { VitestCoverage } from "../src/VitestCoverage.ts"
import { VitestWatch } from "../src/VitestWatch.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const vitestAttrs = {
  tests: [Input.glob("test/**/*.test.ts")],
  sources: [Input.glob("src/**/*.ts")],
  deps: [],
  config: null,
  environment: "node",
  coverage: false,
  passWithNoTests: false,
  cwd: "packages/example"
} as const

const typecheckAttrs = {
  srcs: [Input.glob("src/**/*.ts")],
  deps: [],
  tsconfig: Input.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd: "packages/example"
} as const

describe("rules name the attrs the workspace resolves", () => {
  const cases: ReadonlyArray<readonly [Target.AnyTarget, ReadonlyArray<Target.WorkspaceAttr>]> = [
    [Vitest({ ...vitestAttrs }), ["packageManager", "runtime"]],
    [Typecheck({ ...typecheckAttrs }), ["packageManager"]],
    [
      Dprint({ sources: [Input.glob("src/**/*.ts")], deps: [], config: Input.file("dprint.json"), fix: false }),
      ["packageManager"]
    ],
    [
      EsLint({
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        configs: [Input.file("eslint.config.js")],
        maxWarnings: 0,
        fix: false
      }),
      ["packageManager"]
    ],
    [
      NodeTest({ runner: entrypoint(Input.file("scripts/circular.mjs")), srcs: [], deps: [] }),
      ["runtime"]
    ]
  ]

  for (const [target, expected] of cases) {
    it(`${Target.metadata(target).target} reports ${expected.join(", ")}`, () => {
      expect([...Target.metadata(target).workspaceAttrs]).toEqual([...expected])
    })
  }

  it("a rule that runs no workspace tool names none", () => {
    const shell = Target.metadata(TsBuild({
      packageManager,
      srcs: [Input.glob("src/**/*.ts")],
      entries: [Input.file("src/index.ts")],
      deps: [],
      tsconfig: Input.file("tsconfig.json"),
      tool: { name: "tsc" },
      format: "esm",
      outDir: "dist"
    }))
    expect([...shell.workspaceAttrs]).toEqual(["packageManager"])
  })
})

describe("an unresolved workspace attr refuses by name", () => {
  it("the tool rules say which declaration is missing", () => {
    expect(() => plannedArgv(Vitest({ ...vitestAttrs }))).toThrow(/no package manager is available/)
    expect(() => plannedArgv(Typecheck({ ...typecheckAttrs }))).toThrow(/no package manager is available/)
  })

  it("the runtime rules say which declaration is missing", () => {
    expect(() => plannedArgv(NodeTest({ runner: entrypoint(Input.file("scripts/circular.mjs")), srcs: [], deps: [] })))
      .toThrow(/no runtime is available/)
  })

  it("the refusal names the workspace file, not the target", () => {
    expect(() => PackageManager.exec(undefined, ["vitest"])).toThrow(/WORKSPACE\.ts/)
    expect(() => Runtime.run(undefined, ["scripts/circular.mjs"])).toThrow(/WORKSPACE\.ts/)
  })
})

describe("a filled attr produces the argv the declaration used to spell", () => {
  it("Vitest runs through the workspace manager", () => {
    expect(plannedArgv(Vitest({ ...vitestAttrs, packageManager })))
      .toEqual(["pnpm", "exec", "vitest", "run", "--environment", "node", "--coverage.enabled=false"])
  })

  it("Typecheck runs through the workspace manager", () => {
    expect(plannedArgv(Typecheck({ ...typecheckAttrs, packageManager })))
      .toEqual(["pnpm", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"])
  })

  it("NodeTest runs under the workspace runtime", () => {
    expect(plannedArgv(
      NodeTest({ runtime, runner: entrypoint(Input.file("scripts/circular.mjs")), srcs: [], deps: [] })
    )).toEqual(["node", "scripts/circular.mjs"])
  })
})

describe("a declared runtime overrides the interpreter without naming a manager", () => {
  const bun = Runtime.Bun({ version: ">=1.4.0" })

  it("a Bun runtime moves the suite onto bun's own tool runner", () => {
    expect(plannedArgv(Vitest({ ...vitestAttrs, packageManager, runtime: bun })))
      .toEqual(["bun", "x", "--bun", "vitest", "run", "--environment", "node", "--coverage.enabled=false"])
  })

  it("the workspace runtime leaves the workspace manager in place", () => {
    expect(plannedArgv(Vitest({ ...vitestAttrs, packageManager, runtime })))
      .toEqual(["pnpm", "exec", "vitest", "run", "--environment", "node", "--coverage.enabled=false"])
  })

  it("PackageManager.under keeps a manager it was given no reason to replace", () => {
    expect(PackageManager.under(packageManager, undefined)).toBe(packageManager)
    expect(PackageManager.under(packageManager, runtime)).toBe(packageManager)
    expect(PackageManager.under(packageManager, bun)?.name).toBe("bun")
    expect(PackageManager.under(undefined, bun)?.name).toBe("bun")
  })
})

describe("Vitest coverage and watch deadlines", () => {
  const coverageAttrs = {
    packageManager,
    tests: [],
    sources: [],
    deps: [],
    config: null,
    provider: "v8",
    reportsDirectory: "coverage",
    thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 }
  } as const
  const cases = [
    ["VitestCoverage", (timeoutMs?: number) =>
      VitestCoverage({
        ...coverageAttrs,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })],
    ["VitestWatch", (timeoutMs?: number) =>
      VitestWatch({
        tests: vitestAttrs.tests,
        sources: vitestAttrs.sources,
        deps: vitestAttrs.deps,
        config: null,
        environment: "node",
        packageManager,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })]
  ] as const

  it.each(cases)("%s defaults to twenty minutes", (_, make) => {
    expect(plannedCalls(make())[0]?.payload["timeoutMs"]).toBe(1_200_000)
  })

  it.each(cases)("%s forwards an explicit deadline", (_, make) => {
    expect(plannedCalls(make(2_400_000))[0]?.payload["timeoutMs"]).toBe(2_400_000)
  })
})
