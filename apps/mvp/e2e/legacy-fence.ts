import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { ResourceLocks, alive, checkIncompleteOwner, DeadOwner, type Owner } from "./resource-locks.ts"

/** A shared admission fence excludes old account-lock runners during the rolling runner upgrade.
 * New runners join the cohort concurrently. Only its creator removes it, after all participants exit Playwright.
 * A killed creator leaves a reported stale fence; neither new nor old runners steal it.
 */
export const joinLegacyFence = async (path: string, locks: ResourceLocks) => {
  const owner: Owner = { pid: process.pid, host: hostname(), nonce: randomUUID(), since: new Date().toISOString() }
  const admission = new ResourceLocks(locks.root, { signal: locks.options.signal, pollMs: locks.options.pollMs })
  let creator = false
  let waiting = false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  for (;;) {
    const gate = await admission.acquire({ name: "admission:legacy-fence", mode: "write" })
    try {
      try {
        await mkdir(path, { mode: 0o700 })
        creator = true
        await writeFile(join(path, "owner"), `pnpm e2e:prod, pid ${owner.pid}, since ${owner.since}\n`, { mode: 0o600 })
        await writeFile(join(path, "cohort.json"), JSON.stringify(owner), { mode: 0o600 })
        await mkdir(join(path, "members"), { mode: 0o700 })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      let cohort: Owner | undefined
      try { cohort = JSON.parse(await readFile(join(path, "cohort.json"), "utf8")) as Owner }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (cohort) {
        if (!alive(cohort)) throw new DeadOwner(`Dead production e2e cohort owner: ${path}, pid ${cohort.pid}; no takeover`)
        await writeFile(join(path, "members", owner.nonce), JSON.stringify(owner), { flag: "wx", mode: 0o600 })
        locks.log("joined", "legacy-compatible-cohort")
        break
      }
      const text = await readFile(join(path, "owner"), "utf8").catch(() => "")
      const pid = Number(/\bpid (\d+)/.exec(text)?.[1])
      if (!text) await checkIncompleteOwner(path)
      if (Number.isSafeInteger(pid) && pid > 0 && !alive({ ...owner, pid })) throw new DeadOwner(`Dead legacy e2e lock owner: ${path}, pid ${pid}; no takeover`)
      if (!waiting) { locks.log("waiting", path, text.trim() || "owner missing"); waiting = true }
    } finally { await gate.release() }
    await locks.pause()
  }
  let removed = false
  return async () => {
    if (!removed) { await rm(join(path, "members", owner.nonce)); removed = true }
    if (!creator) return
    // Do not use the run's aborted signal for cleanup. The fence must survive until other children stop.
    const cleanup = new ResourceLocks(locks.root)
    let previous = ""
    for (;;) {
      const gate = await cleanup.acquire({ name: "admission:legacy-fence", mode: "write" })
      try {
        const members = await readdir(join(path, "members"))
        if (!members.length) {
          const current = JSON.parse(await readFile(join(path, "cohort.json"), "utf8")) as Owner
          if (current.nonce !== owner.nonce) throw new Error("Legacy fence changed owner")
          await rm(path, { recursive: true })
          return
        }
        const currentMembers = members.slice().sort().join(",")
        if (previous !== currentMembers) { locks.log("waiting", "cohort-exit", `participants=${members.length}`); previous = currentMembers }
        for (const member of members) {
          const participant = await readFile(join(path, "members", member), "utf8").catch(() => undefined)
          if (participant && !alive(JSON.parse(participant) as Owner)) throw new DeadOwner(`Dead production e2e cohort participant in ${path}; no takeover`)
        }
      } finally { await gate.release() }
      await cleanup.pause()
    }
  }
}

/** A media failure must not abandon a creator still protecting other participants from legacy runners. */
export const whileLeavingFence = async <A>(leave: () => Promise<void>, work: () => Promise<A>): Promise<A> => {
  const leaving = Promise.resolve().then(leave).then(() => undefined, (error: unknown) => error)
  try { return await work() }
  finally { const error = await leaving; if (error !== undefined) throw error }
}
