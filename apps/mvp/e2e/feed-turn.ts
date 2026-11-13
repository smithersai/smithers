import { ResourceLocks, type Lease } from "./resource-locks.ts"

/** A feed's cleanup belongs only to the process that acquired its nonce-checked resource lease. */
export class FeedTurn {
  private lease?: Lease
  readonly locks: ResourceLocks
  readonly repository: string
  constructor(locks: ResourceLocks, repository: string) { this.locks = locks; this.repository = repository }
  async acquire() {
    this.lease = await this.locks.acquire({ name: `feed:${this.repository.toLowerCase()}`, mode: "write" })
  }
  async close(cleanup: () => Promise<void>) {
    const lease = this.lease
    if (lease === undefined) return
    this.lease = undefined
    try { await cleanup() } finally { await lease.release() }
  }
}
