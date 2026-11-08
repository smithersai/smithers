/** Full affected validation happens before FIFO admission; publication only checks this receipt. */
import { createHash, randomUUID } from "node:crypto"
import { boundedSpawnSync as spawnSync, withProcessDeadline } from "./process.mjs"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { jj } from "./numbering.mjs"
import { affectedPlan, affectedTests, gateBudgetMs, gitSource, jjSource, AffectedIncomplete } from "./affected.mjs"

const lines = (text) => text.split("\n").filter(Boolean)
const digest = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const suites = (plan) => [...plan.labels, ...(plan.reachesMvp ? ["apps/mvp Vitest"] : [])].sort()
const hex = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value)

// Execution proof binds exact bytes, types, modes and links. Review-only identity
// normalization cannot authorize unexecuted content, including renumbered assertions.
const commitHash = (root, parent, commit) => {
  const entries = (rev) => new Map(lines(jj(root, ["file", "list", "--ignore-working-copy", "-r", rev, "-T", 'path ++ "\\0" ++ file_type ++ " " ++ executable ++ "\\n"'])).map((line) => line.split("\0")))
  const before = entries(parent), after = entries(commit), structural = []
  const changed = jj(root, ["diff", "--ignore-working-copy", "--from", parent, "--to", commit, "-T", 'source.path() ++ "\\0" ++ target.path() ++ "\\0"']).split("\0").filter(Boolean)
  for (const path of [...new Set(changed)].sort()) {
    const old = before.get(path), next = after.get(path)
    const content = (rev, entry) => {
      if (!entry || entry.startsWith("symlink ")) return null
      const result = spawnSync("jj", ["--color=never", "--no-pager", "file", "show", "--ignore-working-copy", "-r", rev, path], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
      if (result.error || result.status !== 0) throw new Error(`Cannot hash affected execution input ${path}`)
      return digest(result.stdout)
    }
    structural.push([path, old ?? null, next ?? null, content(parent, old), content(commit, next)])
    if (old?.startsWith("symlink ") || next?.startsWith("symlink ")) {
      const patch = jj(root, ["diff", "--ignore-working-copy", "--git", "--from", parent, "--to", commit, path])
      if (patch) structural.push([path, digest(patch)])
    }
  }
  return structural
}

// Keep the legacy checkout adapter here; jj workspaces never invoke the Git CLI.
function repository(root) {
  if (existsSync(join(root, ".jj"))) {
    const revision = (rev) => jj(root, ["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", 'commit_id ++ "\\n"'])
    const fork = (base, head) => {
      const point = revision(`heads(::${base} & ::${head})`)
      if (!hex(point)) throw new Error("Cannot identify one fork point with main")
      return point
    }
    return {
      directory: join(root, ".jj/affected-receipts"),
      base: () => revision('remote_bookmarks(exact:"main", exact:"origin")') || revision("root()"),
      head: () => jj(root, ["log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id"]),
      source: (base, head) => jjSource(root, fork(base, head), head),
      hash: (base, head) => digest(JSON.stringify(commitHash(root, fork(base, head), head))),
    }
  }
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`Cannot inspect affected receipt source (${args[0]})`)
    return result.stdout.trim()
  }
  return {
    directory: join(git("rev-parse", "--absolute-git-dir"), "affected-receipts"),
    base: () => { const result = spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], { cwd: root, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : null },
    head: () => git("rev-parse", "HEAD"),
    tip: () => { const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : null },
    source: (base, head) => gitSource(root, base === null ? null : git("merge-base", base, head), head),
    hash: (base, head) => digest(git("diff", "--binary", "--no-ext-diff", "--no-renames", base === null ? git("hash-object", "-t", "tree", "--stdin") : git("merge-base", base, head), head)),
  }
}

