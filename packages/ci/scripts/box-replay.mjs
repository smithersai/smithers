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
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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
  "report.html",
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
  if (options.jobId !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(options.jobId)) {
    throw new Refusal("--job-id is letters, digits and dashes")
  }
  return { ...options, url: repositoryUrl(repository), commit: commitId(commit), replayFlags }
}

/** The repository's URL: an https URL with no user or password, never a path on this machine. */
const repositoryUrl = (text) => {
  const local = `${text} is a path on this machine: the box clones the repository itself, from its https URL, ` +
    "so nothing of it is read or copied here"
  if (text.startsWith("file:") || isAbsolute(text) || text.startsWith(".") || text.startsWith("~")) {
    throw new Refusal(local)
  }
  if (existsSync(text)) throw new Refusal(local)
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Refusal(`${text} is not a URL: give the repository's https URL`)
  }
  if (url.protocol !== "https:") throw new Refusal(`${text} is not an https URL: the box has no key for ssh or git`)
  if (url.username !== "" || url.password !== "") {
    throw new Refusal("the URL names a user or a password: the box clones public repositories without one")
  }
  return url.href
}

/** A commit id: 7 to 40 hexadecimal digits. */
const commitId = (text) => {
  if (!/^[0-9a-f]{7,40}$/i.test(text)) throw new Refusal(`${text} is not a commit id`)
  return text.toLowerCase()
}

/** The tarballs of `packs`, as its manifest lists them; any other file there is refused. */
export const tarballs = (packs) => {
  const manifestPath = join(packs, "manifest.json")
  if (!existsSync(manifestPath)) throw new Refusal(`${packs} has no manifest.json: pack it with pack-release.mjs`)
  const listed = JSON.parse(readFileSync(manifestPath, "utf8")).map((entry) => entry.filename)
  // A name with a directory in it is a file somewhere else on this machine, which would go into the box as listed.
  const elsewhere = listed.find((name) => typeof name !== "string" || name !== basename(name) || /^\.{0,2}$/.test(name))
  if (elsewhere !== undefined) {
    throw new Refusal(`${packs} lists ${elsewhere}, which is no file of it: only release tarballs go in a box`)
  }
  if (!listed.some((name) => name.startsWith("smithers-ci-"))) throw new Refusal(`${packs} holds no smithers-ci`)
  const allowed = new Set(["manifest.json", "release-manifest.json", ...listed])
  for (const name of readdirSync(packs)) {
    if (!allowed.has(name) || !statSync(join(packs, name)).isFile()) {
      throw new Refusal(`${packs} holds ${name}, which its manifest does not list: only release tarballs go in a box`)
    }
  }
  for (const name of listed) {
    if (!existsSync(join(packs, name))) throw new Refusal(`${packs} lacks ${name}, which its manifest lists`)
  }
  return [...allowed].filter((name) => existsSync(join(packs, name)))
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
    else listed.push({ path, name, bytes })
  }
  const once = (entry) => listed.filter((other) => other.name === entry.name).length === 1
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
  const listing = spawnSync("tar", ["-tvzf", artifact], { encoding: "utf8" })
  if (listing.status !== 0) throw new Error(`could not list ${artifact}: ${listing.stderr}`)
  const { keep, drop } = sift(listing.stdout)
  for (const entry of drop) console.error(`box-replay: left in the artifact: ${entry.path} (${entry.why})`)
  const taken = keep.filter((entry) => {
    const file = join(out, entry.name)
    // A new file: nothing that is there is written over, or written through.
    const to = openSync(file, "wx")
    spawnSync("sh", ["-c", bytesOfMember, "sh", artifact, entry.path, String(entry.bytes + 1)], {
      stdio: ["ignore", to, "ignore"]
    })
    closeSync(to)
    if (statSync(file).size === entry.bytes) return true
    rmSync(file)
    console.error(
      `box-replay: left in the artifact: ${entry.path} (not the one plain file of ${entry.bytes} bytes it is listed as)`
    )
    return false
  })
  rmSync(artifact)
  return taken
}

/** Runs cfbox with these arguments, its output to the console and to `log`. */
const cfbox = (args, log) =>
  new Promise((done) => {
    const child = spawn(process.env.CFBOX ?? "cfbox", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CFBOX_OWNER: process.env.CFBOX_OWNER ?? "box-replay" }
    })
    const chunks = []
    child.stdout.on("data", (chunk) => (chunks.push(chunk), process.stdout.write(chunk)))
    child.stderr.on("data", (chunk) => (chunks.push(chunk), process.stderr.write(chunk)))
    // A program that cannot start is cfbox failing before the command ran: 125, as cfbox says it.
    let started = true
    child.on("error", (error) => {
      started = false
      chunks.push(Buffer.from(`box-replay: could not start cfbox: ${error.message}\n`))
    })
    child.on("close", (code) => {
      if (log !== undefined) writeFileSync(log, Buffer.concat(chunks))
      done({ code: started ? code ?? 255 : 125 })
    })
  })

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
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

