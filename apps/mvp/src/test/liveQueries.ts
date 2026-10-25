/**
 * `queries` as React reads them: each live query starts when a page reads it, as `useLiveQuery` subscribes on render.
 * A feature's routed-repository queries are getters (src/features/issues/issues.ts, src/features/pulls/pulls.ts), so
 * a read is the routed repository's, started then.
 */
export const startedOnRead = <Q extends object>(queries: Q): Q =>
  new Proxy(queries, {
    get: (target, key, receiver) => {
      const query: unknown = Reflect.get(target, key, receiver)
      if (typeof query === "object" && query !== null && "startSyncImmediate" in query) {
        ;(query as { readonly startSyncImmediate: () => void }).startSyncImmediate()
      }
      return query
    },
  })
