import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"

// The three tiers of the backpressure protocol (`.smithers/workflows/{fast,medium,full}-check.ts`) each print their
// plan under `--dry-run` and exit 0 without running a step.
const root = fileURLToPath(new URL("../../../../", import.meta.url))

const dryRun = (tier: string) =>
  spawnSync(process.execPath, [`.smithers/workflows/${tier}-check.ts`, "--dry-run"], { cwd: root, encoding: "utf8", timeout: 60_000 })

describe("tiered backpressure workflows", () => {
  test("fast-check --dry-run plans its steps and exits 0", () => {
    const result = dryRun("fast")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^fast-check plan: \d+ step\(s\) for \d+ changed file\(s\)$/m)
    expect(result.stdout).toMatch(/^plan {2}copy scan/m)
  })

  test("medium-check --dry-run plans typecheck, integration, bounded fuzz and Lean, and exits 0", () => {
    const result = dryRun("medium")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^medium-check plan: \d+ step\(s\)$/m)
    for (const step of ["typecheck worker/tsconfig.json", "integration vitest", "bounded fuzz", "lean apps/mvp/spec/lean/mcp_and_stack"]) {
      expect(result.stdout).toMatch(new RegExp(`^(plan|skip) {2}${step}`, "m"))
    }
    expect(result.stdout).toContain("EFFECT_FUZZ_EXECUTIONS=200")
  })

  test("full-check --dry-run plans preflight, shards, GIFs, deep fuzz, Lean and benchmarks, and exits 0", () => {
    const result = spawnSync(process.execPath, [".smithers/workflows/full-check.ts", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, FULL_CHECK_SHARDS: "3" },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^full-check plan: \d+ step\(s\)$/m)
    for (const step of [
      "preflight alchemy --version",
      "preflight deploy toolchain",
      "e2e shard 1/3",
      "e2e shard 3/3",
      "e2e GIF check",
      "deep fuzz",
      "lean packages/ci/spec/lean",
      "benchmarks",
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^(plan|skip) {2}${step.replace(/[/.]/g, "\\$&")}`, "m"))
    }
    expect(result.stdout).not.toContain("e2e shard 4/3")
  })
})

// Regressions for the W2-I review (scratch/w2/astra-review-i.md), Medium 4 and 5: each tier runs in a scratch
// checkout outside any jj repository, so `jj root` fails and the tier takes its working directory as the root.
const scratch = mkdtempSync(join(tmpdir(), "tiered-workflows-"))
afterAll(() => {
  chmodSync(join(scratch, "outside/locked.md"), 0o644)
  rmSync(scratch, { recursive: true, force: true })
})
const checkout = join(scratch, "checkout")
const outside = join(scratch, "outside")
const put = (path: string, text = "") => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const linkAt = (path: string, target: string) => {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}
put(join(checkout, "apps/mvp/-dash.test.ts"))
put(join(outside, "secret.md"), "outside — prose; with an em dash\n")
put(join(outside, "locked.md"), "locked")
chmodSync(join(outside, "locked.md"), 0o000)
linkAt(join(checkout, "docs/leak.md"), join(outside, "secret.md"))
linkAt(join(checkout, "docs/locked.md"), join(outside, "locked.md"))
put(join(checkout, "docs/fine.md"), "fine\n")
put(join(outside, "proj/lakefile.toml"), "name = \"outside\"")
put(join(checkout, "apps/mvp/spec/lean/good/lakefile.toml"), "name = \"good\"")
linkAt(join(checkout, "apps/mvp/spec/lean/evil"), join(outside, "proj"))
linkAt(join(checkout, "apps/mvp/spec/lean/sneaky/lakefile.lean"), join(outside, "proj/lakefile.toml"))
linkAt(join(checkout, "apps/vibelang/spec/lean"), outside)
linkAt(join(checkout, "lean/smithers-state"), join(outside, "proj"))

const inScratch = (tier: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [join(root, `.smithers/workflows/${tier}-check.ts`), ...args], { cwd: checkout, encoding: "utf8", timeout: 60_000 })

describe("Medium 4: fast-check passes paths, not options, and reads only inside the checkout", () => {
  test("a test file named with a leading dash reaches Vitest as ./-dash.test.ts", () => {
    const result = inScratch("fast", ["--dry-run", "apps/mvp/-dash.test.ts"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("vitest run --coverage.enabled=false ./-dash.test.ts")
    expect(result.stdout).not.toMatch(/ -dash\.test\.ts/)
  })

  test("--dry-run refuses symlinked and caller-supplied Markdown outside the checkout without reading it", () => {
    const result = inScratch("fast", ["--dry-run", "docs/leak.md", "docs/locked.md", "../outside/secret.md", "docs/fine.md"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^refuse {2}confine {2}3 path\(s\) outside the checkout: docs\/leak\.md docs\/locked\.md \.\.\/outside\/secret\.md$/m)
    expect(result.stdout).toMatch(/^plan {2}copy scan {2}1 changed doc\(s\)$/m)
  })

  test("a run fails on a path outside the checkout and never scans its text", () => {
    const result = inScratch("fast", ["docs/leak.md", "docs/fine.md"])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("outside the checkout: docs/leak.md")
    expect(result.stdout).toMatch(/^pass {2}copy scan/m)
    expect(result.stdout).not.toContain("semicolon or em dash")
  })
})

describe("Medium 5: Lean project directories resolve inside the checkout", () => {
  test("medium-check refuses a symlinked project and a symlinked lakefile, keeps the real one", () => {
    const result = inScratch("medium", ["--dry-run"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^(plan|skip) {2}lean apps\/mvp\/spec\/lean\/good /m)
    expect(result.stdout).toMatch(/^refuse {2}lean apps\/mvp\/spec\/lean\/evil {2}resolves outside the checkout$/m)
    expect(result.stdout).toMatch(/^refuse {2}lean apps\/mvp\/spec\/lean\/sneaky {2}its lakefile resolves outside the checkout$/m)
    expect(result.stdout).not.toContain(outside)
  })

  test("medium-check fails a run with a refused project instead of building it", () => {
    const result = inScratch("medium", [])
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^FAIL {2}lean apps\/mvp\/spec\/lean\/evil {2}resolves outside the checkout$/m)
  })

  test("full-check refuses a symlinked Lean parent and a symlinked fixed project", () => {
    const result = inScratch("full", ["--dry-run"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^refuse {2}lean apps\/vibelang\/spec\/lean {2}resolves outside the checkout$/m)
    expect(result.stdout).toMatch(/^refuse {2}lean lean\/smithers-state {2}resolves outside the checkout$/m)
    expect(result.stdout).toMatch(/^refuse {2}lean apps\/mvp\/spec\/lean\/evil /m)
    expect(result.stdout).toMatch(/^(plan|skip) {2}lean apps\/mvp\/spec\/lean\/good /m)
    expect(result.stdout).not.toContain(outside)
  })
})
