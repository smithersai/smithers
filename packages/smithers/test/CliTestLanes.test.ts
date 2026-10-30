import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const cwd = join(import.meta.dirname, "..")
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
interface Discovery {
  readonly files: Array<string>
  readonly maxWorkers: number
  readonly fileParallelism: boolean
  readonly coverageRequested?: boolean
  readonly thresholds: Record<string, unknown>
}
const discover = (args: Array<string>): Discovery => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { createVitest, parseCLI } from "vitest/node";
const { filter, options } = parseCLI(["vitest", ...JSON.parse(process.argv[1])]);
const { registerRootCleanup } = await import("../repo-targets/test-utils/vitest-root-temp.mjs");
const ctx = await createVitest("test", { ...options, cache: false, run: true, coverage: { ...options.coverage, enabled: false } });
try {
  registerRootCleanup(ctx);
  const files = await new ctx.config.sequence.sequencer(ctx).sort(await ctx.globTestSpecifications(filter));
  console.log(JSON.stringify({ files: files.map((file) => file.moduleId),
    maxWorkers: ctx.config.maxWorkers, fileParallelism: ctx.config.fileParallelism,
    coverageRequested: options.coverage?.enabled, thresholds: ctx.config.coverage.thresholds }));
} finally { await ctx.close(); }`,
    JSON.stringify(args)
  ], { cwd, encoding: "utf8", timeout: 15_000 })
  return JSON.parse(output) as Discovery
}

const declaredShell = () =>
  JSON.parse(execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { Package } from \"./PACKAGE.ts\"; import { metadata } from \"@smthrs/targets/Target\"; console.log(JSON.stringify(metadata(Package.test).attrs.shell))"
  ], { cwd, encoding: "utf8", timeout: 15_000 })) as string

it("schedules every default CLI file once in one bounded pool with the configured coverage gate", () => {
  const commands = [...declaredShell().matchAll(/pnpm exec vitest run ([^;"&}]+)/g)]
    .map((match) => match[1]!.trim().split(/\s+/))
  // Separate runners repeat compiler coordination and strand late static groups.
  expect(commands).toHaveLength(1)
  const actual = discover(commands[0]!)
  const standard = discover([])
  const faults = discover(["--config", "vitest.faults.config.ts"]).files
  const bothTiers = discover(["--exclude", "**/node_modules/**"]).files
  expect(actual.maxWorkers).toBe(4)
  expect(actual.fileParallelism).toBe(true)
  expect(actual.coverageRequested).toBe(true)
  expect(actual.thresholds).toEqual(standard.thresholds)
  expect(actual.files[0]).toMatch(/[/\\]NativeControlExternalPeerRecovery\.test\.ts$/)
  expect(
    actual.files.filter((file) =>
      /[/\\]Bin(?:Startup|Routing|Runtime|Migration|Launch|Scaffold)?\.test\.ts$/.test(file)
    )
  ).toHaveLength(7)
  expect(actual.files.sort()).toEqual(standard.files.sort())
  expect(faults.length).toBeGreaterThan(0)
  expect(actual.files.filter((file) => faults.includes(file))).toEqual([])
  expect([...actual.files, ...faults].sort()).toEqual(bothTiers.sort())
})

it.skipIf(process.platform === "win32")(
  "starts queued files while earlier files are blocked and retains late failures and cache cleanup",
  () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-cli-lanes-"))
    const phases = Array.from({ length: 6 }, (_, index) => `${index}`)
    try {
      symlinkSync(join(cwd, "node_modules"), join(root, "node_modules"), "dir")
      writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}")
      writeFileSync(
        join(root, "vitest.config.mjs"),
        `import { BaseSequencer } from "vitest/node";
