#!/usr/bin/env node
// Rebase cache benchmark: does a rebased stack replay every target whose
// inputs did not change? See scripts/bench/README.md ("Rebase cache reuse").
//
// Builds an N-change stack on --base (each change appends a comment to one
// tracked source file of a distinct package), then inserts a change touching
// --insert below the stack and rebases, so every commit id changes. Each
// revision is exported with `git archive` into a fresh directory (no .git, a
// new absolute path, as the coding host's exporter does), installed from the
// frozen lockfile, and planned with `<verb> <pattern> --plan`. A result store
// is replayed in check order: the original stack, then the inserted change and
// the rebased stack.
//
// A target's input signature is its own ambient identity plus every declared
// input file digest in its dependency closure. A cacheable target is a hit
// when its key was stored earlier; a miss is expected when its signature is
// new. An unexpected miss (the key moved while the inputs did not) or an
// unexpected hit (the key stayed while a declared input changed) fails the run.
//
// --execute additionally runs the listed labels for real through
// scripts/ci/check-cache.mjs, the persistence coding checks use, and records
// wall time, the executor's hit/ran status and effective key per label, and
// whether that status matches the prediction from earlier effective keys.
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: process.cwd() },
    base: { type: "string", default: "HEAD" },
    stack: {
      type: "string",
      default: "packages/smithers/agent/memory,packages/smithers/flows/journal,apps/site,packages/smithers/build/targets"
    },
    insert: { type: "string", default: "packages/smithers/notifications" },
    verb: { type: "string", default: "ci" },
    pattern: { type: "string", default: "//..." },
    install: { type: "string", default: "pnpm install --offline --frozen-lockfile --ignore-scripts" },
    execute: { type: "string" },
    "allow-failed": { type: "string", default: "" },
    out: { type: "string" }
  }
})

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 1 << 30, ...options })
const sha = (value) => createHash("sha256").update(value).digest("hex")

if (values.out === undefined) throw new Error("--out <fresh directory> is required")
const out = path.resolve(values.out)
if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`)
fs.mkdirSync(out, { recursive: true })
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "smithers-rebase-cache-"))
const repo = path.join(scratch, "repo")
run("git", ["clone", "--quiet", "--shared", "--no-checkout", path.resolve(values.repo), repo])
const git = (...args) => run("git", ["-C", repo, "-c", "user.name=bench", "-c", "user.email=bench@invalid", ...args]).trim()
const base = git("rev-parse", run("git", ["-C", path.resolve(values.repo), "rev-parse", values.base]).trim())
git("checkout", "--quiet", "--detach", base)

// One deterministic tracked file per package: the first source file by path.
const fileIn = (directory) => {
  const files = git("ls-files", "--", directory).split("\n").filter(Boolean).sort()
  const pick = files.find((file) => /\/src\/.*\.(ts|mjs)$/.test(file)) ?? files.find((file) => /\.(ts|mjs|go)$/.test(file))
  if (pick === undefined) throw new Error(`no source file tracked under ${directory}`)
  return pick
}
const touch = (file, tag) => {
  fs.appendFileSync(path.join(repo, file), `\n// rebase-cache benchmark: ${tag}\n`)
  git("add", "--", file)
  git("commit", "--quiet", "--no-verify", "-m", `bench: touch ${file} (${tag})`)
  return git("rev-parse", "HEAD")
}

const stackPackages = values.stack.split(",").filter(Boolean)
const original = stackPackages.map((directory, index) => {
  const file = fileIn(directory)
  return { name: `change-${index + 1}`, file, commit: touch(file, `change-${index + 1}`) }
})
git("checkout", "--quiet", "--detach", base)
const insertedFile = fileIn(values.insert)
const inserted = { name: "inserted", file: insertedFile, commit: touch(insertedFile, "inserted") }
git("rebase", "--quiet", "--onto", inserted.commit, base, original.at(-1).commit)
const rebasedCommits = git("rev-list", "--reverse", `${inserted.commit}..HEAD`).split("\n")
const rebased = original.map((change, index) => ({ ...change, name: `${change.name}'`, commit: rebasedCommits[index] }))
for (const [index, change] of rebased.entries()) {
  if (change.commit === original[index].commit) throw new Error("rebase kept a commit id")
  if (git("rev-parse", `${change.commit}^{tree}`) === git("rev-parse", `${original[index].commit}^{tree}`)) {
    throw new Error("rebase kept a tree")
  }
}

