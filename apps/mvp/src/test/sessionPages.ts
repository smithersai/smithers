import { pageWipe, type WipeReason } from "../wipe"
import type { nodeDevice } from "./chatApi"

/** Real page lifecycle on native locks and channels; the device supplies the stores deleted at the next boot. */
export const sessionPages = (device: ReturnType<typeof nodeDevice>) => {
  const name = `session-pages-${crypto.randomUUID()}`
  const marks = new Map<string, string>()
  const reloads: Array<WipeReason> = []
  let deleted = 0
  const page = () => pageWipe({
    locks: { request: ((key: string, options: LockOptions, callback: LockGrantedCallback<unknown>) =>
      navigator.locks.request(`${name}/${key}`, options, callback)) as LockManager["request"] },
    marks: {
      getItem: (key) => marks.get(key) ?? null,
      setItem: (key, value) => { marks.set(key, value) },
      removeItem: (key) => { marks.delete(key) },
    },
    directory: async () => ({ getDirectoryHandle: async () => ({ removeEntry: async () => {} }) as unknown as FileSystemDirectoryHandle, removeEntry: async () => {} }),
    indexedDB: { deleteDatabase: () => {
      const request = {} as IDBOpenDBRequest
      void device.wipe().then(() => { deleted++; request.onsuccess?.(new Event("success")) })
      return request
    } },
    channel: (key) => new BroadcastChannel(`${name}/${key}`),
    reload: (reason) => { reloads.push(reason) },
  }, { engine: device.engineName, outbox: "outbox" })
  return { page, marks, reloads, deleted: () => deleted }
}
