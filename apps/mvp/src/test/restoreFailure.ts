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