// Offline and without credentials: plans must not depend on the network.
const environment = { ...process.env, SMITHERS_CACHE_URL: "http://127.0.0.1:9", SMITHERS_CACHE_DISCOVERY: "0" }
for (const name of ["SMITHERS_CACHE_TOKEN", "SMITHERS_CACHE_READ_TOKEN", "SMITHERS_CACHE_WRITE_TOKEN"]) delete environment[name]
const checkCache = path.join(scratch, "check-cache")

const exportRevision = (change, index) => {
  const root = path.join(scratch, "exports", `${index}-${change.name.replace(/\W/g, "")}-${sha(change.commit).slice(0, 8)}`)
  fs.mkdirSync(root, { recursive: true })
  run("sh", ["-c", 'set -e; git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo, change.commit, root])
  const [command, ...args] = values.install.split(" ")
  run(command, args, { cwd: root, env: environment, stdio: ["ignore", "ignore", "inherit"] })
  return root
}

const planOf = (root) => {
  const started = performance.now()
  const stdout = run(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js", values.verb, values.pattern, "--plan", "--format", "json"
  ], { cwd: root, env: environment, stdio: ["ignore", "pipe", "ignore"] })
  const plan = JSON.parse(stdout)
  // The input oracle needs the full planned node; a verb whose report omits
  // declared inputs would make every signature equal and hide key drift.
  if (!plan.targets.every((target) => Array.isArray(target.declaredInputs) && target.keyMaterial !== undefined)) {
    throw new Error(`${values.verb} --plan does not report declared inputs and key material; use --verb ci`)
  }
  const byLabel = new Map(plan.targets.map((target) => [target.label, target]))
  const closure = new Map()
  const filesOf = (label) => {
    const known = closure.get(label)
    if (known !== undefined) return known
    const target = byLabel.get(label)
    const files = new Map()
    closure.set(label, files)
    for (const input of target?.declaredInputs ?? []) {
      for (const file of input.files ?? []) files.set(file.path, file.digest)
    }
    for (const dependency of target?.dependencies ?? []) {
      for (const [file, digest] of filesOf(dependency)) files.set(file, digest)
    }
    return files
  }
  const targets = plan.targets.map((target) => {
    const files = filesOf(target.label)
    const ambient = target.keyMaterial?.inputs?.ambient ?? null
    return {
      label: target.label,
      rule: target.target ?? target.rule,
      key: target.keyPreview ?? target.key,
      cacheable: target.cacheable,
      files,
      signature: sha(JSON.stringify([target.label, ambient, [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]))
    }
  })
  return { roots: new Set(plan.roots), targets, planMs: Math.round(performance.now() - started) }
}

const remember = (map, label, value) => {
  if (!map.has(label)) map.set(label, new Set())
  map.get(label).add(value)
}
const executeLabels = values.execute?.split(",").filter(Boolean) ?? []
const executedKeys = new Map()
const executeRevision = (root) => {
  if (executeLabels.length === 0) return undefined
  const cacheEnvironment = { ...environment, SMITHERS_CHECK_CACHE_DIR: checkCache }
  const script = path.join(root, "scripts/ci/check-cache.mjs")
  const cacheStep = (command) => run(process.execPath, [script, command, root], {
    env: cacheEnvironment, stdio: ["ignore", "ignore", "pipe"]
  })
  cacheStep("seed")
  // One process per label, as each coding check is one command.
  const results = executeLabels.map((label) => {
    const started = performance.now()
    const result = spawnSync(process.execPath, [
      "packages/smithers/build/build-cli/src/main.js", "ci", label, "--format", "json"
    ], { cwd: root, env: environment, encoding: "utf8", maxBuffer: 1 << 30 })
    const wallMs = Math.round(performance.now() - started)
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch {
      throw new Error(`${label} produced no JSON report (exit ${result.status}): ${result.stderr.slice(-2000)}`)
    }
    const row = report.results?.find((entry) => entry.label === label)
    if (row === undefined) return { label, status: "failed", exitCode: result.status, wallMs, message: report.message }
    const predicted = executedKeys.get(label)?.has(row.key) === true ? "hit" : "ran"
    for (const entry of report.results) {
      if (entry.status === "hit" || entry.status === "ran") remember(executedKeys, entry.label, entry.key)
    }
    return { label, status: row.status, predicted, key: row.key, exitCode: result.status, wallMs, counts: report.counts }
  })
  cacheStep("save")
  return {
    wallMs: results.reduce((sum, row) => sum + row.wallMs, 0),
    results,
    mismatches: results.filter((row) => (row.status === "hit" || row.status === "ran") && row.status !== row.predicted)
      .map((row) => row.label)
  }
}

const storedKeys = new Map()
const storedSignatures = new Map()
const order = [
  ...original.map((change) => ({ ...change, phase: "original" })),
  { ...inserted, phase: "rebased" },
  ...rebased.map((change) => ({ ...change, phase: "rebased" }))
]
const revisions = []
for (const [index, change] of order.entries()) {
  const root = exportRevision(change, index)
  const plan = planOf(root)
  const execution = executeRevision(root)
  const rows = { hit: 0, expectedMiss: 0, unexpectedMiss: 0, unexpectedHit: 0, uncacheableRuns: 0, uncacheableUnchanged: 0 }
  const rootRows = { ...rows }
  const unexpected = []
  const missed = []
  for (const target of plan.targets) {
    const seenKey = storedKeys.get(target.label)?.has(target.key) === true
    const seenSignature = storedSignatures.get(target.label)?.has(target.signature) === true
    const counters = [rows, ...(plan.roots.has(target.label) ? [rootRows] : [])]
    const bump = (field) => counters.forEach((counter) => counter[field]++)
    if (!target.cacheable) {
      bump("uncacheableRuns")
      if (seenKey) bump("uncacheableUnchanged")
    } else if (seenKey) {
      bump("hit")
      if (!seenSignature) {
        bump("unexpectedHit")
        unexpected.push(`${target.label} (hit)`)
      }
    } else if (seenSignature) {
      bump("unexpectedMiss")
      unexpected.push(target.label)
    } else {
      bump("expectedMiss")
      if (plan.roots.has(target.label)) missed.push(target.label)
    }
    remember(storedKeys, target.label, target.key)
    remember(storedSignatures, target.label, target.signature)
  }
  const dependsOnInserted = plan.targets.filter((target) => plan.roots.has(target.label) && target.files.has(insertedFile)).length
  revisions.push({
    name: change.name, phase: change.phase, commit: change.commit, touched: change.file,
    targets: plan.targets.length, roots: plan.roots.size, planMs: plan.planMs,
    all: rows, rootsOnly: rootRows, rootsDependingOnInserted: dependsOnInserted,
    missedRoots: missed.sort(), unexpectedMisses: unexpected.sort(), execution
  })
  fs.rmSync(root, { recursive: true, force: true })
  process.stderr.write(`${change.name}: ${JSON.stringify(rootRows)}` + (execution === undefined ? "" :
    ` exec ${execution.wallMs}ms ${execution.results.map((row) => `${row.label}=${row.status}`).join(" ")}`) + "\n")
}

const result = {
  method: "scripts/bench/rebase-cache.mjs",
  repository: path.resolve(values.repo), base, verb: values.verb, pattern: values.pattern,
  stack: original.map(({ file }) => file), inserted: insertedFile,
  host: { node: process.version, platform: `${process.platform}-${process.arch}` },
  revisions
}
fs.writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
fs.rmSync(scratch, { recursive: true, force: true })
const allowedFailures = new Set(values["allow-failed"].split(",").filter(Boolean))
const failures = revisions.flatMap((revision) => [
  ...(revision.execution?.results ?? []).filter((row) => row.status !== "hit" && row.status !== "ran" &&
    !allowedFailures.has(row.label)).map((row) => `${revision.name} ${row.label} ${row.status}`),
  ...revision.unexpectedMisses.map((label) => `${revision.name} ${label}`),
  ...(revision.execution?.mismatches ?? []).map((label) => `${revision.name} ${label} (executor disagreed with its keys)`)
])
if (failures.length > 0) {
  process.stderr.write(`key or admission anomalies:\n${failures.join("\n")}\n`)
  process.exitCode = 1
}
