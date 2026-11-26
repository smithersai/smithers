import * as RefusalMarks from "../features/conversations/marks"
import { DEVICE_PRINCIPAL, type NodeDevice } from "./chatApi"

type MarksStorage = RefusalMarks.MarksHost["storage"]

/**
 * A real device whose SQLite refuses each write to `collection`'s rows while `faults.fail`, as a full disk does: its
 * other collections write on, and so does `collection` once `faults.fail` is off, for a tab opened afterwards.
 */
export const failWrites = (host: NodeDevice, collection: string): { readonly device: NodeDevice; readonly faults: { fail: boolean } } => {
  const faults = { fail: false }
  const device: NodeDevice = { ...host, persistence: { ...host.persistence, open: async () => {
    const database = await host.persistence.open()
    let table: string | undefined
    return { ...database, execute: async <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> => {
      if (faults.fail && /^\s*(insert|update|delete|replace)\b/i.test(sql)) {
        table ??= (await database.execute<{ readonly table_name: string }>(
          "select table_name from collection_registry where collection_id = ?",
          [collection],
        ))[0]?.table_name
        if (table !== undefined && sql.includes(table)) throw new Error("disk full")
      }
      return database.execute<T>(sql, params)
    } }
  } } }
  return { device, faults }
}

/**
 * A real device whose Web Storage takes no new key while `quota.full`, as a browser over its quota does: it still
 * reads, and it still removes. Its tabs hear every change, as the device's other tabs do. Each call is another
 * process's view of the one storage: `quota`, passed again, fills both at once, and neither counts the other's refusals.
 */
export const fillStorage = (host: NodeDevice, quota: { full: boolean } = { full: false }): { readonly device: NodeDevice; readonly quota: { full: boolean } } => {
  const web = host.webStorage
  const refusalMarks = RefusalMarks.make({
    channel: () => undefined,
    storage: {
      getItem: web.getItem,
      removeItem: web.removeItem,
      key: web.key,
      get length() {
        return web.length
      },
      setItem: (key, value) => {
        if (quota.full) throw new DOMException("full", "QuotaExceededError")
        web.setItem(key, value)
      },
    },
    principal: () => DEVICE_PRINCIPAL,
    lock: web.lock,
    changes: web.changes,
  })
  return { device: { ...host, refusalMarks }, quota }
}

/**
 * A real device as one of its tabs has its Web Storage: the tab is told of every change but its own, as a browser
 * tells a tab of the other tabs' writes only. A test device's storage otherwise tells every tab of every write.
 */
export const asOneTab = (host: NodeDevice): NodeDevice => {
  const web = host.webStorage
  let writing = false
  const quietly = <A>(write: () => A): A => {
    writing = true
    try {
      return write()
    } finally {
      writing = false
    }
  }
  const refusalMarks = RefusalMarks.make({
    channel: () => undefined,
    storage: {
      getItem: web.getItem,
      key: web.key,
      get length() {
        return web.length
      },
      setItem: (key, value) => quietly(() => web.setItem(key, value)),
      removeItem: (key) => quietly(() => web.removeItem(key)),
    },
    principal: () => DEVICE_PRINCIPAL,
    lock: web.lock,
    changes: (listener) => web.changes((key) => {
      if (!writing) listener(key)
    }),
  })
  return { ...host, refusalMarks }
}

/**
 * A real device whose Web Storage holds no more than it holds when `quota.full` is set, as a browser at its quota
 * does: a value as wide as the one it replaces fits, a removal leaves its room to the next write, and anything wider
 * is refused. Its tabs hear every change.
 */
export const capStorage = (host: NodeDevice): { readonly device: NodeDevice; readonly storage: MarksStorage; readonly quota: { full: boolean } } => {
  const quota = { full: false }
  const web = host.webStorage
  const sizeOf = (key: string) => (web.entries.has(key) ? key.length + web.entries.get(key)!.length : 0)
  const size = () => [...web.entries.keys()].reduce((sum, key) => sum + sizeOf(key), 0)
  let limit: number | undefined
  const storage: MarksStorage = {
    getItem: web.getItem,
    removeItem: web.removeItem,
    key: web.key,
    get length() {
      return web.length
    },
    setItem: (key, value) => {
      // The room is what the storage held at the first write after it filled.
      limit = quota.full ? limit ?? size() : undefined
      if (limit !== undefined && size() - sizeOf(key) + key.length + value.length > limit) throw new DOMException("full", "QuotaExceededError")
      web.setItem(key, value)
    },
  }
  const refusalMarks = RefusalMarks.make({ channel: () => undefined, storage, principal: () => DEVICE_PRINCIPAL, changes: web.changes, lock: web.lock })
  return { device: { ...host, refusalMarks }, storage, quota }
}

/**
 * A real device as one of its tabs has its Web Storage in the task another tab wrote it: the write is there to read,
 * and the browser has yet to tell this tab of it. Each change another tab made is told once `deliver` is called, in
 * the order made; the tab's own are never told.
 */
export const deferEvents = (host: NodeDevice): { readonly device: NodeDevice; readonly deliver: () => void; readonly pending: () => number } => {
  const web = host.webStorage
  let writing = false
  const quietly = <A>(write: () => A): A => {
    writing = true
    try {
      return write()
    } finally {
      writing = false
    }
  }
  const queued: Array<() => void> = []
  const refusalMarks = RefusalMarks.make({
    channel: () => undefined,
    storage: {
      getItem: web.getItem,
      key: web.key,
      get length() {
        return web.length
      },
      setItem: (key, value) => quietly(() => web.setItem(key, value)),
      removeItem: (key) => quietly(() => web.removeItem(key)),
    },
    principal: () => DEVICE_PRINCIPAL,
    lock: web.lock,
    changes: (listener) => web.changes((key) => {
      if (!writing) queued.push(() => listener(key))
    }),
  })
  return {
    device: { ...host, refusalMarks },
    deliver: () => {
      for (const tell of queued.splice(0)) tell()
    },
    pending: () => queued.length,
  }
}
