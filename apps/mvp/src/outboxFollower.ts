import type { Outbox } from "@smthrs/effect-tanstack-db"

// The outbox stores each write once, for every tab of the device, and only the tab that leads it sends, settles or
// takes back a write (decision 0002 §3). A tab that led earlier still shows the optimistic rows of the writes it made
// or restored then. The outbox library settles those rows only in the tab that removes the write, so a tab that lost
// the lead kept the rows of a write another tab then took back (Edit) or sent: a question shown Queued that would
// never be sent, until that tab led again.
//
// `followingOutbox` closes that gap in the host the outbox runs on. Every tab tells the others when it deletes from
// the outbox's storage, and a tab that doesn't lead reads the storage again on each such notice and releases the rows
// of every write it holds that the storage no longer has. The storage decides, never the notice: a notice carries no
// payload and no authority (`Outbox.Options.changes`).

/** The key prefix of a stored write, as @tanstack/offline-transactions' outbox names it: `tx:<transaction id>`. */
const WRITE = "tx:"

/** The parts of the outbox's host this follows: the library's entry point, the shared storage and its notices. */
type Followed = Pick<Outbox.Options<never>, "start" | "storage" | "changes">

/**
 * `host`, following the writes other tabs remove: a delete from its storage is published on `host.changes`, and on
 * each notice a tab that doesn't lead releases the optimistic rows of every write it holds that left the storage.
 * A write this tab made settles as sent elsewhere, as it does when this tab leads again (`outbox.send` outcome
 * `sent_elsewhere`); a restored write's rows go. Rows of writes still stored stay. A host without `changes` is
 * returned as it is: its tabs can't hear each other.
 */
export const followingOutbox = <Host extends Followed>(host: Host): Host => {
  const changes = host.changes
  if (changes === undefined) return host
  let executor: ReturnType<Followed["start"]> | undefined
  // The stored writes this tab's outbox read or wrote, so may show rows of, until this tab sees them deleted.
  const held = new Set<string>()
  const hold = (key: string) => {
    if (key.startsWith(WRITE)) held.add(key)
  }
  const publish = () => {
    try {
      changes.publish()
    } catch {
      // expected: a notice is a hint, and a closed channel can't undo the delete it follows
    }
  }
  let noticed = false
  let releasing: Promise<void> | undefined
  /** One read of the storage at a time; a notice during a read asks for one more, so the last delete is never missed. */
  const release = (): Promise<void> => {
    noticed = true
    return releasing ??= (async () => {
      while (noticed) {
        noticed = false
        // The tab that leads settles its own writes, under the outbox's locks.
        if (executor === undefined || executor.isOfflineEnabled || held.size === 0) continue
        const stored = new Set(await host.storage.keys())
        // It took the lead during the read: its replay settles what left the storage.
        if (executor.isOfflineEnabled) continue
        for (const key of [...held].filter((key) => !stored.has(key))) {
          held.delete(key)
          executor.resolveTransaction(key.slice(WRITE.length), undefined)
        }
      }
    })().catch(() => {
      // expected: an unreadable storage releases nothing, and the next notice reads it again
    }).finally(() => {
      releasing = undefined
    })
  }
  return {
    ...host,
    start: (config) => {
      executor = host.start(config)
      return executor
    },
    changes: {
      publish: () => changes.publish(),
      // The outbox subscribes for as long as it runs, so this tab follows for exactly that long.
      subscribe: (listener) =>
        changes.subscribe(() => {
          listener()
          void release()
        }),
    },
    storage: {
      withLock: (name, action) => host.storage.withLock(name, action),
      keys: () => host.storage.keys(),
      get: async (key) => {
        const stored = await host.storage.get(key)
        if (stored !== null) hold(key)
        return stored
      },
      set: async (key, value) => {
        await host.storage.set(key, value)
        hold(key)
      },
      setMany: async (entries) => {
        await host.storage.setMany(entries)
        for (const [key] of entries) hold(key)
      },
      delete: async (key) => {
        await host.storage.delete(key)
        held.delete(key)
        publish()
      },
      clear: async () => {
        await host.storage.clear()
        held.clear()
        publish()
      },
    },
  }
}