/** The replay's report a run brought back into `out`, or nothing when it brought none. */
export const reportIn = (out) => {
  try {
    return JSON.parse(readFileSync(join(out, "replay.json"), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The numbers the table reads of a job's report, or nothing for a text that is no report: `replay.json` holds what
 * the repository's code made the box write, and one job's must not take the table of the others away.
 */
const figuresOf = (report) => {
  try {
    const counts = report.commits.map((commit) => commit.normal.counts)
    const figures = {
      baseline: report.baselineWallMs,
      normal: report.normalWallMs,
      hit: counts.reduce((sum, each) => sum + each.hit, 0),
      steps: counts.reduce((sum, each) => sum + each.hit + each.ran + each.failed + each.skipped, 0),
      mismatches: report.mismatches
    }
    return Object.values(figures).every((figure) => typeof figure === "number" && Number.isFinite(figure))
      ? figures
      : undefined
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

/**
 * What a run brought back, in `out`: the named files taken from the artifact, the replay summed up, and the exit
 * code, the replay's own when the box wrote one, else `code` (cfbox's).
 */
export const collect = (out, cpu, code) => {
  if (!existsSync(join(out, "result.tgz"))) {
    console.error(`box-replay: the box returned no results (cfbox exit ${code})`)
    return code === 0 ? 4 : code
  }
  const taken = unpack(join(out, "result.tgz"), out)
  console.error(`box-replay: took ${taken.map((entry) => `${entry.name} (${entry.bytes} bytes)`).join(", ")}`)
  const replay = join(out, "replay.json")
  const text = existsSync(replay) ? readFileSync(replay, "utf8") : ""
  if (text.trim() === "") {
    // A replay that refuses prints no report: its reason is its line on standard error.
    const log = join(out, "replay.log")
    const said = existsSync(log)
      ? readFileSync(log, "utf8").split("\n").find((line) => line.startsWith("smithers-ci: replay: "))
      : undefined
    console.error(`box-replay: the replay printed no report${said === undefined ? "" : `; it said: ${said}`}`)
  } else {
    try {
      for (const line of summary(JSON.parse(text), cpu)) console.log(line)
    } catch (error) {
      console.error(`box-replay: replay.json is not a report: ${error.message}`)
    }
  }
  // What a program exits with is 0 to 255. A file that holds anything else, or nothing, as one the box was stopped
  // while writing does, says no exit code: read as a number, nothing is 0, and the run would have passed.
  const exit = join(out, "exit")
  const wrote = existsSync(exit) ? readFileSync(exit, "utf8").trim() : ""
  return /^\d{1,3}$/.test(wrote) && Number(wrote) <= 255 ? Number(wrote) : code
}

/** The whole run for a command line; its exit code. */
export const main = async (argv) => {
  let options
  let names
  try {
    options = parse(argv)
    names = tarballs(resolve(options.packs))
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    console.error(`box-replay: ${error.message}`)
    return 2
  }
  const out = resolve(options.out ?? `box-replay-${options.commit}`)
  const upload = join(out, "upload")
  const jobId = options.jobId ?? `box-replay-${options.commit.slice(0, 12)}-${Date.now()}`
  // One box, or one for each job asked for: its own job id and results folder.
  const boxes = options.jobs.length === 0
    ? [{ out, id: jobId, args: command(options, upload, jobId) }]
    : options.jobs.map((job, index) => {
      const each = join(out, String(index + 1))
      const id = `${jobId}-${index + 1}`
      return { job, out: each, id, args: command(options, upload, id, join(each, "result.tgz"), job) }
    })
  if (options.dryRun) {
    for (const box of boxes) console.log([process.env.CFBOX ?? "cfbox", ...box.args].map(quote).join(" "))
    return 0
  }
  if (existsSync(out) && readdirSync(out).length > 0) {
    console.error(`box-replay: ${out} is not empty`)
    return 2
  }
  mkdirSync(join(upload, "packs"), { recursive: true })
  copyFileSync(fileURLToPath(new URL("box-replay.sh", import.meta.url)), join(upload, "box-replay.sh"))
  for (const name of names) copyFileSync(join(resolve(options.packs), name), join(upload, "packs", name))
  const runs = await pool(
    boxes.map((box) => async () => {
      mkdirSync(box.out, { recursive: true })
      const run = await cfbox(box.args, join(box.out, "box.log"))
      // A box whose stream broke may still run: it is stopped, so none is left behind.
      await cfbox(["stop", box.id])
      return run
    }),
    4
  )
  rmSync(upload, { recursive: true })
  if (options.jobs.length === 0) return collect(out, options.cpu, runs[0].code)
  const rows = boxes.map((box, index) => {
    console.log(`${box.job}:`)
    const exit = collect(box.out, options.cpu, runs[index].code)
    return { job: box.job, exit, report: reportIn(box.out) }
  })
  const lines = table(rows, options.cpu)
  writeFileSync(join(out, "jobs.txt"), `${lines.join("\n")}\n`)
  for (const line of lines) console.log(line)
  return Math.max(...rows.map((row) => row.exit))
}

const sameEntry = (arg) => {
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return resolve(arg) === fileURLToPath(import.meta.url)
  }
}

if (process.argv[1] !== undefined && sameEntry(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
