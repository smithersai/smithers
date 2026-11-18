#!/usr/bin/env node
// A first run of `smithers-ci` on six ordinary public repositories, as a table: the repository, the exit code,
// the commits replayed, the CI jobs replayed, and the CI jobs not replayed by reason.
//
//   node packages/ci/scripts/corpus.mjs <directory> [--commits 2] [--only <name>,<name>]
//
// Each repository is cloned into <directory>/<name> at the commit named below, with five commits of history, unless
// that directory is already there. Then `smithers-ci --commits <n> --json` runs in it. What each run printed is
// kept in <directory>/out. Clone into a directory outside any repository.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ciJobs } from "../src/contract/Inventory.ts"

const repositories = [
  ["ky", "https://github.com/sindresorhus/ky.git", "3541888"],
  ["commander.js", "https://github.com/tj/commander.js.git", "a5a7dc0"],
  ["click", "https://github.com/pallets/click.git", "08b803c"],
  ["fzf", "https://github.com/junegunn/fzf.git", "4499615"],
  ["create-t3-app", "https://github.com/t3-oss/create-t3-app.git", "4709861"],
  ["cobra", "https://github.com/spf13/cobra.git", "adbc881"]
]

const program = fileURLToPath(new URL("../bin/smithers-ci.mjs", import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const directory = args[0] === undefined || args[0].startsWith("--") ? undefined : resolve(args[0])
if (directory === undefined) {
  console.error("usage: node packages/ci/scripts/corpus.mjs <directory> [--commits 2] [--only <name>,<name>]")
  process.exit(2)
}
const commits = flag("--commits", "2")
const only = flag("--only", undefined)?.split(",")
const out = join(directory, "out")
mkdirSync(out, { recursive: true })

const git = (cwd, ...rest) => spawnSync("git", ["-C", cwd, ...rest], { encoding: "utf8" })

/** A clone with the named commit checked out and the five commits before it. */
const clone = (name, url, commit) => {
  const root = join(directory, name)
  if (existsSync(join(root, ".git"))) return root
  mkdirSync(root, { recursive: true })
  git(root, "init", "--quiet")
  git(root, "remote", "add", "origin", url)
  // A short commit id cannot be fetched by name, so the branch is fetched far enough back to hold it.
  for (const depth of ["50", "500", "5000"]) {
    git(root, "fetch", "--quiet", "--depth", depth, "origin", "HEAD")
    if (git(root, "cat-file", "-e", `${commit}^{commit}`).status === 0) break
  }
  const checkout = git(root, "checkout", "--quiet", "--detach", commit)
  if (checkout.status !== 0) throw new Error(`${name}: ${commit} is not in the last 5000 commits of ${url}`)
  return root
}

const run = (root, name, label, ...rest) => {
  const result = spawnSync(process.execPath, [program, ...rest], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60 * 60 * 1000
  })
  writeFileSync(join(out, `${name}.${label}.out`), result.stdout ?? "")
  writeFileSync(join(out, `${name}.${label}.err`), result.stderr ?? "")
  return result
}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The jobs a refusal lists: one per line, the job, two spaces, its reasons. */
const refused = (stderr) =>
  [...stderr.matchAll(/^ {2}(\S+(?: \(.*\))?) {2,}(\S.*)$/gm)].map(([, job, reasons]) => ({
    job,
    features: reasons.split(", ").map((reason) => reason.replace(/[ (:].*$/, ""))
  }))

const rowOf = (name, commit, root) => {
  const inventory = parse(run(root, name, "inventory", "inventory", "--json").stdout)
  const jobs = inventory === undefined ? [] : ciJobs(inventory)
  const replay = run(root, name, "replay", "--commits", commits, "--json")
  const report = replay.status === 0 || replay.status === 1 ? parse(replay.stdout) : undefined
  const left = report === undefined
    ? refused(replay.stderr ?? "")
    : (report.notReplayed ?? []).map((entry) => ({
      job: entry.job,
      features: entry.reasons.map((reason) => reason.feature),
      variants: entry.reasons.filter((reason) => reason.feature === "other-system").length
    }))
  // A job with a variant for another system is listed and still replayed: its other variants ran.
  const variantsOf = (id) => Math.max(1, jobs.find((job) => job.id === id)?.matrix.length ?? 1)
  const whole = left.filter((entry) =>
    report === undefined || !entry.features.every((feature) => feature === "other-system")
    || entry.variants >= variantsOf(entry.job)
  )
  const replayed = report === undefined ? [] : jobs.filter((job) => !whole.some((entry) => entry.job === job.id))
  const byReason = new Map()
  for (const entry of whole) {
    for (const feature of new Set(entry.features)) byReason.set(feature, (byReason.get(feature) ?? 0) + 1)
  }
  const partial = left.length - whole.length
  return [
    `${name}@${commit}`,
    String(replay.status ?? `signal ${replay.signal}`),
    String(report?.commits.length ?? 0),
    `${replayed.length} of ${jobs.length}`,
    [
      ...[...byReason].sort(([a], [b]) => (a < b ? -1 : 1)).map(([feature, count]) => `${feature} ${count}`),
      ...(partial === 0 ? [] : [`other-system variants of ${partial}`])
    ].join(", ") || "-"
  ]
}

const rows = [["repository", "exit", "commits replayed", "jobs replayed", "jobs not replayed, by reason"]]
for (const [name, url, commit] of repositories) {
  if (only !== undefined && !only.includes(name)) continue
  const root = clone(name, url, commit)
  rows.push(rowOf(name, git(root, "rev-parse", "--short=7", "HEAD").stdout.trim(), root))
  console.error(`${name}: exit ${rows.at(-1)[1]}`)
}
const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
const line = (row) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`
console.log([line(rows[0]), line(widths.map((width) => "-".repeat(width))), ...rows.slice(1).map(line)].join("\n"))
