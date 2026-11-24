#!/usr/bin/env node
// Replays a repository we do not trust inside a Cloudflare box, and brings back only text.
//
//   node packages/ci/scripts/box-replay.mjs <repository URL> <commit> --packs <dir> [--commits 4] [--cpu 4]
//     [--out <dir>] [--job-id <id>] [--job <CI job id>]... [--dry-run] [-- <replay flags>]
//
// <dir> holds the release tarballs `node .smithers/flows/release/pack-release.mjs <dir> --built` wrote, and nothing
// else goes into the box: the box installs them with npm, clones the repository from its URL at <commit> itself,
// runs `smithers-ci replay --commits <n> --json` as a user without privileges, under bubblewrap, and returns its
// results. Of what it returns, only the files named in `kept` are taken, and only as plain files: the repository's
// code, its dependencies and what it builds never leave the box. `cfbox` (or the program `CFBOX` names) starts the
// box; nothing of this machine's environment reaches it, and it uses no cache. `--dry-run` prints the cfbox command
// and starts nothing. With `--job`, given once for each CI job, each job is replayed alone (the replay's `--job`) in
// a box of its own, four boxes at once at most, its results in <out>/<n>; a table of the jobs follows.
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The result files a box may return, the only ones taken from it. */
export const kept = [
  "box.txt",
  "setup.log",
  "install.log",
  "clone.log",
  "replay.json",
  "replay.log",
  "report.html.txt",
  "exit",
  "wall-seconds",
  "NOT-REPRODUCED.txt"
]

/** The most bytes one result file may hold: 1 GiB. A box that returns more of one has filled it for no reader. */
export const largest = 2 ** 30

/** Flags of cfbox that carry something of this machine, or of another job, into the box. */
const carriers = {
  "--env": "it sets a variable of this machine in the box",
  "--env-pass": "it passes a variable of this machine, a credential among them, into the box",
  "--cache": "it restores files another job saved, and saves the box's for others",
  "--cache-key": "a cache key is shared with every job that names it",
  "--with-deps": "it uploads dependencies installed on this machine",
  "--add": "it uploads files of this machine",
  "--via": "it sends the upload through another machine"
}

/** Replay flags the box sets itself, or that reach outside it. */
const fixed = {
  "--commits": "give it as this script's --commits",
  "--job": "give it as this script's --job, which gives each job a box of its own",
  "--json": "the box always asks for JSON",
  "--out": "the box writes the report itself",
  "--cache": "a shared cache gives the repository's steps a token and other repositories' results"
}

/** A command line this script will not run, with why. */
export class Refusal extends Error {}

/** The options of one run, from the command line, or a refusal. */
export const parse = (argv) => {
  const split = argv.indexOf("--")
  const own = split === -1 ? argv : argv.slice(0, split)
  const replayFlags = split === -1 ? [] : argv.slice(split + 1)
  const positional = []
  const options = { commits: "4", cpu: "4", dryRun: false, jobs: [] }
  for (let index = 0; index < own.length; index++) {
    const word = own[index]
    if (Object.hasOwn(carriers, word)) throw new Refusal(`${word} is refused: ${carriers[word]}`)
    if (word === "--dry-run") options.dryRun = true
    else if (word === "--job") {
      const value = own[++index]
      if (value === undefined || value.startsWith("--")) throw new Refusal("--job needs a CI job's id")
      options.jobs.push(value)
    } else if (["--packs", "--commits", "--cpu", "--out", "--job-id"].includes(word)) {
      const value = own[++index]
      if (value === undefined || value.startsWith("--")) throw new Refusal(`${word} needs a value`)
      options[word.slice(2).replace(/-(\w)/, (_, letter) => letter.toUpperCase())] = value
    } else if (word.startsWith("-")) throw new Refusal(`unknown flag ${word}`)
    else positional.push(word)
  }
  if (positional.length !== 2) throw new Refusal("give a repository URL and a commit")
  const [repository, commit] = positional
  for (const flag of replayFlags) {
    const name = flag.split("=")[0]
    if (Object.hasOwn(fixed, name)) throw new Refusal(`replay flag ${name} is refused: ${fixed[name]}`)
  }
  if (options.packs === undefined) throw new Refusal("--packs names the directory of release tarballs")
  if (!/^\d+$/.test(options.commits) || Number(options.commits) < 1) throw new Refusal("--commits is a whole number")
  if (!["1", "2", "4"].includes(options.cpu)) throw new Refusal("--cpu is 1, 2 or 4")
  if (options.jobId !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(options.jobId)) {
    throw new Refusal("--job-id is letters, digits and dashes (8 to 64 characters)")
  }
  return { ...options, url: repositoryUrl(repository), commit: commitId(commit), replayFlags }
}

