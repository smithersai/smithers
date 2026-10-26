import { test } from "node:test"
import assert from "node:assert/strict"
import { Linter } from "eslint"
import tseslint from "typescript-eslint"
import { noSharedInflight } from "./eslint.worker-inflight.js"

const lint = (source) => new Linter().verify(source, [{
  languageOptions: { parser: tseslint.parser },
  plugins: { worker: { rules: { io: noSharedInflight } } },
  rules: { "worker/io": "error" },
}])
const bad = [
  'import { Effect } from "effect"; Effect.cachedInvalidateWithTTL(work, "1 minute")',
  'import { ScopedCache } from "effect"; ScopedCache.make({ lookup: read })',
  'import { ScopedCache } from "effect"; ScopedCache.makeWith({ lookup: read })',
  'import { RcMap } from "effect"; RcMap.make({ lookup: read })',
  'import { RcRef } from "effect"; RcRef.make({ acquire: read })',
  'import { Pool } from "effect"; Pool.make({ acquire: read })',
  'import { Pool } from "effect"; Pool.makeWithTTL({ acquire: read })',
  'import { Pool } from "effect"; Pool.makeWithStrategy({ acquire: read })',
  'import * as C from "effect/ScopedCache"; C.makeWith({ lookup: read })',

  'import { Effect } from "effect"; let memo; function configure() { memo = Effect.cached } configure(); memo(work)',

  'import { Effect } from "effect"; const make = () => memo(work); const memo = Effect.cached; make()',
  'import { Effect } from "effect"; const make = () => a(work); const a = b; const b = Effect.cached; make()',
  'import { Effect } from "effect"; let memo; memo = Effect.cached; memo(work)',
  'import { Effect } from "effect"; const { "cached": memo } = Effect; memo(work)',
  'import { Effect } from "effect"; const { cached: memo = other } = Effect; memo(work)',
  'import { Effect } from "effect"; const { ...E } = Effect; E.cached(work)',

  'import { Effect } from "effect"; work.pipe(Effect.cached)',
  'import { Effect } from "effect"; work.pipe(client, Effect.cached)',
  'import { cached } from "effect/Effect"; work.pipe(cached)',
  'import { Effect } from "effect"; Effect.cached(Effect.succeed([,]))',

  'import { Cache } from "effect"; const c = Cache.makeWith(load, {})',
  'import { Cache as C } from "effect"; const layer = Effect.gen(function* () { return yield* C.make({}) })',
  'import { Effect as E } from "effect"; const layer = E.gen(function* () { const memo = yield* E.cached(fetchData); return () => memo })',
  'import { Deferred as D } from "effect"; const d = D.make()',
  'import * as Fx from "effect"; const c = Fx.Cache.makeWith(load, {})',
  'import * as C from "effect/Cache"; C.make({})',
  'import { make as defer } from "effect/Deferred"; defer()',
  'import { Effect } from "effect"; const memo = Effect.cached; memo(fetchData)',
  'import { Effect } from "effect"; const { cached: memo } = Effect; memo(fetchData)',
  'import { Effect } from "effect"; work.pipe(Effect.cached())',
  'import { Effect } from "effect"; Effect.cached(Effect.succeed({ value: fetchData }))',
  'import { Effect } from "effect"; Effect.cached(Effect.succeed({ ...value }))',
  'import { Effect } from "effect"; Effect.cached(Effect.succeed({ [name]: 1 }))',
  'import { Effect } from "effect"; Effect["cached"](work)',
  'import { Effect } from "effect"; Effect.cachedWithTTL(work, "1 minute")',
  'import { Deferred } from "effect"; Deferred.makeUnsafe()',

  // Waiting on another request's permit, latch, queue or pubsub is waiting on its work (2026-10-25 ReadToken).
  'import { Semaphore } from "effect"; const gate = Semaphore.make(1)',
  'import { Semaphore } from "effect"; Semaphore.makeUnsafe(1)',
  'import * as S from "effect/Semaphore"; S.make(1)',
  'import { make as permits } from "effect/Semaphore"; permits(1)',
  'import * as Fx from "effect"; Fx.Semaphore.make(1)',
  'import { Effect, Semaphore } from "effect"; const layer = Effect.gen(function* () { return yield* Semaphore.make(1) })',
  'import { TxSemaphore } from "effect"; TxSemaphore.make(1)',
  'import { Latch } from "effect"; Latch.make()',
  'import { Latch } from "effect"; Latch.makeUnsafe(false)',
  'import { Queue } from "effect"; Queue.make()',
  'import { Queue } from "effect"; Queue.bounded(16)',
  'import { Queue } from "effect"; Queue.unbounded()',
  'import { Queue } from "effect"; Queue.dropping(16)',
  'import { Queue } from "effect"; Queue.sliding(16)',
  'import { Queue } from "effect"; capacity.pipe(Queue.bounded)',
  'import { TxQueue } from "effect"; TxQueue.unbounded()',
  'import { PubSub } from "effect"; PubSub.unbounded()',
  'import { PubSub } from "effect"; PubSub.makeAtomicBounded(8)',
  'import * as P from "effect/PubSub"; P.sliding(8)',
  'import { TxPubSub } from "effect"; TxPubSub.bounded(8)',
  'import { SynchronizedRef } from "effect"; SynchronizedRef.make(0)',
  'import { SubscriptionRef } from "effect"; SubscriptionRef.make(0)',

  // A Ref is safe only while it holds plain values.
  'import { Effect, Ref } from "effect"; Ref.make(Effect.succeed(1))',
  'import { Effect, Ref } from "effect"; Ref.make(Effect.void)',
  'import { Option, Ref } from "effect"; Ref.make(Option.none<Effect.Effect<string>>())',
  'import { Ref } from "effect"; Ref.make<Promise<string> | undefined>(undefined)',
  'import { Ref } from "effect"; Ref.makeUnsafe(new Map<string, Promise<string>>())',
  'import { Ref } from "effect"; Ref.make(new Promise(() => {}))',
  'import { Ref } from "effect"; Ref.make(Promise.resolve(1))',
  'import { Ref } from "effect"; Ref.make({ pending: undefined as Fiber.Fiber<void> | undefined })',
  'import { Option, Ref } from "effect"; Ref.make(Option.some(work as PromiseLike<void>))',
  'import * as R from "effect/Ref"; import { Deferred, Option } from "effect"; R.make(Option.some(Deferred.await(done)))',
  'import { Fiber, Ref as Cell } from "effect"; const gen = function* () { return yield* Cell.make([Fiber.join(fiber)]) }',
]
for (const source of bad) test(`rejects ${source}`, () => {
  assert.equal(lint(source).filter((entry) => entry.ruleId === "worker/io").length, 1)
})
const good = [
  'import { Effect } from "effect"; missing = Effect.succeed',

  'import { Effect } from "effect"; const { cached: { x } } = Effect; x(work)',
  'const value = 1; const alias = value; alias()',
  'let value; value += 1',

  'import { Effect } from "effect"; Effect.cached(Effect.succeed({ value: [1, "ok", null] }))',
  'import { Effect } from "effect"; const c = Effect.succeed(42)',
  'import { Cache } from "effect"; function request(Cache) { return Cache.make() }',
  'const Cache = { make: () => 1 }; Cache.make()',
  'import { Cache } from "other"; Cache.make()',
  'import { DurableDeferred } from "@smthrs/flow"; DurableDeferred.make("persisted", {})',
  'import { Effect } from "effect"; const f = (x) => x; f(1)',
  'import { Schema } from "effect"; const schema = Schema.String',
  'import { Effect } from "effect"; let memo; memo = 1',

  // The read token's shape after the fix: a plain value, minted by each request that finds none.
  'import { Option, Ref } from "effect"; Ref.make(Option.none<GitHub.AppAuth.InstallationToken>())',
  'import { Ref } from "effect"; Ref.make({ token: "", expiresAt: 0 })',
  'import { Ref } from "effect"; Ref.make()',
  'import { Ref } from "effect"; Ref.make(new Map<string, number>())',
  'import { Ref } from "effect"; Ref.make(new (factory())())',
  'import { Ref } from "effect"; Ref.make({ at: Date.now() as number, read: read(), first: values[0], size: other.size })',
  'import { Effect, Ref } from "effect"; Ref.make(() => Effect.succeed(1))',
  'import { Effect, Ref } from "effect"; Effect.gen(function* () { return yield* Ref.make(yield* Effect.succeed(1)) })',
  'import { Ref } from "effect"; async () => Ref.make(await load())',
  'import { Effect, Ref } from "effect"; Effect.flatMap(read, Ref.make)',
  'const Semaphore = { make: () => 1 }; Semaphore.make()',
  'import { Semaphore } from "other"; Semaphore.make(1)',
  'import { Queue } from "effect"; function request(Queue) { return Queue.unbounded() }',
]
for (const source of good) test(`allows ${source}`, () => assert.deepEqual(lint(source), []))
