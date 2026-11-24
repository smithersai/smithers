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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isMain } from "../packages/repo-targets/scripts/workspace-root.mjs"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const switches = new Set([
  "--v8",
  "--coverage",
  "--per-file",
  "--include-vibelang",
  "--rust",
  "--zig",
  "--all",
  "--list"
])
const numericMinimums = new Map([
  ["--executions", 1],
  ["--duration", 1],
  ["--seed", -Number.MAX_SAFE_INTEGER],
  ["--concurrency", 1],
  ["--zig-runs", 0],
  ["--libfuzzer-seconds", 0]
])

const optionsOf = (args) => {
  const values = new Map()
  for (let i = 0; i < args.length; i++) {
    const entry = args[i]
    const equals = entry.indexOf("=")
    const flag = equals === -1 ? entry : entry.slice(0, equals)
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    if (switches.has(flag) && equals === -1) {
      values.set(flag, true)
      continue
    }
    if (!numericMinimums.has(flag) && flag !== "--filter") throw new Error(`Unknown option: ${entry}`)
    const value = equals === -1 ? args[++i] : entry.slice(equals + 1)
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (numericMinimums.has(flag)) {
      const number = Number(value)
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < numericMinimums.get(flag)) {
        throw new Error(`${flag} requires a safe integer >= ${numericMinimums.get(flag)}`)
      }
    }
    values.set(flag, value)
  }
  return values
}

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
    if (SKIP_DIRS.has(entry.name) && !(entry.name === "build" && existsSync(join(dir, entry.name, "package.json")))) {
      continue
    }
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

function discoverSuites(filter, includeVibelang) {
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

export const outputLimit = 32 * 1024

/** Keep each diagnostic stream bounded and collect native summaries while it is live. */
export function execAsync(cmd, cmdArgs, cwd, env, timeoutMs = 30 * 60_000) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const group = process.platform !== "win32"
    const child = spawn(cmd, cmdArgs, { cwd, env, detached: group, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false
    const stop = (signal) => {
      if (child.pid === undefined) return
      try {
        if (group) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    let escalation
    const deadline = setTimeout(() => {
      timedOut = true
      stop("SIGTERM")
      escalation = setTimeout(() => stop("SIGKILL"), 2_000)
    }, timeoutMs)
    const summaries = {}
    const capture = (stream) => {
      let tail = Buffer.alloc(0)
      let line = ""
      const record = () => {
        if (line.includes("Done ") && line.includes(" runs in ")) summaries.libfuzzer ??= line
        if (line.startsWith("Runs:")) summaries.zig ??= line
      }
      const append = (chunk) => {
        tail = Buffer.concat([tail, chunk].map((part) => part.subarray(-outputLimit))).subarray(-outputLimit)
        const parts = chunk.toString().split("\n")
        for (const [index, part] of parts.entries()) {
          line = (line + part).slice(-1024)
          if (index < parts.length - 1) {
            record()
            line = ""
          }
        }
      }
      stream.on("data", append)
      return () => {
        record()
        return tail.toString()
      }
    }
    const stdout = capture(child.stdout)
    const stderr = capture(child.stderr)
    let failure = ""
    child.on("error", (error) => {
      failure = error.message
    })
    child.on("close", (code) => {
      clearTimeout(deadline)
      clearTimeout(escalation)
      const diagnostic = timedOut ? `Timed out after ${timeoutMs}ms` : failure
      resolvePromise({
        code: timedOut ? 1 : code ?? 1,
        stdout: stdout(),
        stderr: stderr(),
        diagnostic,
        summaries,
        ms: Date.now() - started
      })
    })
  })
}

const diagnostics = (result, lines) =>
  [result.stdout, result.stderr, result.diagnostic].join("\n").trim().split("\n").slice(-lines).join("\n")

async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await worker(items[idx], idx)
    }
  })
  const exits = await Promise.allSettled(workers)
  const failed = exits.find((exit) => exit.status === "rejected")
  if (failed) throw failed.reason
  return results
}

const metrics = ["statements", "branches", "functions", "lines"]
const validMetric = (metric) =>
  metric !== undefined && metric !== null
  && Number.isSafeInteger(metric.total) && metric.total >= 0
  && Number.isSafeInteger(metric.covered) && metric.covered >= 0 && metric.covered <= metric.total

function readCoverageSummary(covDir) {
  try {
    const { total, ...files } = JSON.parse(readFileSync(join(covDir, "coverage-summary.json"), "utf8"))
    if (!metrics.every((key) => validMetric(total?.[key])) || total.lines.total === 0) return undefined
    const rows = Object.entries(files).map(([file, data]) => {
      if (!validMetric(data?.lines) || !validMetric(data?.branches)) throw new Error("Invalid file coverage")
      return { file, lines: data.lines, branches: data.branches }
    }).sort((a, b) => (a.lines.covered / a.lines.total || 0) - (b.lines.covered / b.lines.total || 0))
    return { total, rows }
  } catch {
    return undefined
  }
}