/** Writes the immutable gate outcome before FIFO admission: passed proof or explicit incomplete evidence. */
export async function runAffectedGate(root, { base, head, signal, run, timeoutMs = gateBudgetMs } = {}) {
  const started = Date.now(), allowance = Math.min(timeoutMs, gateBudgetMs)
  const stopAt = started + allowance - Math.min(5000, allowance / 10)
  let repo
  const controller = new AbortController()
  const gateSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let stage = "source-inspection", hash, plan, tip, report, rejectDeadline, cleanupTimer, outcome
  const expired = () => new AffectedIncomplete(stage === "source-inspection" ? stage : "execution-deadline", "the whole gate exhausted its wall budget (at most 30 minutes)")
  const deadline = new Promise((_, reject) => { rejectDeadline = reject })
  const timer = setTimeout(() => { const error = expired(); controller.abort(error); rejectDeadline(error) }, Math.max(0, stopAt - Date.now()))
  const recordIncomplete = error => {
    if (report) return report
    if (!repo || !hex(head) || (base !== null && !hex(base))) {
      console.error(`AFFECTED gate: incomplete, stage=${error.stage}; no receipt; proceed`)
      return undefined
    }
    try {
      const directory = join(repo.directory, "incomplete")
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const proven = error.proven ?? { targets: 0, files: 0, sharedFailures: 0 }
      report = join(directory, `${randomUUID()}.json`)
      const binding = hash && plan ? "diff" : "head"
      writeFileSync(report, JSON.stringify({ version: 1, status: "incomplete", binding, base, head, tip: tip ?? head,
        diffHash: binding === "diff" ? hash : null, suites: plan ? suites(plan) : [], stage: error.stage, retry: error.retry, proven,
        selectedTargets: plan?.labels.length ?? null, selectedFiles: plan?.vitestFiles.length ?? null,
        elapsedMs: Date.now() - started, created: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      console.error(`AFFECTED INCOMPLETE stage=${error.stage}; proven: ${proven.targets} targets, ${proven.files} files, ${proven.sharedFailures} shared failures; proceed; report=${report}`)
      return report
    } catch {
      console.error(`AFFECTED gate: incomplete, stage=receipt-unreadable; no receipt; proceed`)
      return undefined
    }
  }
  const execute = async () => {
    try {
      repo = repository(root)
      base = base === undefined ? repo.base() : base
      head ??= repo.head()
      gateSignal.throwIfAborted()
      tip = repo.tip ? repo.tip() : head
      const source = repo.source(base, head)
      hash = repo.hash(base, head)
      plan = affectedPlan(root, source)
      stage = "execution"
      const result = await affectedTests(root, { source, signal: gateSignal, run, timeoutMs: stopAt - Date.now() })
      gateSignal.throwIfAborted()
      const receipt = { version: 1, status: "passed", base, head, tip, diffHash: hash, suites: suites(plan), proven: result?.proven ?? { targets: 0, files: 0, sharedFailures: 0 }, created: new Date().toISOString(), excusedSkippedFiles: result?.excusedSkippedFiles ?? [], unchangedZeroTestFiles: result?.unchangedZeroTestFiles ?? [] }
      mkdirSync(repo.directory, { recursive: true, mode: 0o700 })
      const file = join(repo.directory, `${base ?? "empty"}-${hash.slice(7)}.json`), temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      renameSync(temporary, file)
      console.error(`AFFECTED receipt=${file} base=${base ?? "empty"} diff=${hash}`)
      return file
    } catch (error) {
      if (error.status === "refused") throw error
      if (controller.signal.aborted && error.status !== "incomplete") error = controller.signal.reason
      if (signal?.aborted && error.status !== "incomplete") error = new AffectedIncomplete("cancellation", "gate canceled before execution proof completed")
      return recordIncomplete(error.status === "incomplete" ? error : Object.assign(new AffectedIncomplete(stage, "gate did not complete execution proof"), { proven: error.proven }))
    }
  }
  const work = withProcessDeadline({ at: stopAt, signal: gateSignal, expired }, execute)
  const settled = work.then(value => { outcome = { value } }, error => { outcome = { error } })
  try { return await Promise.race([work, deadline]) }
  catch (error) {
    if (!controller.signal.aborted) throw error
    await Promise.race([settled, new Promise(resolve => { cleanupTimer = setTimeout(resolve, Math.max(0, started + allowance - Date.now())) })])
    if (outcome?.error?.status === "refused") throw outcome.error
    if (outcome?.value) return outcome.value
    return recordIncomplete(error)
  } finally { clearTimeout(timer); clearTimeout(cleanupTimer) }
}

/** Reads the receipt and current diff only; unproven outcomes proceed without rerunning work. */
export async function requireAffectedReceipt(root, file, { base, head } = {}) {
  let receipt
  try { receipt = JSON.parse(readFileSync(file, "utf8")) } catch {}
  // Failure proof belongs to this change's tested diff, even after main advances.
  if (receipt?.status === "refused" || (Array.isArray(receipt?.regressions) && receipt.regressions.length)) throw new Error(`Affected gate refused: proven regression${receipt.regressions?.length ? `: ${receipt.regressions.join(", ")}` : ""}`)
  const proven = receipt?.proven && ["targets", "files", "sharedFailures"].every(key => Number.isSafeInteger(receipt.proven[key]) && receipt.proven[key] >= 0)
    ? receipt.proven : { targets: 0, files: 0, sharedFailures: 0 }
  const incomplete = stage => {
    console.error(`AFFECTED gate: incomplete, stage=${stage}; proven: ${proven.targets} targets, ${proven.files} files, ${proven.sharedFailures} shared failures; proceed`)
    return { ...receipt, status: "incomplete", stage, proven }
  }
  if (receipt?.version !== 1 || !["passed", "incomplete"].includes(receipt.status) || (!hex(receipt.base) && receipt.base !== null) || !hex(receipt.head)) return incomplete("receipt-unreadable")
  try {
    const repo = repository(root)
    base = base === undefined ? repo.base() : base
    head ??= repo.head()
    if (receipt.base !== base) return incomplete("main-advanced")
    if (receipt.diffHash ? receipt.diffHash !== repo.hash(base, head) : receipt.head !== head) return incomplete("source-changed")
  } catch { return incomplete("receipt-unreadable") }
  if (receipt.status === "incomplete") return incomplete(typeof receipt.stage === "string" && /^[a-z][a-z0-9-]*$/.test(receipt.stage) ? receipt.stage : "receipt-unreadable")
  if (!receipt.diffHash) return incomplete("receipt-unreadable")
  console.error("AFFECTED gate: passed")
  return receipt
}
