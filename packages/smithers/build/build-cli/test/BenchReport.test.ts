import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as Ansi from "../src/Ansi.ts"
import * as BenchReport from "../src/BenchReport.ts"

describe("BenchReport", () => {
  it("parses Vitest 5 verbose benchmark tables and strips ANSI sequences", () => {
    const sample = [
      "\u001b[32m ✓ \u001b[39m|bench| test/BranchProjection.bench.ts > BranchProjection > rebuild 10,000 ordered chat commands 5462ms",
      "   name          hz      min     max     mean      p75     p99    p995    p999      rme  samples",
      "   project  19.2962  16.1848  201.76  72.0312  91.2551  186.17  193.96  200.20  ±14.11%       64",
      " · fast     1,234.5   0.7100  1.4000   0.8100   0.8500  1.1200  1.2000  1.3500   ±1.20%      500  fastest"
    ].join("\n")

    const rows = BenchReport.parse(sample)
    expect(rows).toEqual([
      {
        suite: "BranchProjection > rebuild 10,000 ordered chat commands",
        name: "project",
        hz: 19.2962,
        minMs: 16.1848,
        maxMs: 201.76,
        meanMs: 72.0312,
        p75Ms: 91.2551,
        p99Ms: 186.17,
        rme: "±14.11%",
        samples: 64
      },
      {
        suite: "BranchProjection > rebuild 10,000 ordered chat commands",
        name: "fast",
        hz: 1234.5,
        minMs: 0.71,
        maxMs: 1.4,
        meanMs: 0.81,
        p75Ms: 0.85,
        p99Ms: 1.12,
        rme: "±1.20%",
        samples: 500,
        note: "fastest"
      }
    ])
  })

  it("parses BENCH_METRIC JSON lines and ignores malformed entries", () => {
    const sample = [
      "BENCH_METRIC not-json",
      "BENCH_METRIC {\"suite\":\"startup\",\"name\":\"boot\",\"hz\":42.5,\"meanMs\":23.5,\"p99Ms\":31.2,\"samples\":20}",
      "BENCH_METRIC {\"name\":\"\"}"
    ].join("\n")

    expect(BenchReport.parse(sample)).toEqual([
      {
        suite: "startup",
        name: "boot",
        hz: 42.5,
        meanMs: 23.5,
        p99Ms: 31.2,
        samples: 20
      }
    ])
  })

  it("extracts stdout and formats a unified table for live and cached results", () => {
    expect(BenchReport.stdoutOf({ exitCode: 0, stdout: "hello", stderr: "" })).toBe("hello")
    expect(BenchReport.stdoutOf({ _tag: "CacheValue", value: { exitCode: 0, stdout: "cached-out", stderr: "" } }))
      .toBe("cached-out")
    expect(BenchReport.stdoutOf({ kind: "evidence", reads: [], result: { value: { stdout: "evidenced-out" } } }))
      .toBe("evidenced-out")
    expect(BenchReport.stdoutOf(null)).toBeUndefined()
    expect(BenchReport.format([{ label: "//pkg:bench", status: "ran" }])).toBeUndefined()

    const table = BenchReport.format([
      {
        label: "//packages/a:bench",
        status: "ran",
        benchmarks: [{
          suite: "core",
          name: "encode",
          hz: 125_000,
          meanMs: 0.008,
          p99Ms: 0.012,
          rme: "±0.50%",
          samples: 1000
        }]
      },
      {
        label: "//packages/b:bench",
        status: "hit",
        benchmarks: [{ name: "boot", hz: 5.5, meanMs: 180, p99Ms: 240, samples: 10 }]
      }
    ], Ansi.none)

    expect(table).toBeDefined()
    expect(table).toContain("TARGET")
    expect(table).toContain("//packages/a:bench")
    expect(table).toContain("core :: encode")
    expect(table).toContain("8.0µs")
    expect(table).toContain("live")
    expect(table).toContain("//packages/b:bench")
    expect(table).toContain("cached")
  })
})

describe("Affected.changedPaths jj workspace support", () => {
  it("uses jj diff when .jj exists without .git", async () => {
    const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-jj-affected-"))
    try {
      await Fs.mkdir(Path.join(dir, ".jj"))
      const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = []
      const paths = await Affected.changedPaths(
        dir,
        { base: "HEAD" },
        async (request) => {
          calls.push({ command: request.command, args: request.args })
          request.stdout?.("packages/b/src/index.ts\npackages/a/src/index.ts\npackages/a/src/index.ts\n")
          return 0
        }
      )
      expect(calls).toEqual([
        {
          command: "jj",
          args: ["--no-pager", "--color=never", "diff", "--name-only", "--from=@-", "--to=@"]
        }
      ])
      expect(paths).toEqual(["packages/a/src/index.ts", "packages/b/src/index.ts"])
    } finally {
      await Fs.rm(dir, { recursive: true, force: true })
    }
  })
})
