import { Action, Flow } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Context, Effect, Exit, Layer, Logger, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ActionKey from "../src/FlowEngine/ActionKey.ts"
import { withCrypto } from "./Crypto.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261190")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("@smthrs/engine Wave 9 deep ActionKey & cache-key isolation fuzzing", () => {
  it("actionKey preserves determinism across encodings 1..4, isolates declared vs caller keys, partitions cache vs run & boundaries, and reports uncanonicalKey cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        encoding: Schema.Literals([4, 3, 2, 1]),
        keyMode: Schema.Literals(["string", "object", "none"]),
        tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
        withEnv: Schema.Boolean,
        withBoundary: Schema.Boolean,
        ordinal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
        scope: Schema.Literals(["root", "branch-a", "branch-b"]),
        name: Schema.Literals(["step/a", "step/b"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ encoding, keyMode, tier, withEnv, withBoundary, ordinal, scope, name }) =>
          withCrypto(
            Effect.gen(function*() {
              const metadata = withBoundary
                ? { readSet: [{ path: "src/input.ts", digest: "sha256:aaa" }], writeSet: ["out/artifact"], boundaryMode: "hard" }
                : undefined

              const baseAction = {
                name,
                tier,
                idempotencyKey: keyMode === "string"
                  ? "idem-1"
                  : keyMode === "object"
                    ? { custom: "idem-1", nested: { b: 2, a: 1 } }
                    : undefined,
                successSchema: Schema.Struct({ ok: Schema.Boolean }),
                errorSchema: Schema.String,
                annotations: Context.empty(),
                metadata
              } as unknown as Action.AnyWithProps & Pick<Action.Any, "annotations">

              const env = withEnv ? ({ platform: "linux", arch: "x64" } as unknown as Action.CacheEnvironment) : undefined

              const k1 = yield* ActionKey.actionKey(baseAction, "exec-1", ordinal, env, scope, encoding)
              const k2 = yield* ActionKey.actionKey(baseAction, "exec-1", ordinal, env, scope, encoding)
              expect(k1).toBe(k2)

              // Keyed sealed actions MUST isolate declared string keys from caller object keys
              if (tier === "sealed" && keyMode === "string") {
                const spoofed = {
                  ...baseAction,
                  idempotencyKey: { action: name, idempotencyKey: "idem-1" }
                } as unknown as Action.AnyWithProps & Pick<Action.Any, "annotations">
                const kSpoof = yield* ActionKey.actionKey(spoofed, "exec-1", ordinal, env, scope, encoding)
                expect(kSpoof).not.toBe(k1)

                // Cache vs run kind MUST never collide
                const kOtherEnv = yield* ActionKey.actionKey(
                  baseAction,
                  "exec-1",
                  ordinal,
                  withEnv ? undefined : ({ platform: "linux", arch: "x64" } as unknown as Action.CacheEnvironment),
                  scope,
                  encoding
                )
                expect(kOtherEnv).not.toBe(k1)
              }

              // Unkeyed or non-sealed actions MUST vary with ordinal
              if (tier !== "sealed" || keyMode === "none") {
                const kNext = yield* ActionKey.actionKey(baseAction, "exec-1", ordinal + 1, env, scope, encoding)
                expect(kNext).not.toBe(k1)
              }

              // Mutated boundary metadata MUST produce a fresh digest
              if (tier === "sealed" && keyMode !== "none" && withBoundary) {
                const mutatedMeta = { readSet: [{ path: "src/input.ts", digest: "sha256:bbb" }], writeSet: ["out/artifact"], boundaryMode: "hard" }
                const kMut = yield* ActionKey.actionKey(
                  { ...baseAction, metadata: mutatedMeta } as unknown as Action.AnyWithProps & Pick<Action.Any, "annotations">,
                  "exec-1",
                  ordinal,
                  env,
                  scope,
                  encoding
                )
                expect(kMut).not.toBe(k1)
              }

              // ordinalScope determinism
              const os1 = ActionKey.ordinalScope(scope, ordinal)
              const os2 = ActionKey.ordinalScope(scope, ordinal + 1)
              expect(os1).not.toBe(os2)

              // uncanonicalKey wraps SchemaError into Flow.Complete(Exit.die(UncanonicalIdempotencyKey))
              const badDecode = Schema.decodeUnknownExit(Schema.Number)("not-a-number")
              if (Exit.isFailure(badDecode)) {
                const schemaErr = badDecode.cause.reasons[0]
                if (schemaErr && schemaErr._tag === "Fail") {
                  const completed = ActionKey.uncanonicalKey(name, schemaErr.error)
                  expect(completed._tag).toBe("Complete")
                  expect(Exit.isFailure(completed.exit)).toBe(true)
                }
              }
              return true
            }).pipe(Effect.provide(Logger.layer([])))
          ),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)
})
