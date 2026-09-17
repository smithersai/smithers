import { Database } from "bun:sqlite"
import { chmodSync, lstatSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { AgentTurnJournalRequest } from "@smthrs/rpc/AgentTurnJournal"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { runRequest } from "smithers-server/Boundary"
import { accessDurableTurn, eraseDurableTurn, withDurableAgentTurn } from "smithers-server/DurableTurn"
import type { NativeNamespace, NativeStorage } from "smithers-server/DurableStorage"
import { ExecutionContext, executionContextFrom } from "smithers-server/Environment"
import { createTurnJournalClient } from "smithers-server/TurnJournalClient"
import { TurnCancelRegistry } from "smithers-server/turns"
import { acquireDaemonLease } from "./LocalDaemonLease"

const unavailable = (): Response => Response.json({ status: "error", code: "storage_failed", message: "Recorded chat storage is unavailable on this host." }, { status: 503 })

/**
 * The local session capability authenticates the device before these methods
 * run. Each turn additionally needs its persisted private replay capability.
 * The process lease and the object's mutex give SQLite the same exclusive
 * journal ownership as the Worker's native Durable Object.
 */
export const createNativeTurnJournal = (stateDir: string | undefined) => {
  let database: Database | undefined
  let releaseLease: (() => void) | undefined
  let closing = false
  let disposed = false
  const objects = new Map<string, TurnCancelRegistry>()
  const background = new Set<Promise<unknown>>()
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const requests = new Set<Promise<Response>>()

  const open = (): Database => {
    if (disposed || stateDir === undefined) throw new Error("No persistent turn storage is configured.")
    if (database !== undefined) return database
    const directory = join(stateDir, "chat-journal")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
      throw new Error("Turn storage must be private and owned by the current user.")
    }
    const release = acquireDaemonLease(directory)
    let candidate: Database | undefined
    try {
      const path = join(directory, "turns.sqlite")
      try {
        const file = lstatSync(path)
        if (!file.isFile() || file.uid !== process.getuid!() || (file.mode & 0o077) !== 0) throw new Error("Turn database must be private.")
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      candidate = new Database(path, { create: true, strict: true })
      chmodSync(path, 0o600)
      candidate.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
      candidate.exec("CREATE TABLE IF NOT EXISTS turn_storage (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key)) WITHOUT ROWID")
      database = candidate
      releaseLease = release
      return database
    } catch (error) {
      candidate?.close()
      release()
      throw error
    }
  }

  const namespace: NativeNamespace = {
    idFromName: name => name,
    get: id => ({ fetch: async request => {
      const scope = String(id)
      const db = open()
      let object = objects.get(scope)
      if (object === undefined) {
        const storage: NativeStorage = {
          get: async <T>(key: string): Promise<T | undefined> => {
            const row = db.query<{ value: string }, [string, string]>("SELECT value FROM turn_storage WHERE scope=? AND key=?").get(scope, key)
            return row === null ? undefined : JSON.parse(row.value) as T
          },
          put: async (key, value) => {
            const entries = (typeof key === "string" ? [[key, value]] as const : Object.entries(key)).map(([name, item]) => [name, JSON.stringify(item)] as const)
            db.transaction(() => {
              const write = db.query("INSERT INTO turn_storage(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
              for (const [name, encoded] of entries) write.run(scope, name, encoded)
            })()
          },
          delete: async key => { db.query("DELETE FROM turn_storage WHERE scope=? AND key=?").run(scope, key) }
        }
        object = new TurnCancelRegistry({ storage })
        objects.set(scope, object)
      }
      return object.fetch(request)
    } })
  }
  const client = createTurnJournalClient(namespace)
  const executionContext = executionContextFrom({ waitUntil: work => {
    background.add(work)
    void work.finally(() => background.delete(work))
  } })
  const track = async (work: Promise<Response>): Promise<Response> => {
    requests.add(work)
    try { return await work } finally { requests.delete(work) }
  }
  const ownResponse = (response: Response): Response => {
    if (response.body === null || !response.headers.get("content-type")?.includes("application/x-ndjson")) return response
    const reader = response.body.getReader()
    readers.add(reader)
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { readers.delete(reader); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { readers.delete(reader); controller.error(error) }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } finally { readers.delete(reader) }
      }
    }), { status: response.status, headers: response.headers })
  }
  return {
    start: async (request: Request, body: StartAgentTurnRequest & { readonly journal: AgentTurnJournalRequest }, start: () => Response): Promise<Response> => {
      if (closing || stateDir === undefined) return unavailable()
      return ownResponse(await track(runRequest(withDurableAgentTurn(body, undefined, client, () => Effect.sync(start)).pipe(
        Effect.provideService(ExecutionContext, executionContext)
      ), request.signal)))
    },
    access: async (request: Request, retire: boolean, erase = false): Promise<Response> => {
      if (closing || stateDir === undefined) return unavailable()
      const response = await track(runRequest(erase ? eraseDurableTurn(request, client) : accessDurableTurn(request, undefined, client, retire), request.signal))
      // secure_delete overwrites reclaimed cells; truncation removes prior WAL
      // versions after a completed logical retirement. External backups are
      // outside this database's authority.
      if ((retire || erase) && response.ok) {
        try {
          const checkpoint = database?.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
          // SQLite reports a pinned reader as a busy result, without throwing.
          // Keep the outbox entry until a retry can erase our retained WAL too.
          if (checkpoint === null || checkpoint === undefined || checkpoint.busy !== 0 || checkpoint.log !== 0) return unavailable()
        } catch { return unavailable() }
      }
      return response
    },
    close: async (): Promise<void> => {
      closing = true
      await Promise.allSettled([...requests])
      await Promise.allSettled([...readers].map(reader => reader.cancel("local host shutting down")))
      while (background.size > 0) await Promise.allSettled([...background])
      disposed = true
      try { database?.close() } finally { database = undefined; objects.clear(); releaseLease?.(); releaseLease = undefined }
    }
  }
}
