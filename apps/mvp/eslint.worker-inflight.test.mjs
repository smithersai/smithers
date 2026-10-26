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
]
for (const source of good) test(`allows ${source}`, () => assert.deepEqual(lint(source), []))
