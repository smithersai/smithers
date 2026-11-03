#!/usr/bin/env node
/** Source-only jj workspace lifecycle; the shared mkdir lock also coordinates legacy lanes. */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, copyFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { sourcePath, writeSource } from "./files.mjs"
import { jj, prepareLane, checkNumbers } from "./numbering.mjs"
import { captureLane, repairLane, checkManifest, indexPath } from "./generated.mjs"
import { regenerateIndex } from "./projection.mjs"
import { runProcess } from "./process.mjs"
import { engineeringGateEnvironment } from "./engineering-gate-environment.mjs"
import { logLanding, requireReviews } from "./review.mjs"
import { typecheckApp } from "./typecheck.mjs"

const marker = ".jj/agent-workspace.json"
const excluded = new Set([".jj", ".git", "node_modules", ".cache", "dist", "target", ".alchemy", ".wrangler", "coverage", "test-results", "playwright-report", ".venv"])
const secret = (name) => /^\.env|^\.dev\.vars|\.(pem|key|p12)$/.test(name)
const revision = (root, rev) => jj(root, ["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", 'commit_id ++ "\\n"'])
const rejectConflicts = (root) => {
  for (const path of jj(root, ["diff", "--from", "main@origin", "--to", "@", "--name-only"]).split("\n").filter(Boolean)) {
    const bytes = diskBytes(sourcePath(root, path, true))
    if (bytes && !bytes.includes(0) && /^(?:<{7}|>{7})(?: |$)/m.test(bytes.toString("utf8"))) throw new Error(`Unresolved conflict markers: ${path}`)
  }
  if (revision(root, "main@origin..@ & conflicts()")) throw new Error("Conflicted lane commits; resolve them before landing")
}

/**
 * Never steal an old or ownerless lock: its owner may still be alive on another client.
 * @param {string} path
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function acquireLock(path, { timeoutMs = 300000, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid lock timeout")
  mkdirSync(dirname(path), { recursive: true })
  const token = randomUUID(), start = Date.now()
  let announced = false
  while (true) {
    signal?.throwIfAborted()
    try { mkdirSync(path); break } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!announced) { console.error(`WAITING landing lock: ${path}`); announced = true }
      if (Date.now() - start >= timeoutMs) {
        const owner = existsSync(join(path, "owner")) ? readFileSync(join(path, "owner"), "utf8").trim().slice(0, 240) : "ownerless (not reclaimed)"
        throw new Error(`Landing lock timed out: ${owner}; no lock was removed`)
      }
      await delay(Math.min(250, timeoutMs - (Date.now() - start)), undefined, { signal })
    }
  }
  const owner = `${hostname()} pid=${process.pid} token=${token}\n`
  try { writeFileSync(join(path, "owner"), owner, { flag: "wx" }) } catch (error) { rmSync(path, { recursive: true, force: true }); throw error }
  return () => {
    if (existsSync(join(path, "owner")) && readFileSync(join(path, "owner"), "utf8") === owner) rmSync(path, { recursive: true })
  }
}

const sourcePaths = (root, prefix = "") => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
  if (excluded.has(entry.name) || secret(entry.name)) return []
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  return entry.isDirectory() ? sourcePaths(root, path) : [path]
})

const storedBytes = (root, operation, path) => {
  const result = spawnSync("jj", ["--at-op", operation, "file", "show", "-r", "@", path], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot preserve the original source for ${path}`)
  return result.stdout
}
const diskBytes = (path) => {
  try { return lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path) }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error }
}
const equalBytes = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b)

/** Replay only dirty deltas; an unchanged upstream file receives the saved bytes, never an old full tree. */
export function replayDirtyFiles(root, saved) {
  const manifest = JSON.parse(readFileSync(join(saved, "manifest.json"), "utf8"))
  const updates = [], conflicts = []
  for (const entry of [...manifest.dirty, ...manifest.deleted.map((path) => ({ path, deleted: true }))]) {
    sourcePath(root, entry.path, true)
    const base = diskBytes(join(saved, "base", entry.path))
    const local = entry.deleted ? undefined : entry.symlink === undefined ? readFileSync(join(saved, "files", entry.path)) : Buffer.from(entry.symlink)
    const current = diskBytes(join(root, entry.path))
    if (equalBytes(current, local) || equalBytes(base, local)) continue
    if (equalBytes(current, base)) { updates.push({ ...entry, bytes: local }); continue }
    if (base && local && current && !entry.symlink && ![base, local, current].some((bytes) => bytes.includes(0))) {
      const incoming = join(saved, "incoming.tmp"), original = join(saved, "original.tmp"), upstream = join(saved, "upstream.tmp")
      writeFileSync(incoming, local); writeFileSync(original, base); writeFileSync(upstream, current)
      const merged = spawnSync("diff3", ["-m", "-L", "saved local edits", "-L", "old working copy", "-L", "updated upstream", incoming, original, upstream], { maxBuffer: 256 * 1024 * 1024 })
      for (const path of [incoming, original, upstream]) rmSync(path, { force: true })
      if (merged.error || ![0, 1].includes(merged.status)) throw new Error(`Cannot merge saved delta for ${entry.path}; source remains in ${saved}`)
      updates.push({ ...entry, bytes: merged.stdout })
      if (merged.status === 1) conflicts.push(entry.path)
    } else conflicts.push(entry.path)
  }
  for (const entry of updates) {
    if (entry.bytes === undefined) rmSync(join(root, entry.path), { force: true })
    else {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true })
      if (entry.symlink !== undefined) {
        rmSync(join(root, entry.path), { force: true })
        symlinkSync(entry.symlink, join(root, entry.path))
      } else {
        try { if (lstatSync(join(root, entry.path)).isSymbolicLink()) throw new Error(`Recovered destination is a symlink: ${entry.path}`) }
        catch (error) { if (error.code !== "ENOENT") throw error }
        writeSource(root, entry.path, entry.bytes)
      }
    }
  }
  if (conflicts.length) throw new Error(`Saved edits need resolution: ${conflicts.join(", ")}; original bytes retained in ${saved}`)
  writeFileSync(join(saved, "manifest.json"), JSON.stringify({ ...manifest, replayed: true }, null, 2), { mode: 0o600 })
}

