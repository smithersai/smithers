import { Smithers } from "@smthrs/targets"
import { describe, test } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as BenchReport from "../src/BenchReport.ts"
import * as Label from "../src/Label.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import type { LoadedGraph } from "../src/PackageLoader.ts"
import * as Planner from "../src/Planner.ts"

const opts = { time: 120, warmupTime: 30 }

const labelSamples = [
  ":bench",
  "//packages/smithers:test",
  "//packages/smithers/build/build-cli:check",
  "//packages/smithers/...",
  "//packages/...:bench",
  "//apps/mvp:importRules",
  "//...:test"
]

const sampleBenchStdout = [
  " ✓ |bench| test/Canonical.bench.ts > @smthrs/canonical > canonicalize 200ms",
  "   name                           hz     min     max    mean     p75     p99   rme  samples",
  " · canonicalize (16 steps)   142,350  0.0061  0.0812  0.0070  0.0072  0.0110  ±0.45%    17082",
  " · canonicalize (200 rows)     8,412  0.1120  0.4201  0.1188  0.1210  0.1640  ±0.62%     1010",
  "BENCH_METRIC " + JSON.stringify({
    suite: "ui",
    name: "render markdown (4KB)",
    hz: 4200,
    minMs: 0.21,
    maxMs: 0.55,
    meanMs: 0.238,
    p75Ms: 0.245,
    p99Ms: 0.31,
    samples: 500
  })
].join("\n")

const makeSyntheticGraph = (packageCount: number): LoadedGraph => {
  const packages: Array<{
    readonly packagePath: string
    readonly file: string
    readonly value: ReturnType<typeof Smithers.Package>
  }> = []
  let previousLib: ReturnType<typeof Smithers.Filegroup> | undefined
  for (let i = 0; i < packageCount; i++) {
    const pkgPath = `packages/pkg-${String(i).padStart(2, "0")}`
    const lib = Smithers.Filegroup({
      srcs: [
        Smithers.glob("src/**/*.ts"),
        Smithers.file("package.json"),
        ...(previousLib === undefined ? [] : [previousLib])
      ],
      cwd: pkgPath
    })
    const testTarget = Smithers.NodeTest({
      runner: Smithers.entrypoint(Smithers.file("test/run.ts")),
      srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
      deps: [lib],
      cwd: pkgPath
    })
    const benchTarget = Smithers.NodeBench({
      entry: Smithers.file("bench/run.ts"),
      srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("bench/**/*.ts")],
      deps: [lib],
      cache: true,
      cwd: pkgPath
    })
    packages.push({
      packagePath: pkgPath,
      file: `${pkgPath}/PACKAGE.ts`,
      value: Smithers.Package({ targets: { lib, test: testTarget, bench: benchTarget } })
    })
    if (i % 5 === 0) previousLib = lib
  }
  return {
    root: "/bench-workspace",
    workspace: Smithers.Workspace("bench-ws", {
      repository: "git+https://example.invalid/bench-ws.git",
      cache: Smithers.Cache({ directory: ".flows" }),
      runtime: Smithers.Runtime.Node({ version: ">=26.4.0" }),
      packageManager: Smithers.PackageManager.Pnpm({
        version: "11.25.0",
        runtime: Smithers.Runtime.Node({ version: ">=26.4.0" })
      }),
      nodeModules: Smithers.Npm.NodeModules({ packageJson: Smithers.file("//package.json") }),
      sandboxes: Smithers.Sandboxes({ default: Smithers.Sandbox.None() })
    }),
    factory: undefined,
    packages
  }
}

const syntheticGraph = makeSyntheticGraph(50)
const syntheticIndex = PackageIndex.make(syntheticGraph)

const keyMaterial: Planner.KeyMaterial = {
  body: { flow: "VitestBench", target: "VitestBench", executionFormat: Planner.EXECUTION_FORMAT },
  capabilities: ["fs:read", "proc:spawn"],
  inputs: Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [
      `src/module-${index}.ts`,
      `${index.toString(16).padStart(4, "0")}${"a".repeat(60)}`
    ])
  ),
  layers: [
    "runtime:node@26.10.0",
    "packageManager:pnpm@11.25.0",
    "platform:darwin-arm64"
  ]
}

describe("@smthrs/build-cli", () => {
  test("Label.parse and Label.format (7 patterns)", async ({ bench }) => {
    await bench("Label.parse + format (7)", () => {
      for (const sample of labelSamples) {
        const parsed = Label.parse(sample, "packages/smithers/build/build-cli")
        if (parsed._tag === "Exact" && parsed.target !== undefined) {
          Label.format(parsed.packagePath, parsed.target)
        }
      }
    }).run(opts)
  })

  test("BenchReport.parse and format", async ({ bench }) => {
    await bench("BenchReport.parse + format", () => {
      const rows = BenchReport.parse(sampleBenchStdout)
      BenchReport.format([
        { label: "//packages/smithers/flows/canonical:bench", status: "ran", benchmarks: rows }
      ])
    }).run(opts)
  })

  test("PackageIndex.resolve over 50 packages (150 targets)", async ({ bench }) => {
    await bench("PackageIndex.resolve (wildcards)", () => {
      syntheticIndex.resolve("//packages/...:bench")
      syntheticIndex.resolve("//packages/pkg-10:test")
      syntheticIndex.resolve("//...")
    }).run(opts)
  })

  test("Affected.select across 50 packages", async ({ bench }) => {
    await bench("Affected.select (50 pkgs, 3 edits)", () => {
      Affected.select(
        syntheticIndex,
        ["//packages/...:bench"],
        [
          "packages/pkg-05/src/index.ts",
          "packages/pkg-22/src/core.ts",
          "packages/pkg-40/bench/run.ts"
        ]
      )
    }).run(opts)
  })

  test("Planner.keyOf (50 input digests)", async ({ bench }) => {
    await bench("Planner.keyOf (50 inputs)", () => {
      Planner.keyOf(keyMaterial)
    }).run(opts)
  })
})
