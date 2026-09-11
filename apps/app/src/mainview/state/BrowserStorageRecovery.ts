import { encodeStorageRecovery, readLocalStorageRecovery, StorageRecoveryError } from "../chain/StorageRecovery"
import type { EnumerableRecoveryStorage, RecoveryTable, StorageRecoverySnapshot } from "../chain/StorageRecovery"

export interface BrowserRecoverySources {
  readonly session: NonNullable<StorageRecoverySnapshot["session"]>
  readonly localStorage: EnumerableRecoveryStorage | undefined
  /** Undefined means the API is unavailable; an undefined result means the database does not exist. */
  readonly sqlite: (() => Promise<ReadonlyArray<RecoveryTable> | undefined>) | undefined
  readonly memory?: EnumerableRecoveryStorage
}

/** Capture each source separately, without choosing, importing or merging a history. */
export const captureBrowserStorageRecovery = async (
  sources: BrowserRecoverySources
): Promise<StorageRecoverySnapshot> => {
  const localStorage = sources.localStorage === undefined ? undefined : readLocalStorageRecovery(sources.localStorage)
  const sqlite = await sources.sqlite?.()
  // SQLite and localStorage have no shared transaction. Refuse observable edits
  // across the database read as well as edits during each individual local scan.
  if (
    sources.localStorage !== undefined &&
    JSON.stringify(localStorage) !== JSON.stringify(readLocalStorageRecovery(sources.localStorage))
  ) {
    throw new StorageRecoveryError("changed")
  }
  const snapshot: StorageRecoverySnapshot = {
    format: "smithers-ui-recovery",
    version: 1,
    capturedAt: new Date().toISOString(),
    session: sources.session,
    unavailable: [
      ...(sources.localStorage === undefined ? ["localStorage" as const] : []),
      ...(sources.sqlite === undefined ? ["sqlite" as const] : [])
    ],
    ...(localStorage === undefined ? {} : { localStorage }),
    ...(sqlite === undefined ? {} : { sqlite }),
    ...(sources.memory === undefined ? {} : { memory: readLocalStorageRecovery(sources.memory) })
  }
  // The complete artifact, not each source independently, must fit the limit.
  encodeStorageRecovery(snapshot)
  return snapshot
}

/** An injected storage must support enumeration; silently missing old keys is not recovery. */
export const recoveryStorage = (storage: unknown): EnumerableRecoveryStorage | undefined => {
  if (storage === undefined) return undefined
  const candidate = storage as Partial<EnumerableRecoveryStorage> | null
  if (
    candidate === null || typeof candidate.length !== "number" || typeof candidate.key !== "function" ||
    typeof candidate.getItem !== "function"
  ) {
    throw new StorageRecoveryError("unreadable")
  }
  return candidate as EnumerableRecoveryStorage
}

/** A local Blob handoff only. URLs and anchors are owned by this small scope. */
export const createRecoveryDownload = (documentTarget: Document = document, urlTarget = URL) => {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  const release = (url: string): void => {
    const timer = pending.get(url)
    if (timer !== undefined) clearTimeout(timer)
    pending.delete(url)
    urlTarget.revokeObjectURL(url)
  }
  return {
    download: (json: string): void => {
      if (closed) throw new StorageRecoveryError("unreadable")
      const anchor = documentTarget.createElement("a")
      const url = urlTarget.createObjectURL(new Blob([json], { type: "application/json" }))
      try {
        anchor.href = url
        anchor.download = "smithers-local-recovery.json"
        anchor.hidden = true
        documentTarget.body.append(anchor)
        anchor.click()
        // Let the browser consume the object URL; dispose also releases it if
        // the owning controller/panel closes before this bounded grace period.
        pending.set(url, setTimeout(() => release(url), 60_000))
      } catch (error) {
        release(url)
        throw error
      } finally {
        anchor.remove()
      }
    },
    dispose: (): void => {
      closed = true
      for (const url of pending.keys()) release(url)
    }
  }
}
