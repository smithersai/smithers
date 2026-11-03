/** Bootstrap admission (Node and Python 3); all main pushers share this lease. */
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Admission includes validation ahead of us; keep every bootstrap caller on one bound. */
export const defaultLockTimeoutMs = 60 * 60 * 1000

const numeric = /^\d{16,}$/
export const text = (path) => { try { return readFileSync(path, "utf8") } catch (error) { if (error.code === "ENOENT") return undefined; throw error } }
export const atomicWrite = (path, value) => {
  const temporary = `${path}-${randomUUID()}.tmp`
  writeFileSync(temporary, value, { mode: 0o600 })
  renameSync(temporary, path)
}
export const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error }
}

// Every prepared decision is nonempty. POSIX rename cannot replace another nonempty
// directory: the winning claim and its complete contents become visible together.
export function claimDecision(directory, kind, name = "decision", owner) {
  const temporary = join(directory, `decision-${randomUUID()}`)
  mkdirSync(temporary, { mode: 0o700 })
  writeFileSync(join(temporary, "value"), JSON.stringify({ kind, owner }), { mode: 0o600 })
  if (owner) {
    const prepared = join(temporary, "legacy-prepared")
    mkdirSync(prepared, { mode: 0o700 })
    writeFileSync(join(prepared, `owner-${owner.token}`), JSON.stringify(owner), { flag: "wx", mode: 0o600 })
  }
  try { renameSync(temporary, join(directory, name)); return true }
  catch (error) { if (["ENOTEMPTY", "EEXIST"].includes(error.code)) return false; throw error }
  finally { rmSync(temporary, { recursive: true, force: true }) }
}
const decision = (directory) => {
  const value = text(join(directory, "decision/value"))
  return value && JSON.parse(value).kind
}
function checkLegacy(path) {
  let entry
  try { entry = lstatSync(path) } catch (error) { if (error.code === "ENOENT") return false; throw error }
  if (!entry.isDirectory()) {
    const kind = entry.isFile() ? "a regular file" : entry.isSymbolicLink() ? "a symbolic link" : entry.isFIFO() ? "a FIFO" : entry.isSocket() ? "a socket" : entry.isBlockDevice() ? "a block device" : entry.isCharacterDevice() ? "a character device" : "an unknown filesystem entry"
    throw new Error(`Landing lock ${path} is ${kind}, not the directory form (mkdir lock + owner); remove it only after confirming no lander holds it`)
  }
  return true
}

// A complete owner marker and mkdir exclusion must become visible together.
// Ordinary rename may replace an empty legacy lock, so use native NOREPLACE.
export function claimLegacy(prepared, path, timeoutMs = 5000) {
  if (checkLegacy(path)) return false
  const result = spawnSync("python3", [fileURLToPath(new URL("./claim-directory.py", import.meta.url)), prepared, path], {
    encoding: "utf8", timeout: Math.max(1, Math.min(5000, timeoutMs)), killSignal: "SIGKILL", maxBuffer: 64 * 1024
  })
  if (result.status === 17) return false
  if (result.error || result.status !== 0) throw new Error(`Landing atomic acquisition failed (Python 3 and exclusive rename required): ${result.error?.message ?? result.stderr.trim()}`)
  return true
}

// Preserve the unique marker while atomically retiring the whole directory. The
// nonempty destination stays forever, so a delayed second cleanup cannot rename
// a replacement owner's directory, even if it checked the old marker earlier.
export function finishTicket(directory, path, owner, reason, onEvent = () => {}) {
  claimDecision(directory, "released")
  onEvent({ stage: "release-decision" })
  // Initialization and retirement contend on a nonempty immutable cell. Either
  // the complete acquisition source is visible, or it can never appear later.
  claimDecision(directory, "retired", "initialization")
  owner = JSON.parse(text(join(directory, "initialization/value"))).owner ?? owner
  const retired = join(directory, "legacy-retired")
  if (owner && !existsSync(retired)) {
    // Retire the prepared source first: a surviving acquisition helper can no
    // longer publish it after this ticket is marked done. If the helper won,
    // the exact same nonempty directory is now at the global legacy path.
    for (const source of [join(directory, "initialization/legacy-prepared"), path]) {
      if (!existsSync(join(source, `owner-${owner.token}`))) continue
      try { renameSync(source, retired); break }
      catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error }
    }
  }
  onEvent({ stage: "legacy-retired" })
  onEvent({ stage: "retirement-checked" })
  atomicWrite(join(directory, "done"), reason)
}