/** The repository's URL: an https URL with no user or password, never a path on this machine. */
const repositoryUrl = (text) => {
  const local = `the repository is a path on this machine: the box clones the repository itself, from its https URL, ` +
    "so nothing of it is read or copied here"
  if (text.startsWith("file:") || isAbsolute(text) || text.startsWith(".") || text.startsWith("~")) {
    throw new Refusal(local)
  }
  if (existsSync(text)) throw new Refusal(local)
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Refusal(`the repository is not a URL: give the repository's https URL`)
  }
  if (url.protocol !== "https:") throw new Refusal(`the repository is not an https URL: the box has no key for ssh or git`)
  if (url.username !== "" || url.password !== "") {
    throw new Refusal("the URL names a user or a password: the box clones public repositories without one")
  }
  if (url.search || url.hash) throw new Refusal("the repository URL must have no query or fragment")
  return url.href
}

/** A commit id: 7 to 40 hexadecimal digits. */
const commitId = (text) => {
  if (!/^[0-9a-f]{7,40}$/i.test(text)) throw new Refusal(`${text} is not a commit id`)
  return text.toLowerCase()
}

/** A pathname inspected for upload must still name the descriptor we opened. */
export const verifyIdentity = (path, opened, named) => {
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Refusal(`${path} changed during open`)
}

/** Read a pack only through a verified regular-file descriptor. */
const regular = (path, use) => {
  const named = lstatSync(path, { bigint: true })
  if (!named.isFile()) throw new Refusal(`${path} is not a regular file`)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd, { bigint: true })
    verifyIdentity(path, info, named)
    return use(fd)
  } finally {
    closeSync(fd)
  }
}

/** The tarballs of `packs`, as its manifest lists them; any other file there is refused. */
export const tarballs = (packs, destination, platform = process.platform) => {
  const named = lstatSync(packs, { bigint: true })
  if (!named.isDirectory()) throw new Refusal("packs must be a directory")
  const directory = openSync(packs, constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(directory, { bigint: true })
    const path = platform === "linux" ? `/proc/self/fd/${directory}` : realpathSync(packs)
    const resolved = statSync(path, { bigint: true })
    verifyIdentity(packs, info, named)
    verifyIdentity(packs, info, resolved)
    return listedPacks(path, destination, platform)
  } finally {
    closeSync(directory)
  }
}

const listedPacks = (packs, destination, platform) => {
  const manifestPath = join(packs, "manifest.json")
  if (!existsSync(manifestPath)) throw new Refusal(`${packs} has no manifest.json: pack it with pack-release.mjs`)
  const manifest = regular(manifestPath, (fd) => readFileSync(fd, "utf8"))
  let entries
  try {
    entries = JSON.parse(manifest)
  } catch {
    throw new Refusal("the release manifest is not valid JSON")
  }
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.filename !== "string")) {
    throw new Refusal("the release manifest must list tarball filenames")
  }
  const listed = entries.map((entry) => entry.filename)
  // A name with a directory in it is a file somewhere else on this machine, which would go into the box as listed.
  const elsewhere = listed.find((name) => typeof name !== "string" || name !== basename(name) || /^\.{0,2}$/.test(name))
  if (elsewhere !== undefined) {
    throw new Refusal(`${packs} lists ${elsewhere}, which is no file of it: only release tarballs go in a box`)
  }
  if (!listed.some((name) => name.startsWith("smithers-ci-"))) throw new Refusal(`${packs} holds no smithers-ci`)
  const allowed = new Set(["manifest.json", "release-manifest.json", ...listed])
  for (const name of readdirSync(packs)) {
    if (!allowed.has(name) || !lstatSync(join(packs, name)).isFile()) {
      throw new Refusal(`${packs} holds ${name}, which its manifest does not list: only release tarballs go in a box`)
    }
  }
  for (const name of listed) {
    if (!existsSync(join(packs, name))) throw new Refusal(`${packs} lacks ${name}, which its manifest lists`)
  }
  const names = [...allowed].filter((name) => existsSync(join(packs, name)))
  if (destination !== undefined) {
    writeFileSync(join(destination, "manifest.json"), manifest, { flag: "wx" })
    for (const name of names.filter((name) => name !== "manifest.json")) {
      regular(join(packs, name), (fd) => copyFileSync(`${platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`, join(destination, name), constants.COPYFILE_EXCL))
    }
  }
  return names
}

