#!/usr/bin/env node
// A first run of `smithers-ci` on six ordinary public repositories, as a table: the repository, the exit code,
// the commits replayed, the CI jobs replayed, and the CI jobs not replayed by reason.
//
//   node packages/ci/scripts/corpus.mjs <directory> [--commits 2] [--only <name>,<name>]
//
// Each repository is cloned into <directory>/<name> at the commit named below, with the history before it, unless
// that directory is already there. Then `smithers-ci --commits <n> --json` runs in it. What each run printed is
// kept in <directory>/out. Clone into a directory outside any repository.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import "vibelang/register"
const { ciJobs, expand, hostOf } = await import("../src/contract/Inventory.vibe")

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

/** A clone with the named commit checked out and commits before it. */
const clone = (name, url, commit) => {
  const root = join(directory, name)
  if (existsSync(join(root, ".git"))) {
    const head = git(root, "rev-parse", "--verify", "HEAD")
    const remote = git(root, "remote", "get-url", "origin")
    if (head.status === 0 && head.stdout.trim().startsWith(commit) && remote.stdout.trim() === url) return root
    throw new Error(`${name}: existing checkout does not match the pinned repository and commit`)
  }
  const stage = mkdtempSync(join(directory, `.${name}-`))
  try {
    if (git(stage, "init", "--quiet").status !== 0 || git(stage, "remote", "add", "origin", url).status !== 0) {
      throw new Error(`${name}: could not initialize checkout`)
    }
    for (const depth of ["50", "500", "5000"]) {
      if (git(stage, "fetch", "--quiet", "--depth", depth, "origin", "HEAD").status !== 0) {
        throw new Error(`${name}: fetch failed`)
      }
      if (git(stage, "cat-file", "-e", `${commit}^{commit}`).status === 0) break
    }
    if (git(stage, "checkout", "--quiet", "--detach", commit).status !== 0) {
      throw new Error(`${name}: ${commit} is not in the last 5000 commits of ${url}`)
    }
    renameSync(stage, root)
    return root
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
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

/** The jobs a refusal lists: one per line, the job, two spaces, its reasons; a missing tool is in parentheses. */
const refused = (stderr) =>
  [...stderr.matchAll(/^ {2}(\S+) {2,}(\S.*)$/gm)].map(([, job, reasons]) => ({
    job,
    features: reasons.replace(/ \([^)]*\)/g, "").split(", "),
    tools: [...reasons.matchAll(/missing-tool \(([^)]*)\)/g)].flatMap((match) => match[1].split(", "))
  }))

/** What a refusal says when it lists no job: its one line, without the program's name. */
const said = (stderr) => /^smithers-ci: \w+: (.*)$/m.exec(stderr)?.[1] ?? "-"

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
      tools: entry.reasons.flatMap((reason) => reason.feature === "missing-tool" ? [reason.detail] : [])
    }))
  // A job with a variant for this system is listed for its other variants and still replayed.
  const runsHere = (id) => {
    const job = jobs.find((candidate) => candidate.id === id)
    if (job === undefined) return false
    const systems = (job.matrix.length === 0 ? [{}] : job.matrix).map((variant) =>
      hostOf(job.runsOn === undefined ? undefined : expand(job.runsOn, variant)) ?? process.platform
    )
    return systems.includes(process.platform)
  }
  const whole = left.filter((entry) =>
    report === undefined || !entry.features.every((feature) => feature === "other-system") || !runsHere(entry.job)
  )
  const replayed = report === undefined ? [] : jobs.filter((job) => !whole.some((entry) => entry.job === job.id))
  const byReason = new Map()
  for (const entry of whole) {
    for (const feature of new Set(entry.features)) byReason.set(feature, (byReason.get(feature) ?? 0) + 1)
  }
  const tools = [...new Set(whole.flatMap((entry) => entry.tools))]
  const partial = left.length - whole.length
  const reasons = [
    ...[...byReason].sort(([a], [b]) => (a < b ? -1 : 1)).map(([feature, count]) =>
      feature === "missing-tool" ? `${feature} ${count} (${tools.join(", ")})` : `${feature} ${count}`
    ),
    ...(partial === 0 ? [] : [`other-system variants of ${partial}`])
  ]
  return [
    `${name}@${commit}`,
    String(replay.status ?? `signal ${replay.signal}`),
    String(report?.commits.length ?? 0),
    `${replayed.length} of ${jobs.length}`,
    // A refusal that lists no job says why in one line.
    reasons.length > 0 ? reasons.join(", ") : report === undefined ? said(replay.stderr ?? "") : "-"
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