export function expiry(directory, now, staleMs, maxHoldMs) {
  const bytes = text(join(directory, "owner.json"))
  if (!bytes) return now - lstatSync(directory).mtimeMs >= staleMs ? "uninitialized ticket heartbeat" : undefined
  const owner = JSON.parse(bytes)
  staleMs = owner.staleMs ?? staleMs; maxHoldMs = owner.maxHoldMs ?? maxHoldMs
  const held = text(join(directory, "held"))
  if (held !== undefined && now - Number(held) >= maxHoldMs) return "max hold expired"
  if (now - Number(text(join(directory, "heartbeat")) ?? owner.startTime) >= staleMs) return "heartbeat expired"
  if (owner.host === hostname() && !alive(owner.pid)) return "process gone"
}

// Read only process-group metadata globally. Inspect argv only for our recorded
// leader, never every process on a busy host. Zombies cannot publish.
export function groupAlive(record) {
  try { process.kill(-record.pid, 0) } catch (error) { if (error.code === "ESRCH") return false; if (error.code !== "EPERM") throw error }
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error("Cannot verify publication process-group termination")
  const rows = processRows(result.stdout)
  const leader = rows.find((row) => Number(row[1]) === record.pid && !row[3].startsWith("Z"))
  if (leader) {
    const identity = spawnSync("ps", ["-ww", "-p", String(record.pid), "-o", "args="], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
    if (identity.error) throw new Error("Cannot verify publication process identity")
    return groupSnapshot(record, result.stdout, identity.status === 0 ? identity.stdout : undefined)
  }
  return groupSnapshot(record, result.stdout)
}
const processRows = (output) => output.split("\n").map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/)).filter(Boolean)
export function groupSnapshot(record, output, identity) {
  const rows = processRows(output)
  const leader = rows.find((row) => Number(row[1]) === record.pid && !row[3].startsWith("Z"))
  if (leader && (identity === undefined || !identity.includes(record.token))) {
    // ps can briefly expose only "(node)" while the leader is exiting. Its
    // children can still publish: missing argv never proves PID reuse or death.
    throw new Error("Publication process identity unavailable; termination unconfirmed")
  }
  const members = rows.filter((row) => Number(row[2]) === record.pid)
  if (!members.length) throw new Error("Publication process group observation unavailable; termination unconfirmed")
  return members.some((row) => !row[3].startsWith("Z"))
}
export function recordProbeFailure(directory, record, error) {
  const previous = text(join(directory, "publisher-probe"))
  if (previous && JSON.parse(previous).reason === error.message) return
  atomicWrite(join(directory, "publisher-probe"), JSON.stringify({ pid: record.pid, reason: error.message, time: Date.now() }))
  console.error(`PUBLICATION pid=${record.pid} proof=unconfirmed; exclusion retained`)
}
export function killPublisher(record) {
  if (!groupAlive(record)) return
  try { process.kill(-record.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
}
export function publicationStopped(directory, now) {
  // External farm jobs outlive a dead queue owner. Only their owner/host's explicit
  // completion proof releases exclusion; PID death and lease age are not that proof.
  if (existsSync(join(directory, "external-work.json")) && !existsSync(join(directory, "external-work-stopped"))) return false
  if (decision(directory) !== "push" || existsSync(join(directory, "publisher-stopped"))) return true
  const bytes = text(join(directory, "publisher.json"))
  if (!bytes) return true // No permission to execute is sent before this record exists.
  const record = JSON.parse(bytes)
  if (record.host !== hostname()) return false // Clock age is not proof that a remote command stopped.
  try {
    if (groupAlive(record)) {
      if (alive(record.supervisorPid) && now < record.deadline) return false
      killPublisher(record)
      if (groupAlive(record)) return false
    }
  } catch (error) { recordProbeFailure(directory, record, error); return false }
  atomicWrite(join(directory, "publisher-stopped"), JSON.stringify({ proof: "local-group-probe", byPid: process.pid, time: Date.now() }))
  return true
}

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.ref(); child.channel?.ref()
  const stopped = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGKILL"); await stopped
}

/** Numeric atomic mkdir claims retain monotonic order after drain, cancellation and crashes. */
export async function acquireLock(path, {
  timeoutMs = Number(process.env.SMITHERS_LOCK_TIMEOUT_MS ?? defaultLockTimeoutMs),
  maxHoldMs = Number(process.env.SMITHERS_LOCK_MAX_HOLD_MS ?? 900000),
  staleMs = Number(process.env.SMITHERS_LOCK_STALE_MS ?? 60000),
  heartbeatMs = Number(process.env.SMITHERS_LOCK_HEARTBEAT_MS ?? 5000),
  signal, now = Date.now, wait = (ms) => delay(ms, undefined, { signal }), heartbeat = true,
  heartbeatProgram = fileURLToPath(import.meta.url), onEvent = () => {}, log = (line) => console.error(line)
} = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, maxHoldMs, staleMs, heartbeatMs })) {
    if (!Number.isFinite(value) || value < (name === "timeoutMs" ? 0 : 1)) throw new Error(`Invalid lock ${name}`)
  }
  if (heartbeat && heartbeatMs >= staleMs) throw new Error("Lock heartbeat interval must be shorter than its stale threshold")
  signal?.throwIfAborted()
  mkdirSync(dirname(path), { recursive: true }); checkLegacy(path)
  const queue = `${path}.queue`
  mkdirSync(queue, { recursive: true, mode: 0o700 })
  const tickets = () => readdirSync(queue).filter((name) => numeric.test(name)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)
  let number = BigInt(tickets().at(-1) ?? 0) + 1n, ticket, directory
  while (true) {
    ticket = String(number).padStart(16, "0"); directory = join(queue, ticket)
    try { mkdirSync(directory, { mode: 0o700 }); break } catch (error) { if (error.code !== "EEXIST") throw error; number++ }
  }
  const owner = { host: hostname(), pid: process.pid, startTime: now(), staleMs, maxHoldMs, token: randomUUID() }
  let child, publication, publishing, released = false, releasing, position, stopRequested = false
  const retained = new Set()
  const done = () => existsSync(join(directory, "done"))
  const lost = () => new Error(`Landing lock lost or expired: ticket ${number}; refusing to push`)
  const active = () => tickets().filter((name) => !existsSync(join(queue, name, "done")))
  const assertCurrent = () => {
    signal?.throwIfAborted()
    const claimed = decision(directory)
    if (released || done() || (claimed && claimed !== "push") || expiry(directory, now(), staleMs, maxHoldMs) || active()[0] !== ticket || !existsSync(join(path, `owner-${owner.token}`))) throw lost()
  }
  const stopPublication = (kind) => {
    if (!publication || publication.exitCode !== null || publication.signalCode !== null || stopRequested) return
    stopRequested = true
    // IPC alone cannot wake a suspended supervisor. Kill our own child before
    // trusting a process-group probe; no successor gets permission without proof.
    publication.kill("SIGKILL")
    if (publication.connected) publication.disconnect()
    try { atomicWrite(join(directory, "publisher-stop-requested"), JSON.stringify({ kind, supervisorPid: publication.pid, byPid: process.pid, time: Date.now() })) }
    catch { log(`PUBLICATION ticket ${number}: stop=${kind}, stop record unavailable`) }
  }
  const confirmPublicationStopped = async () => {
    const until = Date.now() + 5000
    while (!publicationStopped(directory, Date.now())) {
      if (Date.now() >= until) return false
      await delay(10)
    }
    return true
  }
  const release = () => {
    if (releasing) return releasing
    released = true
    releasing = (async () => {
      stopPublication(signal?.aborted ? "cancellation" : "release")
      await stopChild(publication)
      await publishing?.catch(() => {})
      await stopChild(child)
      signal?.removeEventListener("abort", aborted)
      if (!publicationStopped(directory, Date.now())) throw new Error("Publication termination is not confirmed; lock retained")
      finishTicket(directory, path, owner, "released", onEvent)
    })()
    return releasing
  }
  const aborted = () => { void release().catch(() => {}) }
  release.ticket = ticket; release.check = assertCurrent
  release.push = async (command, args, { cwd, env = process.env, stream = false } = {}) => {
    assertCurrent()
    if (publishing) throw lost()
    const deadline = Math.min(now() + 60000, Number(text(join(directory, "held"))) + maxHoldMs)
    atomicWrite(join(directory, "push-until"), String(deadline))
    publishing = new Promise((resolve, reject) => {
      publication = spawn(process.execPath, [fileURLToPath(new URL("./publish.mjs", import.meta.url)), directory, path], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
      let result, bytes = 0, failure
      const timer = setTimeout(() => { failure = new Error("Publication deadline expired"); stopPublication("deadline") }, Math.max(1, deadline - now()))
      publication.on("message", (message) => {
        if (message === "ready") {
          try { assertCurrent(); publication.send({ command, args, cwd, env, deadline }) } catch (error) { failure = error; stopPublication("lease-lost") }
        } else if (message.output) {
          bytes += Buffer.byteLength(message.output)
          if (bytes > 32 * 1024 * 1024) { failure = new Error("Publication output limit exceeded"); stopPublication("output-limit") }
          else if (stream) (message.channel === "stderr" ? process.stderr : process.stdout).write(message.output)
        } else if (message.result) result = message.result
      })
      publication.once("error", (error) => { clearTimeout(timer); reject(error) })
      publication.once("exit", () => {
        clearTimeout(timer)
        void (async () => {
          if (!await confirmPublicationStopped()) throw new Error("Publication termination is not confirmed; lock retained")
          if (failure || signal?.aborted || result?.status !== 0) throw failure ?? signal?.reason ?? new Error(`Publication failed (${result?.status ?? "interrupted"})`)
          resolve(result)
        })().catch(reject)
      })
    })
    return await publishing
  }
  try {
    atomicWrite(join(directory, "owner.json"), JSON.stringify(owner))
    atomicWrite(join(directory, "heartbeat"), String(now()))
    onEvent({ stage: "before-initialization" })
    if (!claimDecision(directory, "prepared", "initialization", owner)) throw lost()
    const prepared = join(directory, "initialization/legacy-prepared")
    signal?.addEventListener("abort", aborted, { once: true })
    log(`TICKET ${number} landing queue: ${path}`)
    while (true) {
      signal?.throwIfAborted()
      if (done()) throw lost()
      if (position !== undefined && now() - owner.startTime >= timeoutMs) throw new Error(`Landing queue timed out: ticket ${number}, position ${position}${position === 1 ? "; waiting for legacy lock" : ""}; no legacy lock was removed`)
      atomicWrite(join(directory, "heartbeat"), String(now()))
      for (const name of active()) {
        if (name === ticket) break
        const other = join(queue, name), reason = expiry(other, now(), staleMs, maxHoldMs)
        if (!reason) continue
        const revoked = claimDecision(other, "revoked")
        // A newly refreshed holder may have won publication concurrently with our
        // stale observation. Inspect the complete decision and recheck expiry.
        if (!revoked && !expiry(other, now(), staleMs, maxHoldMs)) continue
        if (!publicationStopped(other, now())) {
          if (!retained.has(name)) { retained.add(name); log(`RETAIN landing ticket ${BigInt(name)}: publication termination unconfirmed`) }
          continue
        }
        const previous = text(join(other, "owner.json")), reclaimed = previous && JSON.parse(previous)
        finishTicket(other, path, reclaimed, reason)
        log(`RECLAIM landing ticket ${BigInt(name)} ${reclaimed ? `${reclaimed.host} pid=${reclaimed.pid}` : "uninitialized"}: ${reason}`)
      }
      const nextPosition = active().indexOf(ticket) + 1
      if (position !== nextPosition) {
        position = nextPosition
        log(`WAITING landing queue ticket ${number}: position ${position}${position === 1 && checkLegacy(path) ? " (legacy lock)" : ""}`)
      }
      checkLegacy(path)
      if (position === 1) {
        if (claimLegacy(prepared, path, timeoutMs - (now() - owner.startTime))) {
          onEvent({ stage: "legacy-created" })
          atomicWrite(join(directory, "held"), String(now()))
          if (heartbeat) {
            child = spawn(process.execPath, [heartbeatProgram, "heartbeat", directory, String(heartbeatMs)], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
            await new Promise((resolve, reject) => {
              const abort = () => finish(signal.reason)
              const timer = setTimeout(() => finish(new Error(`Landing heartbeat startup timed out: ticket ${number}`)), Math.max(0, timeoutMs - (now() - owner.startTime)))
              const finish = (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve() }
              child.on("message", (message) => { if (message === "ready") finish() })
              child.once("error", finish); child.once("exit", () => finish(new Error("Landing heartbeat writer exited before readiness")))
              signal?.addEventListener("abort", abort, { once: true })
              onEvent({ stage: "heartbeat-spawned" })
              if (signal?.aborted) abort()
            })
            child.unref(); child.channel.unref()
          }
          assertCurrent(); log(`ACQUIRED landing ticket ${number}`)
          return release
        }
      }
      if (now() - owner.startTime >= timeoutMs) throw new Error(`Landing queue timed out: ticket ${number}, position ${position}${position === 1 ? "; waiting for legacy lock" : ""}; no legacy lock was removed`)
      await wait(Math.min(250, heartbeatMs, timeoutMs - (now() - owner.startTime)))
    }
  } catch (error) { await release(); signal?.throwIfAborted(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "heartbeat") {
  const directory = process.argv[3], interval = Number(process.argv[4])
  const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"))
  const tick = () => {
    if (!process.connected || existsSync(join(directory, "done")) || !alive(owner.pid)) process.exit(0)
    atomicWrite(join(directory, "heartbeat"), String(Date.now()))
  }
  process.once("disconnect", () => process.exit(0))
  tick(); setInterval(tick, interval); process.send("ready")
}
