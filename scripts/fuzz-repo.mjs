#!/usr/bin/env node
/**
 * Unified repository-wide fuzz runner & fuzz-only coverage reporter.
 *
 * Usage:
 *   node scripts/fuzz-repo.mjs [options]
 *
 * Options:
 *   --executions <N>        Override EFFECT_FUZZ_EXECUTIONS
 *   --duration <ms>         Override EFFECT_FUZZ_DURATION
 *   --seed <N>              Override EFFECT_FUZZ_SEED
 *   --v8                    Enable EFFECT_FUZZ_V8_COVERAGE=1 (V8 coverage-guided feedback)
 *   --coverage              Run ONLY *.fuzz.test.{ts,vibe} with V8 coverage and report per-package fuzz-only coverage
 *   --filter <substring>    Only run packages matching substring
 *   --concurrency <N>       Parallel package workers (default: min(8, cpus/2))
 *   --include-vibelang      Include apps/vibelang compiler fuzz suites (130+ files)
 *   --rust                  Run Rust deterministic fuzz tests (flows-jj, smithers-ffi)
 *   --zig                   Run Zig native fuzz tests (observe.c, smithers-ffi C ABI)
 *   --zig-runs <N>          Run Zig LLVM coverage-guided --fuzz=<N> on Linux
 *   --libfuzzer-seconds <N> Also run all 6 Rust cargo-fuzz LLVM libFuzzer targets for N seconds each (Linux/nightly)
 *   --list                  List discovered fuzz suites without running them
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const args = process.argv.slice(2)
const flagValue = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return undefined
}
const hasFlag = (name) => args.includes(name)

const executions = flagValue("--executions")
const duration = flagValue("--duration")
const seed = flagValue("--seed")
const filter = flagValue("--filter")
const v8Guided = hasFlag("--v8")
const measureCoverage = hasFlag("--coverage") || hasFlag("--per-file")
const perFile = hasFlag("--per-file")
const includeVibelang = hasFlag("--include-vibelang") || (filter !== undefined && filter.includes("vibelang"))
const zigRuns = Number(flagValue("--zig-runs") ?? "0")
const runRust = hasFlag("--rust") || hasFlag("--all") || flagValue("--libfuzzer-seconds") !== undefined
const runZig = hasFlag("--zig") || hasFlag("--all") || zigRuns > 0
const nativeOnly = (hasFlag("--rust") || hasFlag("--zig")) && !hasFlag("--all") && !measureCoverage && filter === undefined
const libfuzzerSeconds = Number(flagValue("--libfuzzer-seconds") ?? "0")
const listOnly = hasFlag("--list")
const concurrency = Math.max(
  1,
  Number(flagValue("--concurrency") ?? String(Math.min(8, Math.max(2, Math.floor(cpus().length / 2)))))
)

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", ".git", ".jj", "corpus", ".turbo", "coverage"])
const FUZZ_FILE_RE = /\.fuzz\.test\.(?:ts|vibe)$/

function findFuzzFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) && !(entry.name === "build" && existsSync(join(dir, entry.name, "package.json")))) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      findFuzzFiles(full, out)
    } else if (entry.isFile() && FUZZ_FILE_RE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function findPackageRoot(filePath) {
  let cur = dirname(filePath)
  while (cur.length >= rootDir.length) {
    if (cur !== rootDir && existsSync(join(cur, "package.json"))) {
      return cur
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return rootDir
}

function discoverSuites() {
  const files = [
    ...findFuzzFiles(join(rootDir, "packages")),
    ...findFuzzFiles(join(rootDir, "apps"))
  ]
  const byPkg = new Map()
  for (const file of files) {
    const pkgDir = findPackageRoot(file)
    const relPkg = relative(rootDir, pkgDir)
    if (!includeVibelang && relPkg.startsWith("apps/vibelang")) continue
    if (filter !== undefined && !relPkg.includes(filter)) continue
    let list = byPkg.get(relPkg)
    if (list === undefined) {
      list = []
      byPkg.set(relPkg, list)
    }
    list.push(relative(pkgDir, file))
  }
  const crossFiles = findFuzzFiles(join(rootDir, "fuzz"))
  if (crossFiles.length > 0 && (filter === undefined || "fuzz".includes(filter))) {
    const testingDir = join(rootDir, "packages/testing")
    byPkg.set("fuzz", crossFiles.map((f) => relative(testingDir, f)))
  }
  return [...byPkg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, relFiles]) => ({
      pkg,
      dir: pkg === "fuzz" ? join(rootDir, "packages/testing") : join(rootDir, pkg),
      files: relFiles.sort()
    }))
}

function execAsync(cmd, cmdArgs, cwd, env) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr, ms: Date.now() - started })
    })
    child.on("error", (err) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, ms: Date.now() - started })
    })
  })
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

function readCoverageSummary(covDir) {
  const summaryPath = join(covDir, "coverage-summary.json")
  if (!existsSync(summaryPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(summaryPath, "utf8"))
    const files = Object.entries(parsed)
      .filter(([k]) => k !== "total")
      .map(([file, metrics]) => ({ file, lines: metrics.lines?.pct ?? 0, branches: metrics.branches?.pct ?? 0, totalLines: metrics.lines?.total ?? 0 }))
      .sort((a, b) => a.lines - b.lines)
    return { total: parsed.total, files }
  } catch {
    return undefined
  }
}

const fmtPct = (v) => (typeof v === "number" ? v.toFixed(1) : "n/a")

async function runTsSuites(suites) {
  const tmpBase = measureCoverage ? mkdtempSync(join(tmpdir(), "smithers-fuzz-cov-")) : undefined
  const baseEnv = {
    ...process.env,
    NO_COLOR: "1",
    EFFECT_FUZZ: "1",
    ...(executions !== undefined ? { EFFECT_FUZZ_EXECUTIONS: executions } : {}),
    ...(duration !== undefined ? { EFFECT_FUZZ_DURATION: duration } : {}),
    ...(seed !== undefined ? { EFFECT_FUZZ_SEED: seed } : {}),
    ...(v8Guided ? { EFFECT_FUZZ_V8_COVERAGE: "1" } : {})
  }

  console.log(
    `Running ${suites.length} fuzz package(s) (concurrency=${concurrency}` +
      `${executions ? `, executions=${executions}` : ""}` +
      `${duration ? `, duration=${duration}ms` : ""}` +
      `${v8Guided ? ", v8-guided=on" : ""}` +
      `${measureCoverage ? ", mode=fuzz-only-coverage" : ""})...`
  )

  const results = await runPool(suites, concurrency, async (suite) => {
    const isTui = suite.pkg === "apps/tui"
    const isMvp = suite.pkg === "apps/mvp"
    const isCrossFuzz = suite.pkg === "fuzz"
    const covDir = tmpBase ? join(tmpBase, suite.pkg.replace(/[\\/]/g, "__")) : undefined
    if (covDir) mkdirSync(covDir, { recursive: true })

    let cmd = "pnpm"
    let cmdArgs
    if (isTui) {
      cmd = "bun"
      cmdArgs = ["test", ...suite.files]
    } else if (measureCoverage) {
      cmdArgs = [
        "exec",
        "vitest",
        "run",
        ...(isMvp || isCrossFuzz ? ["--config", "vitest.fuzz.config.ts"] : []),
        ...suite.files,
        "--coverage.enabled=true",
        "--coverage.provider=v8",
        "--coverage.reporter=json-summary",
        `--coverage.reportsDirectory=${covDir}`,
        "--coverage.thresholds.lines=0",
        "--coverage.thresholds.branches=0",
        "--coverage.thresholds.functions=0",
        "--coverage.thresholds.statements=0"
      ]
    } else {
      cmdArgs = [
        "exec",
        "vitest",
        "run",
        ...(isMvp || isCrossFuzz ? ["--config", "vitest.fuzz.config.ts"] : []),
        ...suite.files,
        "--coverage=false"
      ]
    }

    const res = await execAsync(cmd, cmdArgs, suite.dir, baseEnv)
    const cov = covDir ? readCoverageSummary(covDir) : undefined
    const status = res.code === 0 ? "PASS" : "FAIL"
    const covText = cov?.total
      ? ` | stmts=${(typeof cov.total.statements.pct === "number" ? fmtPct(cov.total.statements.pct) : "0.0")}% branch=${(typeof cov.total.branches.pct === "number" ? fmtPct(cov.total.branches.pct) : "0.0")}% funcs=${(typeof cov.total.functions.pct === "number" ? fmtPct(cov.total.functions.pct) : "0.0")}% lines=${(typeof cov.total.lines.pct === "number" ? fmtPct(cov.total.lines.pct) : "0.0")}%`
      : ""
    console.log(`  [${status}] ${suite.pkg} (${suite.files.length} file${suite.files.length === 1 ? "" : "s"}, ${res.ms}ms)${covText}`)
    if (res.code !== 0) {
      const tail = (res.stdout + "\n" + res.stderr).trim().split("\n").slice(-35).join("\n")
      console.error(`--- failure output for ${suite.pkg} ---\n${tail}\n---`)
    }
    return { suite, res, cov }
  })

  if (tmpBase) {
    try {
      rmSync(tmpBase, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
  }

  if (measureCoverage) {
    console.log("\n=== Fuzz-Only V8 Coverage Summary (NO non-fuzz tests executed) ===")
    console.log("Package | Stmts | Branch | Funcs | Lines")
    console.log("--- | --- | --- | --- | ---")
    let totStmts = 0, covStmts = 0
    let totBranches = 0, covBranches = 0
    let totFuncs = 0, covFuncs = 0
    let totLines = 0, covLines = 0
    for (const r of results) {
      if (!r.cov?.total) continue
      const t = r.cov.total
      totStmts += t.statements.total; covStmts += t.statements.covered
      totBranches += t.branches.total; covBranches += t.branches.covered
      totFuncs += t.functions.total; covFuncs += t.functions.covered
      totLines += t.lines.total; covLines += t.lines.covered
      console.log(
        `${r.suite.pkg} | ${fmtPct(t.statements.pct)}% (${t.statements.covered}/${t.statements.total}) | ` +
          `${fmtPct(t.branches.pct)}% (${t.branches.covered}/${t.branches.total}) | ` +
          `${fmtPct(t.functions.pct)}% (${t.functions.covered}/${t.functions.total}) | ` +
          `${fmtPct(t.lines.pct)}% (${t.lines.covered}/${t.lines.total})`
      )
      if (perFile && r.cov.files.length > 0) {
        const worst = r.cov.files.filter((f) => f.totalLines > 0 && f.lines < 80).slice(0, 5)
        for (const f of worst) {
          console.log(`    ↳ ${relative(r.suite.dir, f.file)}: ${f.lines.toFixed(1)}% lines (${f.totalLines}L), ${f.branches.toFixed(1)}% branch`)
        }
      }
    }
    const pct = (c, t) => (t === 0 ? "100.0%" : `${((c / t) * 100).toFixed(1)}%`)
    console.log(
      `TOTAL | ${pct(covStmts, totStmts)} (${covStmts}/${totStmts}) | ` +
        `${pct(covBranches, totBranches)} (${covBranches}/${totBranches}) | ` +
        `${pct(covFuncs, totFuncs)} (${covFuncs}/${totFuncs}) | ` +
        `${pct(covLines, totLines)} (${covLines}/${totLines})`
    )
  }

  const failed = results.filter((r) => r.res.code !== 0)
  console.log(`\nTS/Effect fuzz summary: ${results.length - failed.length}/${results.length} packages passed.`)
  return failed.length === 0
}

async function runRustFuzz() {
  console.log("\n=== Rust Deterministic Fuzz Suites ===")
  const detSuites = [
    { name: "flows-jj::fuzz_state_machine", args: ["test", "-p", "flows-jj", "--test", "fuzz_state_machine"] },
    { name: "flows-jj::fuzz_abi_and_ops", args: ["test", "-p", "flows-jj", "--test", "fuzz_abi_and_ops"] },
    { name: "smithers-ffi::fuzz_ffi_and_crdt", args: ["test", "-p", "smithers-ffi", "--test", "fuzz_ffi_and_crdt"] },
    { name: "smithers-ffi::fuzz_targets", args: ["test", "-p", "smithers-ffi", "--test", "fuzz_targets"] },
    { name: "smithers-ffi::atomic_glob", args: ["test", "-p", "smithers-ffi", "--bin", "smithers-jj-export", "fuzz_atomic_glob"] }
  ]
  let allOk = true
  for (const s of detSuites) {
    const res = await execAsync("cargo", s.args, rootDir, process.env)
    console.log(`  [${res.code === 0 ? "PASS" : "FAIL"}] ${s.name} (${res.ms}ms)`)
    if (res.code !== 0) {
      allOk = false
      console.error((res.stdout + "\n" + res.stderr).trim().split("\n").slice(-30).join("\n"))
    }
  }

  if (libfuzzerSeconds > 0) {
    console.log(`\n=== Rust LLVM libFuzzer (cargo-fuzz, ${libfuzzerSeconds}s per target) ===`)
    const targets = [
      { dir: join(rootDir, "packages/smithers/flows/jj-wasm"), target: "abi_json" },
      { dir: join(rootDir, "packages/smithers/flows/jj-wasm"), target: "ops_state_machine" },
      { dir: join(rootDir, "packages/smithers/flows/jj-wasm"), target: "diff_and_status" },
      { dir: join(rootDir, "packages/smithers-ffi"), target: "live_document_decode" },
      { dir: join(rootDir, "packages/smithers-ffi"), target: "wiki_document_ffi" },
      { dir: join(rootDir, "packages/smithers-ffi"), target: "c_abi_repo_ops" }
    ]
    const toolchain = process.env.SMITHERS_RUST_NIGHTLY ?? "+nightly-2026-09-02"
    for (const t of targets) {
      const res = await execAsync(
        "cargo",
        [toolchain, "fuzz", "run", t.target, "--", `-max_total_time=${libfuzzerSeconds}`],
        t.dir,
        process.env
      )
      const combined = res.stdout + "\n" + res.stderr
      const doneLine = combined.split("\n").find((l) => l.includes("Done ") && l.includes(" runs in "))
      console.log(`  [${res.code === 0 ? "PASS" : "FAIL"}] ${relative(rootDir, t.dir)}::${t.target} (${res.ms}ms)${doneLine ? ` — ${doneLine.trim()}` : ""}`)
      if (res.code !== 0) {
        allOk = false
        console.error(combined.trim().split("\n").slice(-35).join("\n"))
      }
    }
  }
  return allOk
}

async function ensureObserveCallsHeader(observeFuzzDir) {
  const genDir = join(observeFuzzDir, ".gen")
  const headerPath = join(genDir, "calls.h")
  if (existsSync(headerPath)) return
  const buildObserveUrl = pathToFileURL(join(rootDir, "packages/smithers/build/build-cli/scripts/build-observe.mjs")).href
  const { callsHeader } = await import(buildObserveUrl)
  mkdirSync(genDir, { recursive: true })
  writeFileSync(headerPath, callsHeader(), "utf8")
}

async function runZigFuzz() {
  const observeFuzzDir = join(rootDir, "packages/smithers/build/build-cli/native/fuzz")
  const ffiFuzzDir = join(rootDir, "packages/smithers-ffi/fuzz")
  const useFuzzMode = zigRuns > 0 && process.platform === "linux"
  console.log(
    useFuzzMode
      ? `\n=== Zig LLVM Coverage-Guided Fuzz Suites (--fuzz=${zigRuns}) ===`
      : "\n=== Zig Native Fuzz Suites ==="
  )

  await ensureObserveCallsHeader(observeFuzzDir)

  const buildLib = await execAsync("cargo", ["build", "-p", "smithers-ffi", "--lib"], rootDir, process.env)
  if (buildLib.code !== 0) {
    console.error("  [FAIL] cargo build -p smithers-ffi --lib")
    console.error((buildLib.stdout + "\n" + buildLib.stderr).trim().split("\n").slice(-25).join("\n"))
    return false
  }

  const zigArgs = useFuzzMode ? ["build", "test", `--fuzz=${zigRuns}`] : ["build", "test", "--summary", "all"]
  const targets = [
    { name: "observe.c (C helpers + keyOf bounds)", dir: observeFuzzDir },
    { name: "smithers-ffi (live_document C ABI)", dir: ffiFuzzDir }
  ]
  let allOk = true
  for (const t of targets) {
    const res = await execAsync("zig", zigArgs, t.dir, process.env)
    const combined = res.stdout + "\n" + res.stderr
    const runsLine = combined.split("\n").find((l) => l.startsWith("Runs:"))
    console.log(`  [${res.code === 0 ? "PASS" : "FAIL"}] ${t.name} (${res.ms}ms)${runsLine ? ` — ${runsLine.trim()}` : ""}`)
    if (res.code !== 0) {
      allOk = false
      console.error(combined.trim().split("\n").slice(-30).join("\n"))
    }
  }
  return allOk
}

async function main() {
  const suites = discoverSuites()
  if (listOnly) {
    for (const s of suites) {
      console.log(`${s.pkg}: ${s.files.join(", ")}`)
    }
    console.log(`Total: ${suites.length} package(s), ${suites.reduce((a, s) => a + s.files.length, 0)} fuzz test file(s).`)
    return
  }

  let ok = true
  if (!nativeOnly) {
    ok = (await runTsSuites(suites)) && ok
  }
  if (runRust) {
    ok = (await runRustFuzz()) && ok
  }
  if (runZig) {
    ok = (await runZigFuzz()) && ok
  }
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
