/**
 * What one plan costs when every target declares the same glob over a tree
 * that grows with the targets, the shape of a compiler suite with one test per
 * case directory. Reading a shared glob per target makes that cost quadratic:
 * 3,200 targets took 56 minutes where a single expansion takes one second.
 *
 * `linear` measures two sizes in one process, so a slow host scales both, and
 * fails when four times the targets costs more than eight times the time.
 * Linear growth reads 4 and a per-target walk reads about 16.
 *
 * Run: `pnpm --filter @smthrs/build-cli bench`.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const suite = async (count: number): Promise<PackageIndex> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plan-sharing-bench-")))
  roots.push(root)
  const write = async (relative: string, contents: string): Promise<void> => {
    const path = Path.join(root, relative)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, contents)
  }
  await write("package.json", "{\"name\":\"plan-sharing-bench\",\"private\":true,\"type\":\"module\"}\n")
  await write(
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("plan-sharing-bench", {
  repository: "git+https://example.invalid/plan-sharing-bench.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`
  )
  await write("cases/helper.mjs", "export {}\n")
  const cases = Array.from({ length: count }, (_, index) => `c${index}`)
  await Promise.all(cases.map((name) => write(`cases/${name}/input.txt`, `${name}\n`)))
  await write(
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const test = (name: string) => S.Shell.Test({
  summary: "One case.",
  shell: "true",
  data: [S.glob("cases/*.mjs"), S.glob(\`cases/\${name}/**\`)],
  sandbox: "none"
})
export const Package = S.Package({ targets: Object.fromEntries(${
      JSON.stringify(cases)
    }.map((name) => [name, test(name)])) })\n`
  )
  return PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
}

const planOnce = (index: PackageIndex) =>
  PackageExec.plan({ index, patterns: ["//..."], cacheDirectory: ".flows", verb: "test" })

/** Each plan takes seconds, so a fixed few samples rather than a time budget. */
const few = { time: 0, iterations: 3, warmup: true, warmupIterations: 1, warmupTime: 0 }

/** The fastest of three plans, so a pause on a loaded host does not read as growth. */
const planSeconds = async (index: PackageIndex): Promise<number> => {
  const samples: Array<number> = []
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now()
    await planOnce(index)
    samples.push((performance.now() - started) / 1000)
  }
  return Math.min(...samples)
}

describe("PackageExec.plan", () => {
  test("linear in targets that share a glob", { timeout: 600_000 }, async ({ bench }) => {
    const small = await suite(100)
    const large = await suite(400)
    await planOnce(small)
    const seconds = { small: await planSeconds(small), large: await planSeconds(large) }
    const growth = seconds.large / seconds.small
    process.stdout.write(
      `plan ${seconds.small.toFixed(3)} s at 100 targets, ${seconds.large.toFixed(3)} s at 400: ${growth.toFixed(1)}x\n`
    )
    expect(growth).toBeLessThan(8)
    await bench.compare(
      bench("100 targets sharing a glob", () => planOnce(small)),
      bench("400 targets sharing a glob", () => planOnce(large)),
      few
    )
  })
})
