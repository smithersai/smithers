import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export type Resource = { readonly name: string; readonly mode: "read" | "write" }
export type Owner = { readonly pid: number; readonly host: string; readonly nonce: string; readonly since: string }
export type Lease = { readonly resource: Resource; readonly release: () => Promise<void> }
export class DeadOwner extends Error {}
export class IncompleteOwner extends Error {}
const own = (): Owner => ({ pid: process.pid, host: hostname(), nonce: randomUUID(), since: new Date().toISOString() })
const code = (error: unknown) => (error as NodeJS.ErrnoException).code
export const alive = (owner: Owner) => {
  // A shared filesystem may be mounted on another host. Never interpret its PID locally.
  if (owner.host !== hostname()) return true
  try { process.kill(owner.pid, 0); return true } catch (error) { return code(error) !== "ESRCH" }
}
export const ordered = (resources: ReadonlyArray<Resource>): Resource[] => {
  const union = new Map<string, Resource>()
  for (const resource of resources) {
    if (!resource.name || !["read", "write"].includes(resource.mode)) throw new Error("Invalid e2e resource")
    if (union.get(resource.name)?.mode !== "write") union.set(resource.name, resource)
  }
  return [...union.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
const readOwner = async (path: string): Promise<Owner | undefined> => {
  try {
    const value = JSON.parse(await readFile(join(path, "owner"), "utf8")) as Owner
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !value.host || !value.nonce) throw new Error(`Invalid lock owner: ${path}`)
    return value
  } catch (error) { if (code(error) === "ENOENT") return undefined; throw error }
}
const publishOwner = async (path: string, owner: Owner) => {
  const temporary = join(path, `owner-${owner.nonce}.tmp`)
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" })
  await rename(temporary, join(path, "owner"))
}
export const checkIncompleteOwner = async (path: string) => {
  const info = await stat(path).catch((error) => { if (code(error) === "ENOENT") return undefined; throw error })
  if (info && Date.now() - info.mtimeMs > 5_000) throw new IncompleteOwner(`Incomplete e2e lock owner: ${path}; owner missing for over 5 seconds. Inspect manually; no takeover.`)
}
const checkOwner = (path: string, owner: Owner | undefined) => {
  if (owner && !alive(owner)) throw new DeadOwner(`Dead e2e lock owner: ${path}, pid ${owner.pid}, since ${owner.since}; inspect it manually. No lock was taken over.`)
}
const removeOwned = async (path: string, owner: Owner) => {
  if ((await readOwner(path))?.nonce !== owner.nonce) throw new Error(`E2e lock changed owner: ${path}`)
  await rm(path, { recursive: true })
}
export type LockOptions = { readonly signal?: AbortSignal; readonly log?: (line: string) => void; readonly pollMs?: number }
/** Real filesystem coordination. A dead or incomplete owner is never reclaimed. */
export class ResourceLocks {
  readonly root: string
  readonly options: LockOptions
  private readonly reported = new Map<string, string>()
  constructor(root: string, options: LockOptions = {}) { this.root = root; this.options = options }
  log(event: string, name: string, detail = "") {
    this.options.log?.(`[e2e-lock] ${new Date().toISOString()} pid=${process.pid} ${event} ${name}${detail ? ` ${detail}` : ""}`)
  }
  async blocked(path: string, owner: Owner | undefined) {
    checkOwner(path, owner)
    if (!owner) await checkIncompleteOwner(path)
    const detail = owner ? `pid=${owner.pid} host=${owner.host} since=${owner.since}` : "owner missing"
    if (this.reported.get(path) !== detail) { this.log("blocked", path, detail); this.reported.set(path, detail) }
  }
  async pause() { await delay(this.options.pollMs ?? 250, undefined, { signal: this.options.signal }) }
  async tryAcquire(resource: Resource): Promise<Lease | undefined> {
    this.options.signal?.throwIfAborted()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, `${encodeURIComponent(resource.name)}.lock`)
    const gate = `${path}.gate`
    const owner = own()
    try { await mkdir(gate, { mode: 0o700 }) } catch (error) {
      if (code(error) !== "EEXIST") throw error
      await this.blocked(gate, await readOwner(gate))
      return undefined
    }
    // If publishing fails, remove only the directory this invocation just created.
    try { await publishOwner(gate, owner) }
    catch (error) { await rm(gate, { recursive: true }); throw error }
    try {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const entries = await readdir(path)
      for (const entry of entries) {
        const held = await readOwner(join(path, entry))
        checkOwner(join(path, entry), held)
        if (!held || resource.mode === "write" || entry.startsWith("write-")) {
          await this.blocked(join(path, entry), held)
          return undefined
        }
      }
      const leasePath = join(path, `${resource.mode}-${owner.nonce}`)
      await mkdir(leasePath, { mode: 0o700 })
      try { await publishOwner(leasePath, owner) }
      catch (error) { await rm(leasePath, { recursive: true }); throw error }
      this.log("acquired", resource.name, `mode=${resource.mode}`)
      let released = false
      return { resource, release: async () => {
        if (released) return
        await removeOwned(leasePath, owner)
        released = true
        this.log("released", resource.name, `mode=${resource.mode}`)
      } }
    } finally { await removeOwned(gate, owner) }
  }
  async acquire(resource: Resource): Promise<Lease> {
    let waiting = false
    for (;;) {
      const lease = await this.tryAcquire(resource)
      if (lease) return lease
      if (!waiting) { this.log("waiting", resource.name, `mode=${resource.mode}`); waiting = true }
      await this.pause()
    }
  }
  async acquireAll(resources: ReadonlyArray<Resource>): Promise<Lease[]> {
    const leases: Lease[] = []
    try { for (const resource of ordered(resources)) leases.push(await this.acquire(resource)); return leases }
    catch (error) { await releaseAll(leases); throw error }
  }
}
export const releaseAll = async (leases: ReadonlyArray<Lease>) => {
  const results = await Promise.allSettled([...leases].reverse().map((lease) => lease.release()))
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map((result) => (result as PromiseRejectedResult).reason), "E2e lock release failed")
}

/** A pool lease is the repository resource itself, never a second competing namespace. All busy: wait, not fallback. */
export const leasePool = async (locks: ResourceLocks, repositories: ReadonlyArray<string>): Promise<{ repository: string; lease: Lease }> => {
  if (repositories.length === 0) throw new Error("Empty scratch repository pool")
  let waiting = false
  for (;;) {
    for (const repository of [...new Set(repositories)].sort()) {
      const lease = await locks.tryAcquire({ name: `repository:${repository.toLowerCase()}`, mode: "write" })
      if (lease) return { repository, lease }
    }
    if (!waiting) { locks.log("waiting", "scratch-pool"); waiting = true }
    await locks.pause()
  }
}
