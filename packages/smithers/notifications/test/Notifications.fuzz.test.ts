import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Inbox } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/notifications Inbox routing & version-ack fuzz invariants", () => {
  it("Inbox.route deduplicates recipients, respects mayRead & muted first-entry precedence, and maps watcher needs_you -> waiting", async () => {
    const userArb = Schema.Literals(["ana", "ben", "cora", "dan"])
    const levelArb = Schema.Literals(["all", "attention", "muted"])
    const stateArb = Schema.Literals(["working", "waiting", "needs_you", "failed", "done"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        launcher: Schema.OptionFromUndefinedOr(userArb),
        state: stateArb,
        watchers: Schema.Array(Schema.Struct({ principal: userArb, level: levelArb })).pipe(
          Schema.check(Schema.isMaxLength(10))
        ),
        blockedUser: Schema.OptionFromUndefinedOr(userArb)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ launcher, state, watchers, blockedUser }) =>
          Effect.sync(() => {
            const launcherId = launcher._tag === "Some" ? launcher.value : undefined
            const blockedId = blockedUser._tag === "Some" ? blockedUser.value : undefined
            const mayRead = (p: string) => p !== blockedId
            const deliveries = Inbox.route({ launcher: launcherId, state, watchers, mayRead })

            // Invariant 1: every recipient appears at most once
            const recipients = deliveries.map((d) => d.recipient)
            if (new Set(recipients).size !== recipients.length) return false

            // Invariant 2: blocked principal NEVER receives a delivery
            if (blockedId !== undefined && recipients.includes(blockedId)) return false

            // Invariant 3: launcher, if present & permitted, is first with mine=true, quiet=false, raw state
            if (launcherId !== undefined && mayRead(launcherId)) {
              const first = deliveries[0]
              if (
                first === undefined || first.recipient !== launcherId || !first.mine || first.quiet ||
                first.state !== state
              ) {
                return false
              }
            }

            // Invariant 4: watchers NEVER get mine=true, NEVER get needs_you, and muted first-entry is excluded
            const firstLevel = new Map<string, Inbox.Level>()
            for (const w of watchers) {
              if (!firstLevel.has(w.principal)) firstLevel.set(w.principal, w.level)
            }
            for (const d of deliveries) {
              if (d.recipient === launcherId) continue
              if (d.mine) return false
              if (d.state === "needs_you") return false
              const lvl = firstLevel.get(d.recipient)
              if (lvl === undefined || lvl === "muted") return false
              if (d.quiet !== (lvl === "attention")) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Inbox.ack is monotonic in version and agrees with isOpen / isUnread / isHidden", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        version: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
        ops: Schema.Array(
          Schema.Struct({
            act: Schema.Literals(["read", "dismiss", "hide"]),
            v: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 25 })))
          })
        ).pipe(Schema.check(Schema.isMaxLength(12)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ version, ops }) =>
          Effect.sync(() => {
            let state: Inbox.Versions = { version, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0 }
            for (const op of ops) {
              const next = Inbox.ack(state, op.act, op.v)
              // Versions NEVER decrease
              if (
                next.readVersion < state.readVersion ||
                next.dismissedVersion < state.dismissedVersion ||
                next.hiddenVersion < state.hiddenVersion
              ) {
                return false
              }
              state = next
              if (Inbox.isUnread(state) !== (state.readVersion < state.version)) return false
              if (Inbox.isOpen(state) !== (state.dismissedVersion < state.version)) return false
              if (Inbox.isHidden(state) !== (state.hiddenVersion >= state.version)) return false
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
