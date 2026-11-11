import { test } from "node:test"
import assert from "node:assert/strict"
import { Linter } from "eslint"
import { noSharedInflight } from "./eslint.worker-inflight.js"

// Native syntax retains the request-ownership guard.
const vibeParser = await import("vibelang/eslint")
const lintVibe = (source) => new Linter().verify(source, [{
  files: ["**/*.vibe"],
  languageOptions: { parser: vibeParser },
  plugins: { worker: { rules: { io: noSharedInflight } } },
  rules: { "worker/io": "error" },
}], { filename: "worker/request.vibe" })
for (const source of [
  "export const memo = Cache.make({})",
  "export const create = effect { return Cache.make({}) }",
  "export const create = effect () => { return Cache.make({}) }",
  "export const memo = Deferred.makeUnsafe()",
  "export const memo = Queue.unbounded()",
  "export const memo = Effect.cached(work)",
  "export const memo = work |> Effect.cached(%)",
  "export const create = effect () => { return work |> Effect.cached(%) }",
  "export const memo = Ref.make(Fiber.join(fiber))",
  "const C = Cache; export const memo = C.make({})",
  "const { cached: memo } = Effect; export const x = memo(work)",
  "const use = () => memo(work); const memo = Effect.cached; use()",
]) test(`rejects native prelude ${source}`, () => {
  assert.equal(lintVibe(source).filter((entry) => entry.ruleId === "worker/io").length, 1)
})
for (const source of [
  "export const memo = Effect.cached(Effect.succeed({ value: [1, true, null] }))",
  "const Cache = { make: () => 1 }; export const memo = Cache.make()",
  "export function make(Cache: { make(): number }) { return Cache.make() }",
  'import { Cache } from "other"; export const memo = Cache.make()',
  "export const ref = Ref.make({ token: \"ok\" })",
  "export const value = other.make()",
  "export const create = effect () => { const Cache = { make: () => 1 }; return Cache.make() }",
]) test(`allows native values and shadows ${source}`, () => assert.deepEqual(lintVibe(source), []))
