import { describe, expect, it } from "@effect/vitest"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, owner } from "./CachePolicyFixtures.ts"
import { withCrypto } from "./Sha256.ts"

const otherOwner: Ownership.OwnerId = { hostId: "fixture-host", pid: 17, nonce: "fixture-owner" }

describe("action fixtures", () => {
  it.effect("activates a run with the default owner", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("default-owner")
        const runs = yield* RunStore.RunStore
        expect(yield* runs.get("default-owner")).toMatchObject({ status: "running", owner, claim: null })
      }).pipe(Effect.provide(TestStores.layer()), Effect.scoped)
    ))

  it.effect("preserves the supplied owner and parent", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("parent", otherOwner)
        yield* activate("child", otherOwner, { parentRunId: "parent", claimedAtMs: 0 })
        const runs = yield* RunStore.RunStore
        expect(yield* runs.get("child")).toMatchObject({
          status: "running",
          owner: otherOwner,
          parentRunId: "parent",
          claim: null
        })
      }).pipe(Effect.provide(TestStores.layer()), Effect.scoped)
    ))

  it.effect.each(["claim", "activation"] as const)(
    "refuses to continue after losing %s",
    (stage) =>
      withCrypto(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const runId = `lost-${stage}`
          const exit = yield* activate(runId).pipe(
            Effect.provideService(RunStore.RunStore, {
              ...runs,
              claim: (...args) =>
                Effect.gen(function*() {
                  if (stage === "claim") yield* runs.claim(args[0], args[1], otherOwner, args[3])
                  const claim = yield* runs.claim(...args)
                  if (stage === "activation" && claim._tag === "Claimed") {
                    yield* runs.abandonClaim(args[0], args[2], claim.claimedAtMs)
                  }
                  return claim
                })
            }),
            Effect.exit
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toEqual(new Error(`${stage} lost`))
          expect(yield* runs.get(runId)).toMatchObject({
            status: "pending",
            owner: null,
            claim: stage === "claim" ? otherOwner : null
          })
        }).pipe(Effect.provide(TestStores.layer()), Effect.scoped)
      )
  )
})
