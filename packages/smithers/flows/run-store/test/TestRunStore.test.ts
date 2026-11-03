import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { AttemptStore } from "../src/AttemptStore.vibe"
import { RunStore } from "../src/RunStore.ts"
import * as TestRunStore from "../src/test/TestRunStore.ts"

describe("TestRunStore", () => {
  it.effect("provides migrated run and attempt stores over one in-memory database", () =>
    Effect.gen(function*() {
      const owner = { hostId: "test-host", pid: 1, nonce: "bundle-owner" }
      const attempt = yield* (
        Effect.gen(function*() {
          const runs = yield* RunStore
          const attempts = yield* AttemptStore

          yield* runs.create("bundle-run", "{}")
          const pending = yield* runs.get("bundle-run")
          const snapshot = {
            status: pending.status,
            owner: pending.owner,
            heartbeatAtMs: pending.heartbeatAtMs
          }
          const claim = yield* runs.claim("bundle-run", snapshot, owner, 1)
          if (claim._tag !== "Claimed") {
            return yield* Effect.die(new Error("bundle run claim was lost"))
          }
          yield* runs.activate("bundle-run", owner, claim.claimedAtMs, snapshot)
          yield* attempts.put({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0,
            state: "running",
            startedAtMs: 1,
            meta: { poisonPill: false }
          }, owner)

          return yield* attempts.get({ runId: "bundle-run", stepKeyDigest: "bundle-step", attempt: 0 })
        }).pipe(Effect.provide(TestRunStore.layer), Effect.scoped)
      )

      expect(Option.getOrThrow(attempt).meta).toEqual({ poisonPill: false })
    }))
})
