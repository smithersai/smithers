import { repoId } from "../repo/contract"
import { Clock, Effect, Fiber, Metric, Result, SubscriptionRef } from "effect"
import { runners } from "../../boundary"
import type { IssuesClient, SearchNotAnswered } from "./api"
import type { ListedIssue } from "./schema"
import type { FirstPaintIssue } from "./contract"

/** The first paint's input and its gated, transient output. */
export interface EarlySearchHost {
  readonly show?: (owner: string, name: string, q: string, issues: ReadonlyArray<FirstPaintIssue> | undefined) => void
  readonly bind: (ask: (owner: string, name: string, q: string) => void, forget: () => void) => () => void
}

export interface EarlyRead {
  readonly owner: string
  readonly name: string
  readonly q: string
  readonly answer: Effect.Effect<ReadonlyArray<ListedIssue>, SearchNotAnswered>
  readonly current: () => boolean
  readonly revoke: () => void
}

const reads = Metric.counter("issues_early_search_reads", { description: "Searches started before application services, by outcome" })

/**
 * One in-flight early read, consumed once by the ordinary search action. No collection receives it here. Its
 * publisher joins the same data gate before handing rows to the shell; the ordinary action still checks authority.
 * Replacement, revocation/navigation, a 15-second cap and scope close drop the read and its publication.
 */
export const earlySearch = (search: IssuesClient["Service"]["search"], host: EarlySearchHost) => Effect.gen(function* () {
  const scope = yield* Effect.scope
  const run = runners(yield* Effect.context<never>(), "issues")
  type Answer = Effect.Success<ReturnType<typeof search>>
  type Failure = Effect.Error<ReturnType<typeof search>>
  let held: { readonly key: string; readonly generation: number; readonly fiber: Fiber.Fiber<Result.Result<Answer, Failure>>; revoked: boolean } | undefined
  let generation = 0
  const pending = yield* SubscriptionRef.make<EarlyRead | undefined>(undefined)
  const keyOf = (owner: string, name: string, q: string) => JSON.stringify([owner.toLowerCase(), name.toLowerCase(), q.trim()])
  const forget = Effect.gen(function* () {
    yield* Effect.logInfo("issues.search.early").pipe(Effect.annotateLogs({ phase: "forgotten" }))
    const active = yield* SubscriptionRef.get(pending)
    active?.revoke()
    generation++
    yield* SubscriptionRef.set(pending, undefined)
    const previous = held
    held = undefined
    if (previous !== undefined) yield* Fiber.interrupt(previous.fiber)
  })
  const ask = (owner: string, name: string, q: string) => Effect.gen(function* () {
    yield* Effect.logInfo("issues.search.early").pipe(Effect.annotateLogs({ phase: "asked" }))
    const current = ++generation
    const active = yield* SubscriptionRef.get(pending)
    active?.revoke()
    yield* SubscriptionRef.set(pending, undefined)
    const previous = held
    held = undefined
    if (previous !== undefined) yield* Fiber.interrupt(previous.fiber)
    if (current !== generation) return
    const asked = q.trim()
    if (asked === "") return
    const fiber = yield* Effect.gen(function* () {
      yield* Effect.sleep("150 millis")
      const started = yield* Clock.currentTimeMillis
      const answer = yield* Effect.result(search(owner, name, asked))
      const outcome = Result.isSuccess(answer) ? "answered" : "failed"
      yield* Metric.update(Metric.withAttributes(reads, { outcome }), 1)
      yield* Effect.logInfo("issues.search.early").pipe(Effect.annotateLogs({
        feature: "issues", outcome, durationMs: (yield* Clock.currentTimeMillis) - started,
      }))
      return answer
    }).pipe(Effect.withSpan("issues.search.early"), Effect.forkIn(scope, { startImmediately: true }))
    const entry = { key: keyOf(owner, name, asked), generation: current, fiber, revoked: false }
    held = entry
    yield* SubscriptionRef.set(pending, {
      owner, name, q: asked, current: () => generation === current && !entry.revoked, revoke: () => { entry.revoked = true },
      answer: Fiber.join(fiber).pipe(Effect.flatMap(Result.match({ onSuccess: Effect.succeed, onFailure: Effect.fail }))),
    })
    yield* Effect.sleep("15 seconds").pipe(
      Effect.andThen(Effect.suspend(() => generation === current ? forget : Effect.void)),
      Effect.forkIn(scope),
    )
  })
  yield* Effect.logInfo("issues.search.early").pipe(Effect.annotateLogs({ phase: "bound" }))
  yield* Effect.acquireRelease(
    Effect.sync(() => host.bind((owner, name, q) => { run.runFork(ask(owner, name, q)) }, () => { run.runFork(forget) })),
    (unbind) => Effect.sync(unbind).pipe(Effect.andThen(forget)),
  )
  const read: IssuesClient["Service"]["search"] = (owner, name, q, number) => Effect.suspend(() => {
    // A list page is not an exact issue answer: the target may be on a later page. Navigation also revokes
    // the list's publisher, including an answer already claimed by its ordinary consumer.
    if (number !== undefined) return forget.pipe(Effect.andThen(search(owner, name, q, number)))
    const entry = held
    if (entry === undefined) return search(owner, name, q)
    if (entry.revoked || entry.key !== keyOf(owner, name, q)) return forget.pipe(Effect.andThen(search(owner, name, q)))
    held = undefined
    return Effect.logInfo("issues.search.early").pipe(
      Effect.annotateLogs({ phase: "consumed" }),
      Effect.andThen(Fiber.join(entry.fiber)),
      // The gate can revoke an answer after this consumer claimed it but before its HTTP body finished.
      Effect.flatMap(answer => entry.generation !== generation || entry.revoked ? search(owner, name, q) : Result.match({ onSuccess: Effect.succeed, onFailure: Effect.fail })(answer)),
    )
  })
  return Object.assign(read, { pending })
})


/** The authoritative list arrived: revoke only that repository's early answer before it can stand in again. */
export const finishEarlySearch = (pending: SubscriptionRef.SubscriptionRef<EarlyRead | undefined> | undefined, id: string) => Effect.gen(function* () {
  if (pending === undefined) return
  const read = yield* SubscriptionRef.get(pending)
  if (read === undefined || repoId(read.owner, read.name) !== id) return
  read.revoke()
  yield* SubscriptionRef.set(pending, undefined)
})
