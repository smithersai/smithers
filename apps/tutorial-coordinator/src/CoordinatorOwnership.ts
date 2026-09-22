import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"

/** One driver for the shared tutorial workspaces. SQLite releases this lock on
 * process death, including SIGKILL; an expired heartbeat is not death evidence.
 * Keep it in a separate database so journal transactions and polling stay live.
 */
export class CoordinatorOwnership {
  private readonly db: DatabaseSync
  private held = false
  private closed = false
  constructor(directory: string) {
    this.db = new DatabaseSync(join(directory, "coordinator-owner.sqlite"))
    this.db.exec("PRAGMA busy_timeout=0")
  }
  get owned(): boolean { return this.held && !this.closed }
  acquire(): boolean {
    if (this.closed) throw new Error("The tutorial coordinator is closed")
    if (this.held) return true
    try {
      this.db.exec("BEGIN IMMEDIATE")
      this.held = true
      return true
    } catch (error) {
      if ((error as { errcode?: number } | null)?.errcode === 5) return false // SQLITE_BUSY
      throw error
    }
  }
  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
    this.held = false
  }
}