/** Preserve only dirty source files and deletion metadata before jj's supported stale recovery. */
export function preserveDirtyFiles(root) {
  const debug = jj(root, ["debug", "local-working-copy", "--ignore-working-copy"])
  const operation = debug.match(/Current operation: OperationId\("([a-f0-9]+)"\)/)?.[1]
  if (!operation) throw new Error("Cannot identify working-copy operation; no recovery attempted")
  const known = new Map()
  for (const row of debug.split("\n").slice(2)) {
    if (!row.trim()) continue
    const match = row.match(/^.+?\s+(\d+)\s+(\d+)\s+\S+\s+(".*")$/)
    if (!match) throw new Error("Unknown jj working-copy diagnostic format; no files changed")
    known.set(JSON.parse(match[3]), { size: Number(match[1]), mtime: Number(match[2]) })
  }
  const paths = new Set([...known.keys(), ...sourcePaths(root)])
  const dirty = [], deleted = []
  let bytes = 0
  for (const path of paths) {
    sourcePath(root, path, true)
    let stat
    try { stat = lstatSync(join(root, path)) } catch (error) { if (error.code !== "ENOENT") throw error; if (known.has(path)) deleted.push(path); continue }
    const old = known.get(path)
    if (old && old.size === stat.size && old.mtime === Math.floor(stat.mtimeMs)) continue
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported source kind: ${path}`)
    bytes += stat.size
    dirty.push({ path, mode: stat.mode, symlink: stat.isSymbolicLink() ? readlinkSync(join(root, path)) : undefined })
  }
  if (bytes > 256 * 1024 * 1024) throw new Error(`Dirty source exceeds recovery limit (${bytes} bytes); no files changed`)
  const saved = join(root, ".jj/agent-recovery", randomUUID())
  mkdirSync(join(saved, "files"), { recursive: true, mode: 0o700 })
  for (const entry of dirty) if (entry.symlink === undefined) {
    mkdirSync(dirname(join(saved, "files", entry.path)), { recursive: true, mode: 0o700 })
    copyFileSync(join(root, entry.path), join(saved, "files", entry.path))
  }
  for (const path of [...dirty.map((entry) => entry.path), ...deleted]) if (known.has(path)) {
    mkdirSync(dirname(join(saved, "base", path)), { recursive: true, mode: 0o700 })
    writeFileSync(join(saved, "base", path), storedBytes(root, operation, path))
  }
  writeFileSync(join(saved, "manifest.json"), JSON.stringify({ operation, dirty, deleted, bytes }, null, 2), { mode: 0o600 })
  console.error(`RECOVERY preserved ${dirty.length} source files / ${bytes} bytes: ${saved}`)
  return { operation, saved }
}

/** jj snapshots on the working copy's own operation before reconciling and checking out the merged tree. */
export function ensureFresh(root) {
  try { jj(root, ["status"]); return } catch (error) {
    if (!/working copy is stale|sibling of the working copy|Could not read working copy.s operation/.test(error.message)) throw error
  }
  const saved = preserveDirtyFiles(root)
  try {
    jj(root, ["op", "integrate", saved.operation, "--ignore-working-copy"])
    jj(root, ["workspace", "update-stale"])
    replayDirtyFiles(root, saved.saved)
    jj(root, ["status"])
    console.error(`RECOVERED invoking workspace; source safeguard retained until land/remove: ${saved.saved}`)
  } catch (error) { throw new Error(`Recovery stopped; preserved source at ${saved.saved}: ${error.message}`) }
}

/** A lane is prepared from its top: commits above @ would be rebased without their numbers or generated files. */
function assertLaneTop(root) {
  if (revision(root, "(@:: ~ @) ~ empty()")) throw new Error("The working copy has commits above it; run sync from the lane's top")
}

function assertPrivateAncestry(root) {
  const others = revision(root, "((main@origin..@) | @::) & working_copies() ~ @")
  if (others) throw new Error("Another workspace shares mutable lane ancestry; refusing to rewrite its commits")
}

/** Prepare before rebase, then repair known projections, leaving all ordinary conflicts visible. */
export function syncWorkspace(root) {
  ensureFresh(root)
  assertLaneTop(root)
  console.error("FETCH main")
  jj(root, ["git", "fetch", "--remote", "origin"])
  assertPrivateAncestry(root)
  rejectConflicts(root)
  // Every commit of a stacked lane gets its own numbers and generated files, not only the head.
  const renames = prepareLane(root)
  for (const entry of renames) console.error(`RENUMBER ${entry.path} -> ${entry.to}`)
  const contexts = captureLane(root, "main@origin")
  console.error("REBASE private lane")
  jj(root, ["rebase", "-b", "@", "-d", "main@origin"])
  repairLane(root, contexts)
  // An index is purely a projection: restore main's bytes, then regenerate from the merged declarations.
  if (existsSync(join(root, indexPath)) && revision(root, "@ & conflicts()")) {
    const unresolved = jj(root, ["resolve", "--list"]).split("\n").filter((line) => line.startsWith(indexPath + " "))
    if (unresolved.length) jj(root, ["restore", "--from", "main@origin", indexPath])
  }
  rejectConflicts(root)
  if (revision(root, "main@origin..@ & conflicts()")) throw new Error("A lane commit below the head still has conflicts; resolve it before landing")
  checkNumbers(root)
  checkManifest(root)
  return renames
}

export function createWorkspace(root, destination, name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error("Workspace name must be a simple lane name")
  const requested = resolve(destination)
  if (!existsSync(dirname(requested))) throw new Error("Destination needs an existing parent directory")
  const path = join(realpathSync(dirname(requested)), basename(requested))
  if (existsSync(path)) throw new Error(`Destination already exists: ${path}`)
  if (path === realpathSync(root) || path.startsWith(realpathSync(root) + "/")) throw new Error("Workspace must be outside the invoking source tree")
  if (!existsSync(dirname(path)) || realpathSync(dirname(path)) !== dirname(path)) throw new Error("Destination needs an existing, canonical parent directory")
  jj(root, ["git", "fetch", "--remote", "origin", "--ignore-working-copy"])
  ensureFresh(root)
  jj(root, ["workspace", "add", "--sparse-patterns", "full", "--name", name, "-r", "main@origin", path])
  writeFileSync(join(path, marker), JSON.stringify({ version: 1, root: path, name, created: new Date().toISOString(), token: randomUUID() }, null, 2))
  console.log(`CREATED ${path} (source only; no install)`)
  return path
}

/**
 * Work a lane can strand without it being under @: a bookmark named for the lane
 * (`<name>`, `builder/<name>`), or a head no workspace, bookmark or remote holds,
 * committed since the lane began. Side repositories (w12-hold) lost work this way:
 * the lane moved @ back to main and the commits stayed behind as bare heads.
 */
export function strandedWork(root, { name, created }) {
  const unlanded = "~::main@origin & ~empty()"
  const quoted = JSON.stringify(name)
  const bookmarks = `(bookmarks(exact:${quoted}) | bookmarks(glob:${JSON.stringify(`*/${name}`)}))`
  const orphans = `heads(${unlanded} & ~::(working_copies() | bookmarks() | remote_bookmarks()))`
  // Dates compare here, not in the revset: jj 0.46 matches nothing for ISO date patterns.
  const template = 'committer.timestamp().format("%s") ++ " " ++ commit_id.short(12) ++ " " ++ local_bookmarks.map(|b| b.name()).join(",") ++ " " ++ description.first_line() ++ "\\n"'
  const since = Math.floor(Date.parse(created) / 1000) // commit times are whole seconds
  const found = jj(root, ["log", "--ignore-working-copy", "--no-graph", "-r", `(::${bookmarks} & ${unlanded}) | ${orphans}`, "-T", template]).split("\n").filter(Boolean)
  const onBookmark = new Set(jj(root, ["log", "--ignore-working-copy", "--no-graph", "-r", `::${bookmarks} & ${unlanded}`, "-T", 'commit_id.short(12) ++ "\\n"']).split("\n").filter(Boolean))
  return found.filter((line) => { const [seconds, id] = line.split(" "); return onBookmark.has(id) || Number(seconds) >= since }).map((line) => line.slice(line.indexOf(" ") + 1))
}

/** Refuse removal unless every source change is already on remote main and the directory is tool-owned. */
export function removeWorkspace(root) {
  const data = JSON.parse(readFileSync(join(root, marker), "utf8"))
  if (data.version !== 1 || data.root !== realpathSync(root) || !data.token || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(data.name)) throw new Error("Workspace ownership mismatch")
  ensureFresh(root)
  const recovery = join(root, ".jj/agent-recovery")
  if (existsSync(recovery) && readdirSync(recovery).some((name) => !JSON.parse(readFileSync(join(recovery, name, "manifest.json"), "utf8")).replayed)) throw new Error("Unresolved saved source; workspace retained")
  jj(root, ["git", "fetch", "--remote", "origin"])
  if (revision(root, "main@origin..@ ~ (empty() & @)")) throw new Error("Unpublished source changes; workspace retained")
  const stranded = strandedWork(root, data)
  if (stranded.length) throw new Error(`Unlanded work outside @; workspace retained (land it, or record why it is superseded):\n${stranded.join("\n")}`)
  // Refuse ignored files that jj cannot certify as landed, including local installs and secrets.
  const tracked = new Set(jj(root, ["file", "list", "--ignore-working-copy"]).split("\n"))
  const inspect = (directory = "") => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!directory && entry.name === ".jj") continue
      // jj 0.46+ links a colocated repo's secondary workspace with a `.git` gitdir file; `workspace forget` removes it.
      if (!directory && entry.name === ".git" && entry.isFile() && /^gitdir: .*\/worktrees\/[^/\n]+\n?$/.test(readFileSync(join(root, ".git"), "utf8"))) continue
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) inspect(path)
      else if (!tracked.has(path)) throw new Error(`Untracked/ignored data retained: ${path}`)
    }
  }
  inspect()
  jj(root, ["workspace", "forget", "--ignore-working-copy", data.name])
  rmSync(root, { recursive: true })
  console.log(`REMOVED ${root}`)
}

/**
 * @param {string} root
 * @param {{message?: string, tests?: string[], validation?: string, requirements?: string[], coAuthor?: string, noReviewNeeded?: string, afterValidation?: () => void, beforePush?: () => Promise<void>, signal?: AbortSignal, lockPath?: string}} [options]
 */
export async function landWorkspace(root, { message, tests = [], validation, requirements = [], coAuthor, noReviewNeeded, afterValidation, beforePush, signal, lockPath = process.env.SMITHERS_LAND_LOCK ?? join(homedir(), "smithers-builders/main-push.lock") } = {}) {
  const reviews = (tip) => requireReviews(root, `(main@origin..${tip}) ~ empty()`, { override: noReviewNeeded })
  const lock = () => acquireLock(lockPath, { timeoutMs: Number(process.env.SMITHERS_LOCK_TIMEOUT_MS ?? 300000), signal })
  let release = await lock()
  let base
  try {
    syncWorkspace(root)
    base = revision(root, "main@origin")
  } finally { release() }
  signal?.throwIfAborted()
  for (const requirement of requirements) {
    const equal = requirement.indexOf("=")
    const path = equal < 0 ? requirement : requirement.slice(0, equal)
    const needle = equal < 0 ? undefined : requirement.slice(equal + 1)
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Readiness path must be repository-relative")
    const files = jj(root, ["file", "list", "--ignore-working-copy", "-r", "main@origin", path])
    if (!files.split("\n").includes(path) || (needle !== undefined && !jj(root, ["file", "show", "--ignore-working-copy", "-r", "main@origin", path]).includes(needle))) {
      throw new Error(`Main is not ready: ${path}${needle === undefined ? "" : " (required content missing)"}; no commit-id wait was used`)
    }
  }
  if (existsSync(join(root, indexPath))) await regenerateIndex(root, undefined, signal)
  jj(root, ["status"])
  const tested = revision(root, "@")
  // Refuse before spending the tests; the check under the lock below is the one that counts.
  reviews("@")
  // Runs whatever validation the land names, --validated included, and holds no lock.
  await typecheckApp(root, { signal })
  for (const command of tests) {
    const result = await runProcess("bash", ["-o", "pipefail", "-c", command], { cwd: root, stream: true, signal, timeoutMs: 40 * 60 * 1000, env: engineeringGateEnvironment(process.env) })
    if (result.status !== 0) throw new Error(`Landing test failed: ${command}`)
  }
  signal?.throwIfAborted()
  release = await lock()
  try {
    // Publication is serialized, but capacity admission and validation never
    // hold the shared lock. A changed base needs a fresh sync and fresh checks.
    jj(root, ["git", "fetch", "--remote", "origin"])
    if (revision(root, "main@origin") !== base) throw new Error("Main advanced during validation; rerun land to sync and validate the new base")
    if (revision(root, "@") !== tested) throw new Error("Source changed during validation; rerun land before publishing")
    afterValidation?.()
    rejectConflicts(root)
    checkNumbers(root)
    checkManifest(root)
    const candidate = revision(root, "@ & empty()") ? "@-" : "@"
    const commit = revision(root, candidate)
    if (!commit || commit.includes("\n")) throw new Error("Landing requires one tip commit")
    if (revision(root, `${commit} & ::main@origin`)) { console.log(`LANDED ${commit} (already present)`); return commit }
    if (!tests.length && !validation) throw new Error("Supply --test <command> or --validated <existing test receipt>; nothing pushed")
    if (revision(root, `main ~ ::${commit}`)) throw new Error("Local main has unpublished work; refusing to move it backwards")
    if (message) {
      if (coAuthor && /[\r\n]/.test(coAuthor)) throw new Error("Co-author must be one trailer value")
      const authors = message.split(/\r?\n/).filter((line) => line.startsWith("Co-Authored-By: "))
      if (coAuthor) authors.push(`Co-Authored-By: ${coAuthor}`)
      const body = message.split(/\r?\n/).filter((line) => !line.startsWith("Co-Authored-By: ")).join("\n").trimEnd()
      const trailers = [...new Set(authors)].join("\n")
      const text = `${body}\n\nLanding-Tests: ${tests.length ? tests.join("; ") : validation}${trailers ? `\n${trailers}` : ""}`
      jj(root, ["describe", "-r", commit, "-m", text])
    } else if (!jj(root, ["log", "-r", commit, "--no-graph", "-T", "description"]).trim()) throw new Error("Describe the change or supply --message")
    const pushed = revision(root, candidate)
    // describe was the last snapshot: what is published must be the tree that was tested and typechecked.
    if (jj(root, ["diff", "--ignore-working-copy", "--from", tested, "--to", pushed, "--name-only"]).trim()) throw new Error("Source changed after validation; nothing pushed, rerun land")
    // From the gate to the push nothing snapshots, so an edit made now cannot join what was checked.
    logLanding(root, pushed, reviews(pushed))
    jj(root, ["bookmark", "set", "main", "-r", pushed, "--ignore-working-copy"])
    await beforePush?.()
    if (revision(root, "main") !== pushed) throw new Error("main moved after the review gate; nothing pushed, rerun land")
    console.error(`PUSH ${pushed}`)
    jj(root, ["git", "push", "--remote", "origin", "--bookmark", "main", "--ignore-working-copy"])
    jj(root, ["git", "fetch", "--remote", "origin", "--ignore-working-copy"])
    if (!revision(root, `${pushed} & ::main@origin`)) throw new Error("Push returned but remote ancestry does not contain the landed change")
    // Leave an immutable parent and a fresh private working-copy child for the next change.
    if (revision(root, "@") === pushed) jj(root, ["new", pushed])
    rmSync(join(root, ".jj/agent-recovery"), { recursive: true, force: true })
    console.log(`LANDED ${pushed}`)
    return pushed
  } finally { release() }
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  if (args[0] === "--help" || !args.length) {
    console.log("Usage: node .smithers/flows/land/workspace.mjs create <path> <name> | sync | recover | land [--message <text>] [--test <command>] [--validated <receipt>] [--no-review-needed <reason>] | remove\nRun from the invoking workspace. No installs. Sync and push use main-push.lock; remote validation runs unlocked. Waits are bounded. Ignored data prevents removal. Commits touching review-required.txt paths need a receipt from review.mjs.")
    return
  }
  const [command, ...rest] = args
  const options = { tests: [], requirements: [], coAuthor: process.env.SMITHERS_CO_AUTHOR, signal: undefined }
  if (command === "land") {
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i + 1]?.trim()) throw new Error(`Missing value: ${rest[i]}`)
      if (rest[i] === "--message") options.message = rest[i + 1]
      else if (rest[i] === "--test") options.tests.push(rest[i + 1])
      else if (rest[i] === "--validated") options.validation = rest[i + 1]
      else if (rest[i] === "--require") options.requirements.push(rest[i + 1])
      else if (rest[i] === "--no-review-needed") options.noReviewNeeded = rest[i + 1]
      else throw new Error(`Unknown option: ${rest[i]}`)
    }
  } else if (command === "create" ? rest.length !== 2 : rest.length !== 0) throw new Error("Invalid command arguments")
  if (!["create", "sync", "recover", "land", "remove"].includes(command)) throw new Error(`Unknown command: ${command}`)
  let root = realpathSync(cwd)
  while (!existsSync(join(root, ".jj"))) {
    const parent = dirname(root)
    if (parent === root) throw new Error("Run in a jj workspace")
    root = parent
  }
  const controller = new AbortController()
  const onSignal = () => controller.abort(new Error("Workspace operation interrupted"))
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal)
  let release
  try {
    if (command !== "land") release = await acquireLock(process.env.SMITHERS_LAND_LOCK ?? join(homedir(), "smithers-builders/main-push.lock"), {
      timeoutMs: Number(process.env.SMITHERS_LOCK_TIMEOUT_MS ?? 300000), signal: controller.signal
    })
    options.signal = controller.signal
    controller.signal.throwIfAborted()
    if (command === "create") createWorkspace(root, rest[0], rest[1])
    else if (command === "sync") syncWorkspace(root)
    else if (command === "recover") ensureFresh(root)
    else if (command === "land") await landWorkspace(root, options)
    else removeWorkspace(root)
  } finally {
    release?.(); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`NOT COMPLETED: ${error.message}`); process.exitCode = 1 })
}