/**
 * The cfbox command line for one run: its results go to `output`, and with `job` the replay is asked for that CI job
 * alone.
 */
export const command = (options, upload, jobId, output = join(upload, "..", "result.tgz"), job = undefined) => [
  "run",
  "--cpu",
  options.cpu,
  "--image",
  "node",
  "--job-id",
  jobId,
  "--artifact",
  "out",
  "--output",
  output,
  upload,
  "--",
  "bash",
  "box-replay.sh",
  options.url,
  options.commit,
  options.commits,
  ...options.replayFlags,
  ...(job === undefined ? [] : ["--job", job])
]

/** A word as a POSIX shell reads it. */
export const quote = (word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`

/**
 * Of an artifact's `tar -tvzf` listing, what is taken: plain files named in `kept` (under `out/`), each of at most
 * `largest` bytes and listed once. The rest is dropped with why. A result listed twice is dropped both times: the
 * box wrote each once, so an artifact with two was made to put one file in another's place.
 */
export const sift = (listing) => {
  const listed = []
  const drop = []
  const counts = new Map()
  for (const line of listing.split("\n").filter((line) => line.trim() !== "")) {
    const fields = line.trim().split(/\s+/)
    const bsd = /^\d+$/.test(fields[1] ?? "") && /^[A-Z][a-z]{2}$/.test(fields[5] ?? "")
    const path = fields.slice(bsd ? 8 : 5).join(" ")
    const size = fields[bsd ? 4 : 2] ?? ""
    const bytes = /^\d+$/.test(size) ? Number(size) : Number.NaN
    const name = path.replace(/^\.\//, "").replace(/^out\//, "")
    if (name === "" || name === "out" || name === "out/") continue
    if (!line.startsWith("-")) drop.push({ path, why: "not a plain file" })
    else if (!kept.includes(name)) drop.push({ path, why: "not a named result" })
    else if (!(bytes <= largest)) drop.push({ path, why: "larger than a result is" })
    else {
      listed.push({ path, name, bytes })
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const once = (entry) => counts.get(entry.name) === 1
  return {
    keep: listed.filter(once),
    drop: [
      ...drop,
      ...listed.filter((entry) => !once(entry)).map((entry) => ({ path: entry.path, why: "listed more than once" }))
    ]
  }
}

/** The lines that sum a replay's JSON up. */
export const summary = (report, cpu) => {
  const seconds = (ms) => `${Math.round(ms / 1000)} s`
  const lines = [
    `box: ${cpu} vCPU`,
    `jobs replayed: ${report.jobs === undefined ? "-" : `${report.jobs.replayed} of ${report.jobs.total}`}`,
    `mismatches: ${report.mismatches}`,
    `speedup: ${report.speedup} (baseline ${seconds(report.baselineWallMs)}, normal ${seconds(report.normalWallMs)})`
  ]
  if (report.recorder !== undefined) {
    lines.push(`recorder: ${report.recorder.name}${report.recorder.why === undefined ? "" : ` (${report.recorder.why})`}`)
  }
  for (const commit of report.commits) {
    const counts = commit.normal.counts
    const steps = counts.hit + counts.ran + counts.failed + counts.skipped
    lines.push(
      `${commit.commit}: ${commit.changedFiles} files, baseline ${seconds(commit.baseline.wallMs)}, normal ` +
        `${seconds(commit.normal.wallMs)}, reused ${counts.hit} of ${steps}, ${commit.mismatches.length} mismatches`
    )
  }
  if (report.stopped !== undefined) lines.push(`stopped: ${report.stopped}`)
  return lines
}

const MiB = 1024 * 1024
const artifactLimits = {
  "exit": 4096,
  "wall-seconds": 4096,
  "box.txt": MiB,
  "replay.json": 32 * MiB,
  "report.html.txt": 32 * MiB,
  "NOT-REPRODUCED.txt": 4 * MiB
}

/** Reserve space for the receipts and reports before admitting any optional log. */
export const withinBudget = (entries) => {
  let remaining = 256 * MiB
  const results = entries.filter((entry) => !entry.name.endsWith(".log"))
  for (const entry of results) {
    if (entry.bytes > artifactLimits[entry.name]) {
      throw new Error(`artifact exceeds the collection size limit at ${entry.name}`)
    }
    remaining -= entry.bytes
  }
  for (const entry of entries.filter((entry) => entry.name.endsWith(".log"))) {
    if (entry.bytes > Math.min(remaining, 64 * MiB)) {
      console.error(`box-replay: left in the artifact: ${entry.name} (collection size limit)`)
      continue
    }
    remaining -= entry.bytes
    results.push(entry)
  }
  return results
}

/** What a shell runs to print the bytes of the member `$2` of the artifact `$1`, and no more than `$3` of them. */
const bytesOfMember = "tar -xzOf \"$1\" -- \"$2\" | head -c \"$3\""

/**
 * Takes the kept files out of the artifact into `out`, and deletes the artifact; what it took.
 *
 * tar extracts every member that has a name it is given, and every member under it: an artifact that holds a plain
 * `out/replay.log` and then a link `out/replay.log` to a file of this machine lists a plain file and leaves the
 * link, and one that holds a directory of that name leaves the directory and what is in it. So tar creates nothing
 * here. It prints the bytes of a name (`-O`), this script writes them to a new file, and the file is kept only when
 * it holds the bytes the listing gave for one plain file: a link prints nothing, and a second member prints more.
 * No more is ever written than the listing gave, and one byte.
 */
export const unpack = (artifact, out) => {
  try {
    const listing = spawnSync("tar", ["-tvzf", artifact], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
    if (listing.status !== 0) throw new Error(`could not list ${artifact}: ${plain(listing.stderr ?? "")}`)
    const { keep, drop } = sift(listing.stdout)
    // Tar's lookup also matches a rejected member with the same name.
    const ambiguous = new Set()
    for (const { path } of drop) {
      const member = path.replace(/^\.\//, "").replace(/^out\//, "")
      for (const name of kept) {
        if (member === name || member === name + "/" || member.startsWith(name + " -> ") || member.startsWith(name + " link to ")) {
          ambiguous.add(name)
        }
      }
    }
    for (const entry of drop) console.error(plain(`box-replay: left in the artifact: ${entry.path} (${entry.why})`))
    const eligible = withinBudget(keep.filter((entry) => {
      if (!ambiguous.has(entry.name)) return true
      console.error(`box-replay: left in the artifact: ${entry.name} (listed more than once)`)
      return false
    }))
    const taken = eligible.filter((entry) => {
      const file = join(out, entry.name)
      // A new file: nothing that is there is written over, or written through.
      const to = openSync(file, "wx")
      let result
      try {
        result = spawnSync("/bin/bash", ["-o", "pipefail", "-c", bytesOfMember, "sh", artifact, entry.path, String(entry.bytes + 1)], {
          stdio: ["ignore", to, "ignore"]
        })
      } finally {
        closeSync(to)
      }
      if (result.status === 0 && statSync(file).size === entry.bytes) return true
      rmSync(file)
      console.error(
        `box-replay: left in the artifact: ${entry.path} (not the one plain file of ${entry.bytes} bytes it is listed as)`
      )
      return false
    })
    return taken
  } finally {
    rmSync(artifact, { force: true })
  }
}

/** A terminal text filter for one stream, including control strings split between chunks. */
const terminalFilter = () => {
  let state = "text"
  let length = 0
  return (chunk) => {
    let text = ""
    for (const ch of chunk) {
      if (state === "string" || state === "stringEscape") {
        length++
        if (ch === "\n" || length >= 4096) {
          state = "text"
          length = 0
          if (ch === "\n") text += ch
        } else if (ch === "\x07" || ch === "\x9c" || (state === "stringEscape" && ch === "\\")) state = "text"
        else state = ch === "\x1b" ? "stringEscape" : "string"
      } else if (state === "escape") {
        length = 0
        state = ch === "[" ? "csi" : "]PX^_".includes(ch) ? "string" : "text"
      } else if (state === "csi") {
        if (ch >= "@" && ch <= "~") state = "text"
      } else if (ch === "\x1b") state = "escape"
      else if (ch === "\x9b") state = "csi"
      else if ("\x90\x98\x9d\x9e\x9f".includes(ch)) {
        state = "string"
        length = 0
      } else if (ch === "\n" || ch === "\t" || (ch >= " " && !(ch >= "\x7f" && ch <= "\x9f"))) text += ch
    }
    return text.replace(/\p{Cf}/gu, "")
  }
}

const plain = (text) => terminalFilter()(text)

/** Runs cfbox with these arguments, its output to the console and to `log`. */
export const cfbox = async (args, log, signal, timeout = 0, logLimit = 64 * MiB) => {
  const fd = log === undefined ? undefined : openSync(log, "wx")
  try {
    const child = spawn(process.env.CFBOX ?? "cfbox", args, {
      signal,
      timeout,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CFBOX_OWNER: process.env.CFBOX_OWNER ?? "box-replay" }
    })
    let startError
    child.once("error", (error) => { startError = error })
    const closed = new Promise((resolve) => child.once("close", resolve))
    // Reserve the marker inside the shared byte limit. A negative balance means it was written.
    const truncated = "\n[box-replay: box.log truncated]\n"
    let remaining = logLimit - Buffer.byteLength(truncated)
    const persist = (text) => {
      if (fd === undefined || remaining < 0) return
      const bytes = Buffer.from(text)
      writeFileSync(fd, bytes.subarray(0, remaining))
      remaining -= bytes.length
      if (remaining < 0) writeFileSync(fd, truncated)
    }
    const relay = async (from, to) => {
      const filter = terminalFilter()
      for await (const chunk of from.setEncoding("utf8")) {
        const text = filter(chunk)
        persist(text)
        if (!to.write(text)) await once(to, "drain")
      }
    }
    try {
      await Promise.all([relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)])
    } catch (error) {
      child.kill("SIGKILL")
      await closed
      throw error
    }
    const code = await closed
    if (startError === undefined) return { code: code ?? 255 }
    persist(plain(`box-replay: could not start cfbox: ${startError.message}\n`))
    return { code: 125 }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Runs `tasks` with at most `limit` of them under way at once; their results, in their order. */
export const pool = async (tasks, limit) => {
  const results = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }
  const completed = await Promise.allSettled(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  const failed = completed.find((result) => result.status === "rejected")
  if (failed !== undefined) throw failed.reason
  return results
}

/** The replay's report a run brought back into `out`, or nothing when it brought none. */
export const reportIn = (out) => {
  try {
    const file = join(out, "replay.json")
    if (statSync(file).size > artifactLimits["replay.json"]) return undefined
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0
const elapsed = (value) => Number.isFinite(value) && value >= 0
const named = (value) => typeof value === "string" && value.length > 0
const totals = (run) =>
  typeof run.ok === "boolean" && [run.wallMs, run.workMs].every(elapsed) &&
  ["hit", "ran", "failed", "skipped"].every((key) => count(run.counts[key]))

/** The version-one report fields used for a collection receipt, its summary and its job table. */
const reportShape = (report) =>
  report.version === 1 && named(report.repository) &&
  [report.baselineWallMs, report.normalWallMs, report.speedup].every(elapsed) &&
  count(report.mismatches) && (report.speedupCommits === undefined || count(report.speedupCommits)) &&
  (report.stopped === undefined || named(report.stopped)) &&
  (report.jobs === undefined || [report.jobs.replayed, report.jobs.total].every(count)) &&
  (report.recorder === undefined || (["smthrs-observe", "strace", "none"].includes(report.recorder.name) &&
    (report.recorder.why === undefined || named(report.recorder.why)))) &&
  Array.isArray(report.commits) && report.commits.every((commit) =>
    named(commit.commit) && count(commit.changedFiles) && totals(commit.baseline) && totals(commit.normal) &&
    Array.isArray(commit.mismatches))

/**
 * The numbers the table reads of a job's report, or nothing for a text that is no report: `replay.json` holds what
 * the repository's code made the box write, and one job's must not take the table of the others away.
 */
const figuresOf = (report) => {
  try {
    if (!reportShape(report)) return undefined
    const counts = report.commits.map((commit) => commit.normal.counts)
    return {
      baseline: report.baselineWallMs,
      normal: report.normalWallMs,
      hit: counts.reduce((sum, each) => sum + each.hit, 0),
      steps: counts.reduce((sum, each) => sum + each.hit + each.ran + each.failed + each.skipped, 0),
      mismatches: report.mismatches
    }
  } catch {
    return undefined
  }
}

/**
 * The jobs of a run with a box for each, one line each: the job, its exit code, its baseline and normal-mode
 * seconds over the commits its replay counted, the steps it reused and its mismatches. Under them the seconds added
 * up, named for what they are: no speedup, since each box fills a cache of its own.
 */
export const table = (rows, cpu) => {
  const seconds = (ms) => `${Math.round(ms / 1000)} s`
  const total = { baseline: 0, normal: 0 }
  const cells = [["job", "exit", "baseline", "normal", "reused", "mismatches"]]
  for (const row of rows) {
    const figures = figuresOf(row.report)
    if (figures === undefined) {
      cells.push([row.job, String(row.exit), "-", "-", "-", "-"])
      continue
    }
    total.baseline += figures.baseline
    total.normal += figures.normal
    cells.push([
      row.job,
      String(row.exit),
      seconds(figures.baseline),
      seconds(figures.normal),
      `${figures.hit} of ${figures.steps}`,
      String(figures.mismatches)
    ])
  }
  const widths = cells[0].map((_, column) => Math.max(...cells.map((line) => line[column].length)))
  return [
    ...cells.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()),
    `job seconds, each job alone in a ${cpu} vCPU box: baseline ${seconds(total.baseline)}, normal ${
      seconds(total.normal)
    }`
  ]
}

/** Read the first replay refusal a chunk at a time, retaining only the start of each line. */
const refusalIn = (file) => {
  if (!existsSync(file)) return undefined
  const fd = openSync(file, "r")
  const chunk = Buffer.alloc(64 * 1024)
  const prefix = Buffer.alloc(4096)
  let used = 0
  const reason = () => {
    const text = prefix.toString("utf8", 0, used)
    return text.startsWith("smithers-ci: replay: ") ? text : undefined
  }
  try {
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.length, null)
      if (size === 0) return reason()
      for (let start = 0; start < size;) {
        const next = chunk.subarray(start, size).indexOf(10)
        const end = next < 0 ? size : start + next
        used += chunk.copy(prefix, used, start, Math.min(end, start + prefix.length - used))
        if (next < 0) break
        const found = reason()
        if (found !== undefined) return found
        used = 0
        start = end + 1
      }
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * What a run brought back, in `out`: the named files taken from the artifact, the replay summed up, and the exit
 * status. Transport failures take precedence, and success or mismatch requires a usable report.
 */
const collected = (out, cpu, code, receiveReport) => {
  if (!existsSync(join(out, "result.tgz"))) {
    console.error(`box-replay: the box returned no results (cfbox exit ${code})`)
    return code === 0 ? 4 : code
  }
  const taken = unpack(join(out, "result.tgz"), out)
  console.error(`box-replay: took ${taken.map((entry) => `${entry.name} (${entry.bytes} bytes)`).join(", ")}`)
  let status = code
  if (status === 0) {
    const receipt = taken.find((entry) => entry.name === "exit")
    const wrote = receipt && receipt.bytes <= 16 ? readFileSync(join(out, "exit"), "utf8").trim() : ""
    if (!/^\d{1,3}$/.test(wrote) || Number(wrote) > 255) {
      console.error("box-replay: missing or invalid exit receipt")
      return 4
    }
    status = Number(wrote)
  }
  const report = reportIn(out)
  const valid = figuresOf(report) !== undefined
  const replay = join(out, "replay.json")
  if (valid) {
    for (const line of summary(report, cpu)) console.log(plain(line))
    receiveReport?.(report)
  } else if (existsSync(replay) && statSync(replay).size > 0) {
    console.error("box-replay: replay.json is not a report")
  } else {
    const said = refusalIn(join(out, "replay.log"))
    console.error(plain(`box-replay: the replay printed no report${said === undefined ? "" : `; it said: ${said}`}`))
  }
  return code || (status < 2 && !valid ? 4 : status)
}

/** A collection fault preserves a failed transport's exit code. */
export const collect = (out, cpu, code, receiveReport) => {
  try {
    return collected(out, cpu, code, receiveReport)
  } catch (error) {
    console.error(plain(`box-replay: could not collect the artifact: ${error.message}`))
    return code || 4
  }
}

/** The whole run for a command line; its exit code. */
const run = async (argv) => {
  const options = parse(argv)
  tarballs(resolve(options.packs))
  const out = resolve(options.out ?? `box-replay-${options.commit}`)
  const upload = join(out, "upload")
  const jobId = options.jobId ?? `box-replay-${options.commit.slice(0, 12)}-${Date.now()}`
  // One box, or one for each job asked for: its own job id and results folder.
  const boxes = options.jobs.length === 0
    ? [{ out, id: jobId, args: command(options, upload, jobId) }]
    : options.jobs.map((job, index) => {
      const each = join(out, String(index + 1))
      const suffix = `-${index + 1}`
      const id = jobId.slice(0, 64 - suffix.length) + suffix
      return { job, out: each, id, args: command(options, upload, id, join(each, "result.tgz"), job) }
    })
  if (options.dryRun) {
    for (const box of boxes) console.log(plain([process.env.CFBOX ?? "cfbox", ...box.args].map(quote).join(" ")))
    return 0
  }
  if (existsSync(out) && readdirSync(out).length > 0) {
    console.error(plain(`box-replay: ${out} is not empty`))
    return 2
  }
  mkdirSync(join(upload, "packs"), { recursive: true })
  const controller = new AbortController()
  const interrupt = (signal) => controller.abort(signal)
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  let runs
  try {
    copyFileSync(fileURLToPath(new URL("box-replay.sh", import.meta.url)), join(upload, "box-replay.sh"))
    tarballs(resolve(options.packs), join(upload, "packs"))
    runs = await pool(
      boxes.map((box) => async () => {
        if (controller.signal.aborted) return { code: 130 }
        mkdirSync(box.out, { recursive: true })
        let run
        let stop
        try {
          run = await cfbox(box.args, join(box.out, "box.log"), controller.signal)
        } finally {
          stop = await cfbox(["stop", box.id], undefined, undefined, 30_000)
          if (stop.code !== 0) console.error(plain(`box-replay: could not stop ${box.id} (cfbox exit ${stop.code})`))
        }
        return { code: run.code || stop.code }
      }),
      4
    )
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    rmSync(upload, { recursive: true, force: true })
  }
  if (controller.signal.aborted) return controller.signal.reason === "SIGTERM" ? 143 : 130
  if (options.jobs.length === 0) return collect(out, options.cpu, runs[0].code)
  const rows = boxes.map((box, index) => {
    console.log(plain(`${box.job}:`))
    let report
    const exit = collect(box.out, options.cpu, runs[index].code, (value) => { report = value })
    return { job: box.job, exit, report }
  })
  const lines = table(rows, options.cpu).map(plain)
  writeFileSync(join(out, "jobs.txt"), `${lines.join("\n")}\n`)
  for (const line of lines) console.log(line)
  return Math.max(...rows.map((row) => row.exit))
}

/** Exit codes distinguish invalid input from a host or collection failure. */
export const main = async (argv) => {
  try {
    return await run(argv)
  } catch (error) {
    console.error(plain(`box-replay: ${error.message}`))
    return error instanceof Refusal ? 2 : 4
  }
}

const entry = process.argv[1]
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
