/** Cached CLI children never enable caches in processes whose V8 coverage is collected. */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
type Coverage = {
  result: Array<{
    url: string
    functions: Array<{
      functionName: string
      ranges: Array<{ startOffset: number; endOffset: number; count: number }>
    }>
  }>
}

it.each([
  { label: "uncounted CLI", disable: "", measured: false, cached: true },
  { label: "explicit caller opt-out", disable: "1", measured: false, cached: false },
  { label: "externally collected V8 coverage", disable: "", measured: true, cached: false }
])("preserves cache and coverage ownership for $label", async ({ disable, measured, cached }) => {
  const directory = await mkdtemp(join(tmpdir(), "cli-child-cache-"))
  try {
    const reports = join(directory, "reports")
    await mkdir(reports)
    const probe = join(directory, "probe.mjs")
    const code = "export const classify = flag => flag ? 'left' : 'right';\n"
    await writeFile(probe, code)
    const childCode = `import { getCompileCacheDir } from "node:module";
import { classify } from ${JSON.stringify(pathToFileURL(probe).href)};
console.log(JSON.stringify({ cached: Boolean(getCompileCacheDir()), counted: Boolean(process.env.NODE_V8_COVERAGE),
  values: [classify(true), classify(false)] }));`
    const parentCode = `import { execFileSync } from "node:child_process";
import { getCompileCacheDir } from "node:module";
import { temporaryEnvironment } from ${JSON.stringify(new URL("./temporaryEnvironment.ts", import.meta.url).href)};
const child = execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childCode)}], {
  env: temporaryEnvironment(), encoding: "utf8"
});
console.log(JSON.stringify({ workerCached: Boolean(getCompileCacheDir()), child: JSON.parse(child) }));`
    const result = await execute(process.execPath, ["--input-type=module", "-e", parentCode], {
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: undefined,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_V8_COVERAGE: measured ? reports : undefined,
        SMITHERS_CLI_NODE_COMPILE_CACHE: join(directory, "cache"),
        SMITHERS_CLI_DISABLE_COMPILE_CACHE: disable
      }
    })
    expect(JSON.parse(result.stdout), result.stderr).toEqual({
      workerCached: false,
      child: { cached, counted: measured, values: ["left", "right"] }
    })
    if (measured) {
      const results: Coverage["result"] = []
      for (const name of await readdir(reports)) {
        const report = JSON.parse(await readFile(join(reports, name), "utf8")) as Coverage
        results.push(...report.result)
      }
      const scripts = results.filter((script) => script.url === pathToFileURL(probe).href)
      expect(scripts).toHaveLength(1)
      const ranges = scripts[0]!.functions.find((fn) => fn.functionName === "classify")!.ranges
      expect(ranges.length).toBeGreaterThanOrEqual(2)
      for (const range of ranges) {
        expect(range.count).toBeGreaterThan(0)
        expect(range.endOffset).toBeGreaterThan(range.startOffset)
        expect(range.endOffset).toBeLessThanOrEqual(code.length)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