export default { test: {
  include: ["*.test.mjs"], testTimeout: 12000,
  coverage: { enabled: true, provider: "v8", include: ["measured.mjs"],
    reporter: ["json-summary"], reportsDirectory: "coverage",
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 } },
  sequence: { sequencer: class extends BaseSequencer {
    sort(files) { return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
  } },
  globalSetup: [${
          JSON.stringify(
            fileURLToPath(new URL("../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
          )
        }]
} };`
      )
      writeFileSync(join(root, "measured.mjs"), "export const classify = value => value ? 'left' : 'right';\n")
      for (const phase of phases) {
        writeFileSync(
          join(root, `0${phase}.test.mjs`),
          `import { it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { getCompileCacheDir } from "node:module";
import { dirname, join } from "node:path";
import { classify } from "./measured.mjs";
import { spawnNodeSync } from ${JSON.stringify(new URL("./support/node-child.ts", import.meta.url).href)};
it(${JSON.stringify(phase)}, async () => {
  expect(process.env.VIBELANG_CACHE_DIR).toEqual(expect.any(String));
  expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();
  expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
  expect(getCompileCacheDir()).toBeUndefined();
  expect(classify(true)).toBe("left");
  expect(classify(false)).toBe("right");
  const nodeCache = join(dirname(process.env.VIBELANG_CACHE_DIR), "cache");
  const probe = "process.stdout.write(JSON.stringify({ vibe: process.env.VIBELANG_CACHE_DIR, node: process.env.NODE_COMPILE_CACHE, enabled: Boolean(require('node:module').getCompileCacheDir()), ambient: process.env.SMITHERS_LANES_AMBIENT_SENTINEL }))";
  const launched = spawnNodeSync(["-e", probe], { env: process.env, encoding: "utf8" });
  expect(launched.error).toBeUndefined();
  expect(launched.status, launched.stderr).toBe(0);
  const { ambient, ...isolatedCache } = JSON.parse(launched.stdout);
  expect(ambient).toBe("must-not-be-forwarded");
  const narrow = spawnNodeSync(["-e", probe], { env: { HOME: dirname(nodeCache) }, encoding: "utf8" });
  expect(narrow.status, narrow.stderr).toBe(0);
  expect(JSON.parse(narrow.stdout)).toEqual({ vibe: process.env.VIBELANG_CACHE_DIR, node: nodeCache, enabled: true });
  expect(getCompileCacheDir()).toBeUndefined();
  expect(isolatedCache).toEqual({ vibe: process.env.VIBELANG_CACHE_DIR, node: nodeCache, enabled: true });
  writeFileSync(${JSON.stringify(join(root, phase))}, JSON.stringify({ ...isolatedCache, pid: process.pid }));
  if (${Number(phase) < 3}) {
    const deadline = Date.now() + 8000;
    while (!existsSync(${JSON.stringify(join(root, "4"))}) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(${JSON.stringify(join(root, "4"))})).toBe(true);
  }
  if (${phase === "5"} && process.env.SMITHERS_LANES_FAIL_LAST === "1") {
    throw new Error("retained-late-failure");
  }
});`
        )
      }
      const shell = declaredShell()
        .replace("cd packages/smithers && ", "")
        .replace("&& trap", "&& printf '%s' \"$work\" > \"$SMITHERS_LANES_SCRATCH_RECEIPT\" && trap")
        .replaceAll("vitest.config.ts", "vitest.config.mjs")
        // Use the installed entrypoint when pnpm shims point outside this temporary symlink.
        .replaceAll("pnpm exec vitest", `${quote(process.execPath)} ${quote(vitest)}`)
      const scratch = join(root, "tmp")
      mkdirSync(scratch)
      for (const failure of [false, true]) {
        for (const phase of phases) rmSync(join(root, phase), { force: true })
        const completed = spawnSync("sh", ["-c", shell], {
          cwd: root,
          env: {
            ...process.env,
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
            SMITHERS_LANES_SCRATCH_RECEIPT: join(root, "owned-work"),
            SMITHERS_CLI_DISABLE_COMPILE_CACHE: "",
            SMITHERS_LANES_AMBIENT_SENTINEL: "must-not-be-forwarded",
            SMITHERS_LANES_FAIL_LAST: failure ? "1" : "0"
          },
          encoding: "utf8",
          timeout: 25_000
        })
        expect(completed.error, completed.stderr).toBeUndefined()
        if (failure) {
          expect(completed.status).not.toBe(0)
          expect(completed.stdout + completed.stderr).toContain("retained-late-failure")
        } else expect(completed.status, completed.stdout + completed.stderr).toBe(0)
        if (!failure) {
          const summary = JSON.parse(readFileSync(join(root, "coverage/coverage-summary.json"), "utf8"))
          for (const metric of ["lines", "branches", "functions", "statements"]) {
            expect(summary.total[metric].pct).toBe(100)
          }
        }
        const owned = readFileSync(join(root, "owned-work"), "utf8")
        const workers: Array<number> = []
        for (const phase of phases) {
          const { pid, ...cache } = JSON.parse(readFileSync(join(root, phase), "utf8"))
          workers.push(pid)
          expect(cache).toEqual({ vibe: join(owned, "vibelang-cache"), node: join(owned, "cache"), enabled: true })
        }
        expect(new Set(workers.slice(0, 3)).size).toBe(3)
        expect(workers.slice(0, 3)).not.toContain(workers[3])
        expect(readdirSync(scratch)).toEqual([])
        expect(existsSync(owned)).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
