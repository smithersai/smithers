import { Context, Deferred, type Duration, Effect, Option, Ref } from "effect"

/** Only these cold reads can be held; unrelated HTTP and all writes remain real. */
export type ColdRead = "first-paint" | "role" | "items" | "item-summaries" | "comments"

/** A bounded faulty read service, injected into the shell host and the app's FetchHttpClient.Fetch service. */
export class ColdReads extends Context.Service<ColdReads, {
  readonly wait: (read: ColdRead) => Effect.Effect<void>
  readonly entered: (read: ColdRead) => Effect.Effect<void>
  readonly release: (read: ColdRead) => Effect.Effect<void>
  readonly expired: Effect.Effect<ReadonlyArray<ColdRead>>
}>()("@smthrs/mvp/test/ColdReads") {
  static readonly make = (reads: ReadonlyArray<ColdRead>, within: Duration.Input = "30 seconds") => Effect.gen(function* () {
    const expired = yield* Ref.make<ReadonlyArray<ColdRead>>([])
    const holds = new Map<ColdRead, { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>()
    for (const read of reads) holds.set(read, { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() })
    return ColdReads.of({
      expired: Ref.get(expired),
      wait: (read) => Effect.gen(function* () {
        const hold = holds.get(read)
        if (hold === undefined) return
        yield* Deferred.succeed(hold.entered, undefined)
        // A failed test cannot strand a later boot; interruption still cancels this caller immediately.
        const result = yield* Deferred.await(hold.release).pipe(Effect.timeoutOption(within))
        if (Option.isNone(result)) yield* Ref.update(expired, reads => [...new Set([...reads, read])])
      }),
      entered: (read) => Effect.suspend(() => {
        const hold = holds.get(read)
        return hold === undefined ? Effect.void : Deferred.await(hold.entered)
      }),
      release: (read) => Effect.suspend(() => {
        const hold = holds.get(read)
        return hold === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(hold.release, undefined))
      }),
    })
  })
}

/** Content-free request keys shared by the first-paint, role and shape services. */
export const coldReadOf = (input: string | URL | Request): ColdRead | undefined => {
  const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname
  if (/^\/api\/repos\/[^/]+\/[^/]+\/first-paint$/.test(path)) return "first-paint"
  if (/^\/api\/repos\/[^/]+\/[^/]+\/role$/.test(path)) return "role"
  const shape = /^\/api\/shapes\/(items|item-summaries|comments)$/.exec(path)
  return shape?.[1] as ColdRead | undefined
}

export interface ColdReadSwitches {
  readonly wait: (read: ColdRead, signal?: AbortSignal) => Promise<void>
  readonly entered: (read: ColdRead) => Promise<void>
  readonly release: (read: ColdRead) => void
  readonly expired: () => ReadonlyArray<ColdRead>
}
export type ColdReadPage = {
  readonly coldReadHolds?: ReadonlyArray<ColdRead>
  coldReads?: ColdReadSwitches
}

/** The inline host and app bundle share switches, even though they load separate copies of this dev-only module. */
export const coldReadsFor = (target: ColdReadPage): ColdReadSwitches => {
  if (target.coldReads !== undefined) return target.coldReads
  const reads = Effect.runSync(ColdReads.make(target.coldReadHolds ?? []))
  return target.coldReads = {
    expired: () => Effect.runSync(reads.expired),
    wait: (read, signal) => Effect.runPromise(reads.wait(read), { signal }),
    entered: (read) => Effect.runPromise(reads.entered(read)),
    release: (read) => Effect.runSync(reads.release(read)),
  }
}

/** Pass as the injected fetch capability; never replace window.fetch or intercept browser traffic. */
export const heldFetch = (real: typeof fetch, holds: ColdReadSwitches): typeof fetch => async (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const read = method.toUpperCase() === "GET" ? coldReadOf(input) : undefined
  if (read !== undefined) await holds.wait(read, init?.signal ?? (input instanceof Request ? input.signal : undefined))
  return real(input, init)
}
