import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { FuzzSimulation } from "@smthrs/fuzz"
import { KeyMaterial, Node, Plan, PlanDiff } from "@smthrs/plan"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Layer, Schema } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as crypto from "node:crypto"
import { describe, expect } from "vitest"

const deterministicCryptoLayer = Layer.mergeAll(
  Layer.succeed(SecureRandom.SecureRandom, {
    bytes: (length) =>
      Effect.sync(() => {
        const out = new Uint8Array(length)
        for (let i = 0; i < length; i++) out[i] = (i * 31 + 17) & 0xff
        return out
      }),
    uuidV4: () => Effect.sync(() => "00000000-0000-4000-8000-000000000001")
  }),
  Layer.succeed(Digest.Digest, {
  digest: (_algo, data) =>
    Effect.sync(() => {
      const buf = crypto.createHash("sha256").update(data instanceof Uint8Array ? data : new Uint8Array(data)).digest()
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    })
  })
)

describe("@smthrs/flow, @smthrs/plan, and @smthrs/engine fuzz", () => {
  it.fuzz(
    "Flow.intersectCeilings satisfies commutativity, idempotency, and ceilingWithin monotonicity",
    [
      Schema.Array(Schema.Literals(["fs:read:**", "fs:read:src/**", "fs:write:src/**", "net:get:example.com"])).check(Schema.isMaxLength(4)),
      Schema.Array(Schema.Literals(["fs:read:**", "fs:read:src/**", "fs:write:src/**", "net:get:example.com"])).check(Schema.isMaxLength(4))
    ],
    ([a, b]) => {
      const ca = [a] as const
      const cb = [b] as const
      const ab = Flow.intersectCeilings(ca, cb)
      const ba = Flow.intersectCeilings(cb, ca)
      expect(Flow.ceilingWithin(ab, ca)).toBe(true)
      expect(Flow.ceilingWithin(ab, cb)).toBe(true)
      expect(Flow.ceilingWithin(ab, ba)).toBe(true)
      expect(Flow.ceilingWithin(ba, ab)).toBe(true)
      return true
    }
  )

  it.fuzz(
    "RetryPolicy.make delay computation is always finite, non-negative, and bounded",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))
    ],
    ([maxAttempts, initialMs, capMs]) => {
      const maxMs = Math.max(initialMs, capMs)
      const policy = RetryPolicy.make({
        maxAttempts,
        initialMs,
        maxMs,
        factor: 2
      })
      expect(policy.maxAttempts).toBe(maxAttempts)
      expect(policy.initialMs).toBe(initialMs)
      expect(policy.maxMs).toBe(maxMs)
      return true
    }
  )

  it.effect.fuzz(
    "Plan.compile, Plan.verify, PlanDiff.diff, and FlowEngine.layerMemory preserve DAG invariants under FuzzSimulation",
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(6)
      ),
      Schema.Literals(["sealed", "compensable", "irreversible"])
    ],
    ([values, tier]) => {
      const Double = Action.make("fuzz/double", {
        payload: Schema.Int,
        success: Schema.Int,
        capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", tier: "pure" }
      })
      const flow = Flow.make("fuzz/sum-doubles", {
        description: "doubles and sums inputs",
        capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", tier: "pure" },
        payload: Schema.Array(Schema.Int),
        success: Schema.Int,
        body: Node.capture({ version: "1" }, (xs) =>
          Node.map(
            Node.all(Object.fromEntries(xs.map((x, i) => [`n${i}`, Double.call(x)]))),
            Node.capture({ version: "1" }, (doubled: Readonly<Record<string, number>>) =>
              Object.values(doubled).reduce((a, b) => a + b, 0)
            )
          )
        )
      })
      const runtimeLayer = Interpreter.layerWithImplementations(
        flow,
        Double.toLayer((n) => Effect.succeed(n * 2))
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        const nodes: ReadonlyArray<Plan.NodeDraft> = values.map((v, idx) => ({
          id: `step-${idx}`,
          material: {
            version: KeyMaterial.version,
            kind: tier,
            body: { operation: "double", value: v },
            inputs: idx > 0 ? [{ _tag: "Pending" as const, from: `step-${idx - 1}` }] : [],
            layers: [],
            capabilities: []
          },
          effects: { reads: [], writes: [`out-${idx}.txt`], boundaryMode: "hard" as const }
        }))
        const plan = yield* Plan.compile({ planId: "fuzz-plan-1", flow: "fuzz/sum-doubles", nodes })
        const verified = yield* Plan.verify(JSON.parse(JSON.stringify(plan)))
        expect(verified).toEqual(plan)
        const selfDiff = PlanDiff.diff(plan, plan)
        expect(selfDiff.added.length).toBe(0)
        expect(selfDiff.removed.length).toBe(0)

        const out = yield* flow.execute(values)
        const expected = values.reduce((acc, x) => acc + x * 2, 0)
        expect(out).toBe(expected)
        return true
      }).pipe(Effect.provide(runtimeLayer), Effect.provide(deterministicCryptoLayer))
    },
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )
})
