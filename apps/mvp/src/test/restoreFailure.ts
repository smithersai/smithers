import type { NodeDevice } from "./chatApi"

/** A real device whose selected collection cannot read its stored rows. */
export const failRestore = (host: NodeDevice, collection: string): NodeDevice => ({
  ...host,
  persistence: { ...host.persistence, make: (database, coordinator) => {
    const normal = host.persistence.make(database, coordinator)
    return { ...normal, resolvePersistenceForCollection: (selection) => {
      const resolved = normal.resolvePersistenceForCollection?.(selection) ?? normal
      const blocked = (adapter: object): object => new Proxy(adapter, { get: (target, property) => {
        if (property === "loadResumeSnapshot" || property === "loadSubset") return () => Promise.reject(new Error("disk"))
        const value = Reflect.get(target, property)
        if (property === "runInHydrationScope" && typeof value === "function") {
          return (task: (scoped: object) => Promise<unknown>) => value.call(target, (scoped: object) => task(blocked(scoped)))
        }
        return typeof value === "function" ? value.bind(target) : value
      } })
      return selection.collectionId === collection ? { ...resolved, adapter: blocked(resolved.adapter) as typeof resolved.adapter } : resolved
    } }
  } },
})

/** A real device whose `collection` reads its stored rows only once `release` is called. */
export const holdRestore = (host: NodeDevice, collection: string) => {
  const held = Promise.withResolvers<void>()
  const device: NodeDevice = {
    ...host,
    persistence: { ...host.persistence, make: (database, coordinator) => {
      const normal = host.persistence.make(database, coordinator)
      return { ...normal, resolvePersistenceForCollection: (selection) => {
        const resolved = normal.resolvePersistenceForCollection?.(selection) ?? normal
        // Held before the device's store is entered, so no other collection waits behind this one's turn at it.
        const reads = new Set<string | symbol>(["loadResumeSnapshot", "loadSubset", "runInHydrationScope"])
        const late = (adapter: object): object => new Proxy(adapter, { get: (target, property) => {
          const value = Reflect.get(target, property)
          if (typeof value !== "function") return value
          return reads.has(property)
            ? (...args: ReadonlyArray<unknown>) => held.promise.then(() => value.apply(target, args))
            : value.bind(target)
        } })
        return selection.collectionId === collection ? { ...resolved, adapter: late(resolved.adapter) as typeof resolved.adapter } : resolved
      } }
    } },
  }
  return { device, release: () => held.resolve() }
}