const coveragePct = ({ total, covered }) => total === 0 ? "n/a" : `${((covered / total) * 100).toFixed(1)}%`
const coverageCell = (metric) => `${coveragePct(metric)} (${metric.covered}/${metric.total})`

async function runTsSuites(suites, { measureCoverage, perFile, executions, duration, seed, v8Guided, concurrency }) {
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
    const pkgJson = JSON.parse(readFileSync(join(suite.dir, "package.json"), "utf8"))
    const hasVitest = Boolean(pkgJson.devDependencies?.vitest || pkgJson.dependencies?.vitest)
    const usesBunTest = suite.pkg === "apps/tui" ||
      (!hasVitest && String(pkgJson.scripts?.test ?? "").startsWith("bun test"))
    const isMvp = suite.pkg === "apps/mvp"
    const isCrossFuzz = suite.pkg === "fuzz"
    const covDir = tmpBase ? join(tmpBase, suite.pkg.replace(/[\\/]/g, "__")) : undefined
    if (covDir) mkdirSync(covDir, { recursive: true })

    let tmpBunfigDir
    try {
      let cmd = "pnpm"
      let cmdArgs
      if (usesBunTest) {
        cmd = "bun"
        const bunfigPath = join(suite.dir, "bunfig.toml")
        if (existsSync(bunfigPath)) {
          const raw = readFileSync(bunfigPath, "utf8")
          const stripped = raw.replace(/^\s*coverage[A-Za-z]*\s*=.*$/gm, "").trimEnd() + "\ncoverage = false\n"
          tmpBunfigDir = covDir === undefined ? mkdtempSync(join(tmpdir(), "smithers-bunfig-")) : undefined
          const tmpBunfig = join(covDir ?? tmpBunfigDir, "bunfig.fuzz.toml")
          writeFileSync(tmpBunfig, stripped)
          cmdArgs = [`--config=${tmpBunfig}`, "test", ...suite.files]
        } else {
          cmdArgs = ["test", ...suite.files]
        }
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
      const cov = covDir && !usesBunTest ? readCoverageSummary(covDir) : undefined
      const missing = measureCoverage && cov === undefined
      const ok = res.code === 0 && !missing
      const covText = missing
        ? " | missing coverage evidence"
        : cov
        ? " | " + metrics.map((key) => `${key}=${coveragePct(cov.total[key])}`).join(" ")
        : ""
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${suite.pkg} (${suite.files.length} file(s), ${res.ms}ms)${covText}`)
      if (res.code !== 0) console.error(`--- failure output for ${suite.pkg} ---\n${diagnostics(res, 35)}\n---`)
      return { suite, ok, cov }
    } finally {
      if (tmpBunfigDir) rmSync(tmpBunfigDir, { recursive: true, force: true })
    }
  }).finally(() => {
    if (tmpBase) rmSync(tmpBase, { recursive: true, force: true })
  })

  const completed = results.filter(Boolean)
  if (completed.length !== suites.length) {
    throw new Error(`Only ${completed.length}/${suites.length} fuzz packages completed`)
  }
  if (measureCoverage) {
    const measured = completed.filter((result) => result.cov)
    console.log(`\n=== Fuzz-Only V8 Coverage Summary (${measured.length}/${completed.length} packages measured) ===`)
    console.log("Package | Stmts | Branch | Funcs | Lines")
    console.log("--- | --- | --- | --- | ---")
    for (const { suite, cov } of completed) {
      console.log(
        `${suite.pkg} | ${
          cov
            ? metrics.map((key) => coverageCell(cov.total[key])).join(" | ")
            : "missing coverage evidence"
        }`
      )
      if (perFile && cov) {
        for (
          const { file, lines, branches } of cov.rows.filter((f) =>
            f.lines.total > 0 && f.lines.covered < f.lines.total * 0.8
          ).slice(0, 5)
        ) {
          console.log(
            `    ↳ ${relative(suite.dir, file)}: ${coverageCell(lines)} lines, ${coverageCell(branches)} branches`
          )
        }
      }
    }
    if (measured.length > 0) {
      const totals = metrics.map((key) =>
        measured.reduce(({ total, covered }, { cov }) => ({
          total: total + cov.total[key].total,
          covered: covered + cov.total[key].covered
        }), { total: 0, covered: 0 })
      )
      console.log(
        `${measured.length === completed.length ? "TOTAL" : "MEASURED TOTAL"} | ${totals.map(coverageCell).join(" | ")}`
      )
    }
  }
  const passed = completed.filter((result) => result.ok).length
  console.log(`\nTS/Effect fuzz summary: ${passed}/${completed.length} packages passed.`)
  return passed === completed.length
}

async function runRustFuzz(libfuzzerSeconds) {
  console.log("\n=== Rust Deterministic Fuzz Suites ===")
  const detSuites = [
    { name: "flows-jj::fuzz_state_machine", args: ["test", "-p", "flows-jj", "--test", "fuzz_state_machine"] },
    { name: "flows-jj::fuzz_abi_and_ops", args: ["test", "-p", "flows-jj", "--test", "fuzz_abi_and_ops"] },
    { name: "smithers-ffi::fuzz_ffi_and_crdt", args: ["test", "-p", "smithers-ffi", "--test", "fuzz_ffi_and_crdt"] },
    { name: "smithers-ffi::fuzz_targets", args: ["test", "-p", "smithers-ffi", "--test", "fuzz_targets"] },
    {
      name: "smithers-ffi::atomic_glob",
      args: ["test", "-p", "smithers-ffi", "--bin", "smithers-jj-export", "fuzz_atomic_glob"]
    }
  ]
  let allOk = true
  for (const s of detSuites) {
    const res = await execAsync("cargo", s.args, rootDir, process.env)
    console.log(`  [${res.code === 0 ? "PASS" : "FAIL"}] ${s.name} (${res.ms}ms)`)
    if (res.code !== 0) {
      allOk = false
      console.error(diagnostics(res, 30))
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
      const doneLine = res.summaries.libfuzzer
      console.log(
        `  [${res.code === 0 ? "PASS" : "FAIL"}] ${relative(rootDir, t.dir)}::${t.target} (${res.ms}ms)${
          doneLine ? ` — ${doneLine.trim()}` : ""
        }`
      )
      if (res.code !== 0) {
        allOk = false
        console.error(diagnostics(res, 35))
      }
    }
  }
  return allOk
}

/**
 * Writes the observer's syscall table to `<observeFuzzDir>/.gen/calls.h` unless
 * the file already holds the current `callsHeader()` output. A header left by an
 * earlier run is replaced, so the Zig suites never fuzz against an old table.
 */
export async function ensureObserveCallsHeader(observeFuzzDir) {
  const genDir = join(observeFuzzDir, ".gen")
  const headerPath = join(genDir, "calls.h")
  const buildObserveUrl =
    pathToFileURL(join(rootDir, "packages/smithers/build/build-cli/scripts/build-observe.mjs")).href
  const { callsHeader } = await import(buildObserveUrl)
  const header = callsHeader()
  if (existsSync(headerPath) && readFileSync(headerPath, "utf8") === header) return
  mkdirSync(genDir, { recursive: true })
  writeFileSync(headerPath, header, "utf8")
}

async function runZigFuzz(zigRuns) {
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
    console.error(diagnostics(buildLib, 25))
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
    const runsLine = res.summaries.zig
    console.log(
      `  [${res.code === 0 ? "PASS" : "FAIL"}] ${t.name} (${res.ms}ms)${runsLine ? ` — ${runsLine.trim()}` : ""}`
    )
    if (res.code !== 0) {
      allOk = false
      console.error(diagnostics(res, 30))
    }
  }
  return allOk
}

async function main(args) {
  const options = optionsOf(args)
  const filter = options.get("--filter")
  const perFile = options.has("--per-file")
  const measureCoverage = perFile || options.has("--coverage")
  const concurrency = Number(options.get("--concurrency") ?? Math.min(8, Math.max(2, Math.floor(cpus().length / 2))))
  const libfuzzerSeconds = Number(options.get("--libfuzzer-seconds") ?? 0)
  const zigRuns = Number(options.get("--zig-runs") ?? 0)
  const runRust = options.has("--rust") || options.has("--all") || options.has("--libfuzzer-seconds")
  const runZig = options.has("--zig") || options.has("--all") || zigRuns > 0
  const nativeOnly = (options.has("--rust") || options.has("--zig")) && !options.has("--all") && !measureCoverage &&
    filter === undefined
  const listOnly = options.has("--list")
  const suites = nativeOnly && !listOnly
    ? []
    : discoverSuites(filter, options.has("--include-vibelang") || filter?.includes("vibelang"))
  if ((!nativeOnly || listOnly) && suites.length === 0) {
    throw new Error(`No fuzz packages selected${filter === undefined ? "" : ` by --filter ${JSON.stringify(filter)}`}`)
  }
  if (listOnly) {
    for (const suite of suites) console.log(`${suite.pkg}: ${suite.files.join(", ")}`)
    console.log(
      `Total: ${suites.length} package(s), ${
        suites.reduce((sum, suite) => sum + suite.files.length, 0)
      } fuzz test file(s).`
    )
    return true
  }

  let ok = true
  if (!nativeOnly) {
    ok = await runTsSuites(suites, {
      measureCoverage,
      perFile,
      concurrency,
      executions: options.get("--executions"),
      duration: options.get("--duration"),
      seed: options.get("--seed"),
      v8Guided: options.has("--v8")
    }) && ok
  }
  if (runRust) ok = await runRustFuzz(libfuzzerSeconds) && ok
  if (runZig) ok = await runZigFuzz(zigRuns) && ok
  return ok
}

if (isMain(import.meta)) {
  try {
    process.exitCode = await main(process.argv.slice(2)) ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
