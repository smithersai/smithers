import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import { error } from "../src/TimeTravelError.ts"

const boundaryAuthority = {
  owner: { hostId: "test-host", pid: 1, nonce: "test-owner" },
  sourceSeq: 0,
  idempotencyKey: "test-idempotency-key"
} as const

const crossed = (
  status: EffectRecord["status"] = "succeeded"
): EffectRecord => ({
  id: "effect-1",
  kind: "mail.send",
  tier: "irreversible",
  status,
  runId: "run",
  lineageId: "run/root",
  seq: 4,
  input: { to: "person@example.com" },
  // `guard` refuses an irreversible effect without a key, so real evidence
  // always carries one; the handler below requires it.
  idempotencyKey: "send-1",
  residue: "the recipient may retain the message",
  durableBoundary: true,
  providerStream: false
})

const handler = (
  events: Array<string> = []
): EffectHandlerRegistry.Handler => ({
  kind: "mail.send",
  tier: "irreversible",
  requiresIdempotencyKey: true,
  residue: (effect) => effect.residue ?? "mail residue",
  revert: (effect) =>
    Effect.sync(() => {
      events.push(`revert:${effect.id}`)
      return { messageId: "message-1" }
    }),
  rollback: (effect, receipt) =>
    Effect.sync(() => {
      events.push(`rollback:${effect.id}:${String((receipt as { readonly messageId: string }).messageId)}`)
    })
})

describe("EffectHandlerRegistry", () => {
  it.effect("preserves the original action failure when recording its intended boundary fails", () =>
    Effect.gen(function*() {
      const journal = Journal.makeNoop({
        emitDurable: () => Effect.fail(new Journal.JournalError({ code: "unknown", message: "journal offline" }))
      })
      const failure = yield* (
        Effect.flip(
          EffectBoundary.guard({
            id: "emit-failure",
            kind: "mail.send",
            tier: "irreversible",
            runId: "run",
            lineageId: "run/root",
            sourceId: "adapter",
            ...boundaryAuthority,
            metadata: "legacy metadata"
          }, Effect.succeed("never")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))
        )
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "could not record intended boundary for effect emit-failure"
      })
    }))

  it("decodes a complete boundary record, keeps every optional field, and fails closed on a corrupt one", () => {
    const valid = (overrides: Record<string, unknown> = {}): JournalEvent.Entry => ({
      runId: "run" as JournalEvent.RunId,
      seq: 4 as JournalEvent.Seq,
      eventId: "event",
      sourceId: "source" as JournalEvent.SourceId,
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: EffectBoundary.eventType,
      payload: {
        version: 1,
        effect: {
          id: "effect",
          kind: "mail.send",
          tier: "irreversible",
          status: "succeeded",
          runId: "run",
          lineageId: "run/root",
          input: null,
          output: 0,
          cacheKey: "cache",
          changeId: "change",
          idempotencyKey: "key",
          residue: "residue",
          durableBoundary: false,
          providerStream: true,
          attempt: 0,
          nonce: "nonce",
          ...overrides
        }
      },
      meta: {}
    })
    const decoded = Effect.runSync(EffectBoundary.decodeEntry(valid()))

    expect(decoded).toEqual({
      id: "effect",
      kind: "mail.send",
      tier: "irreversible",
      status: "succeeded",
      runId: "run",
      lineageId: "run/root",
      seq: 4,
      input: null,
      output: 0,
      cacheKey: "cache",
      changeId: "change",
      idempotencyKey: "key",
      residue: "residue",
      durableBoundary: false,
      providerStream: true,
      attempt: 0,
      nonce: "nonce"
    })
    for (const tier of ["sealed", "compensable", "irreversible"] as const) {
      for (const status of ["intended", "succeeded", "unknown"] as const) {
        expect(Effect.runSync(EffectBoundary.decodeEntry(valid({ tier, status })))).toMatchObject({ tier, status })
      }
    }
    for (const payload of [null, [], {}, { effect: null }, { effect: {} }]) {
      expect(Effect.runSync(Effect.flip(EffectBoundary.decodeEntry({ ...valid(), payload }))))
        .toMatchObject({ code: "invalid" })
    }
    for (
      const [field, value] of Object.entries({ id: 1, kind: 1, tier: "bad", status: "bad", runId: 1, lineageId: 1 })
    ) {
      expect(Effect.runSync(Effect.flip(EffectBoundary.decodeEntry(valid({ [field]: value })))))
        .toMatchObject({ code: "invalid" })
    }
    expect(Effect.runSync(EffectBoundary.decodeEntry({ ...valid(), eventType: "other" }))).toBeUndefined()
  })

  it("uses durable defaults and folds a legal crossing to its terminal record in sequence order", () => {
    const entry = (seq: number, id: string, status: EffectBoundary.EffectStatus): JournalEvent.Entry => ({
      runId: "run" as JournalEvent.RunId,
      seq: seq as JournalEvent.Seq,
      eventId: String(seq),
      sourceId: "source" as JournalEvent.SourceId,
      sourceSeq: seq as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: EffectBoundary.eventType,
      payload: {
        version: 1,
        effect: { id, kind: "kind", tier: "sealed", status, runId: "run", lineageId: "run/root" }
      },
      meta: {}
    })
    expect(Effect.runSync(EffectBoundary.decodeEntry(entry(1, "a", "intended")))).toMatchObject({
      durableBoundary: true,
      providerStream: false
    })
    // `a` crosses legally: intended, then one terminal. `b` is a terminal a
    // reader paged without its intended, which is still one crossing. The
    // conflicting histories live in BoundaryEvidence.test.ts.
    expect(
      Effect.runSync(EffectBoundary.fromEntries([
        { ...entry(1, "ignored", "intended"), eventType: "other" },
        entry(4, "a", "succeeded"),
        entry(2, "b", "succeeded"),
        entry(3, "a", "intended")
      ]))
    )
      .toEqual([
        expect.objectContaining({ id: "b", seq: 2 }),
        expect.objectContaining({ id: "a", seq: 4, status: "succeeded" })
      ])
  })

  it("fails closed on a malformed known boundary event", () => {
    const failure = Effect.runSync(Effect.flip(EffectBoundary.fromEntries([{
      runId: "run" as JournalEvent.RunId,
      seq: 1 as JournalEvent.Seq,
      eventId: "corrupt",
      sourceId: "source" as JournalEvent.SourceId,
      sourceSeq: 1 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: EffectBoundary.eventType,
      payload: { version: 2, effect: {} },
      meta: {}
    }])))

    expect(failure).toMatchObject({ code: "invalid" })
  })
  it("rejects duplicate stable effect kinds before exposing a registry", () => {
    const failure = Effect.runSync(
      Effect.flip(EffectHandlerRegistry.make([handler(), handler()]))
    )

    expect(failure.code).toBe("unknown")
    expect(failure.message).toContain("already registered")
  })

  it("accepts a contributed handler that omits `requiresIdempotencyKey`", () => {
    // `CompensationHandlers.Handler` leaves the flag optional, and the door
    // used to copy every field across into a second registry-only shape just
    // to apply `?? false`. There is one shape now, so an omitted flag reaches
    // the registry as omitted and reads as "no key required".
    const { requiresIdempotencyKey: _omitted, ...declared } = handler()
    const registry = Effect.runSync(EffectHandlerRegistry.make([declared]))
    const { idempotencyKey: _key, ...keyless } = crossed()

    expect(registry.resolve("mail.send")).toMatchObject({ kind: "mail.send", tier: "irreversible" })
    expect(Effect.runSync(registry.assess(keyless))).toMatchObject({ classification: "revertible" })
  })

  it("blocks unknown completion state with residue disclosure", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const assessment = Effect.runSync(registry.assess(crossed("unknown")))

    expect(assessment).toEqual({
      classification: "blocking",
      reason: "Effect effect-1 has unknown completion state.",
      residue: "the recipient may retain the message"
    })
  })

  it("blocks intended completion evidence before a handler can compensate it", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))

    expect(Effect.runSync(registry.assess(crossed("intended")))).toEqual({
      classification: "blocking",
      reason: "Effect effect-1 has intended completion state.",
      residue: "the recipient may retain the message"
    })
  })

  it("blocks an unregistered effect kind and discloses its recorded residue", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const assessment = Effect.runSync(registry.assess(crossed()))

    expect(assessment).toEqual({
      classification: "blocking",
      reason: "No compensation handler is registered for mail.send.",
      residue: "the recipient may retain the message"
    })
  })

  it("falls back to a generic residue when the effect recorded none", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const { residue: _, ...effect } = crossed()
    const assessment = Effect.runSync(registry.assess(effect))

    expect(assessment.residue).toBe("The mail.send effect remains outside the journal.")
  })

  it("blocks an effect whose handler is registered for a different tier", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const assessment = Effect.runSync(
      registry.assess({ ...crossed(), tier: "compensable" })
    )

    expect(assessment).toMatchObject({
      classification: "blocking",
      reason: "Handler mail.send is registered for irreversible, not compensable."
    })
  })

  it("prefers a handler's own assessment over the default verdict", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        assess: () =>
          Effect.succeed({
            classification: "warning" as const,
            reason: "the provider deduplicates by idempotency key",
            residue: "a duplicate send is a no-op"
          })
      }])
    )

    expect(Effect.runSync(registry.assess(crossed()))).toEqual({
      classification: "warning",
      reason: "the provider deduplicates by idempotency key",
      residue: "a duplicate send is a no-op"
    })
  })

  it("preserves a typed failure from a handler's custom assessment", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        assess: () => Effect.fail(error("unknown", "provider preflight unavailable"))
      }])
    )

    expect(Effect.runSync(Effect.flip(registry.assess(crossed())))).toMatchObject({
      code: "unknown",
      message: "provider preflight unavailable"
    })
  })

  it("fails revert and rollback for an unregistered effect kind", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const revertFailure = Effect.runSync(Effect.flip(registry.revert(crossed())))
    const rollbackFailure = Effect.runSync(
      Effect.flip(registry.rollback({ id: "effect-1:rollback", effect: crossed(), data: {} }))
    )

    for (const failure of [revertFailure, rollbackFailure]) {
      expect(failure).toMatchObject({
        code: "irreversible",
        message: "no compensation handler is registered for effect kind mail.send"
      })
    }
  })

  it("refuses to revert through a handler registered for another tier", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const failure = Effect.runSync(
      Effect.flip(registry.revert({ ...crossed(), tier: "compensable" }))
    )

    expect(failure).toMatchObject({
      code: "irreversible",
      message: "handler mail.send cannot compensate compensable effect effect-1"
    })
  })

  it("normalises handler revert and rollback failures into typed compensation errors", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        revert: () => Effect.fail(error("unknown", "provider timeout")),
        rollback: () => Effect.fail(error("unknown", "provider timeout"))
      }])
    )

    expect(Effect.runSync(Effect.flip(registry.revert(crossed())))).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send could not revert effect-1"
    })
    expect(
      Effect.runSync(
        Effect.flip(registry.rollback({ id: "effect-1:rollback", effect: crossed(), data: {} }))
      )
    ).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send could not roll back compensation for effect-1"
    })
  })

  it("returns a durable rollback receipt and dispatches it to the same handler", () => {
    const events: Array<string> = []
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler(events)]))
    const receipt = Effect.runSync(registry.revert(crossed()))
    Effect.runSync(registry.rollback(receipt))

    expect(receipt).toMatchObject({
      id: "effect-1:rollback",
      effect: { id: "effect-1", kind: "mail.send" },
      data: { messageId: "message-1" }
    })
    expect(events).toEqual([
      "revert:effect-1",
      "rollback:effect-1:message-1"
    ])
  })

  it.effect("provides tier and idempotency metadata through a Layer", () =>
    Effect.gen(function*() {
      const resolved = yield* (
        Effect.gen(function*() {
          const registry = yield* EffectHandlerRegistry.EffectHandlerRegistry
          return registry.resolve("mail.send")
        }).pipe(
          Effect.provide(EffectHandlerRegistry.layer([handler()]))
        )
      )

      expect(resolved).toMatchObject({
        kind: "mail.send",
        tier: "irreversible",
        requiresIdempotencyKey: true
      })
    }))

  it.effect("records intended and succeeded boundary states with additive metadata", () =>
    Effect.gen(function*() {
      const emitted: Array<JournalEvent.Input> = []
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            emitted.push(input)
            return {
              _tag: "Accepted" as const,
              seq: emitted.length as JournalEvent.Seq,
              sourceSeq: emitted.length as JournalEvent.SourceSeq
            }
          })
      })
      const result = yield* (
        EffectBoundary.guard({
          id: "effect-boundary",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter",
          ...boundaryAuthority,
          sourceSeq: 10,
          input: { recipient: "person@example.com" },
          cacheKey: "mail-cache-key",
          changeId: "change-1",
          idempotencyKey: "send-1",
          residue: "message sent",
          durableBoundary: false,
          providerStream: true,
          attempt: 1,
          nonce: "nonce-1",
          metadata: { adapter: "mail" }
        }, Effect.succeed("sent")).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )

      expect(result).toBe("sent")
      expect(emitted.map((input) =>
        (input.payload as {
          readonly effect: { readonly status: string }
        }).effect.status
      )).toEqual(["intended", "succeeded"])
      expect(emitted.map((input) => input.sourceSeq)).toEqual([10, 11])
      expect(emitted[1]?.payload).toMatchObject({
        effect: {
          id: "effect-boundary",
          output: "sent",
          durableBoundary: false,
          providerStream: true
        }
      })
      expect(emitted[1]?.meta).toMatchObject({
        adapter: "mail",
        lineageId: "run/root",
        cacheKey: "mail-cache-key",
        timeTravel: {
          effectId: "effect-boundary",
          status: "succeeded"
        }
      })
    }))

  it.effect("carries non-record metadata under `upstream` and writes no key when a description has none", () =>
    Effect.gen(function*() {
      const emitted: Array<JournalEvent.Input> = []
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            emitted.push(input)
            return {
              _tag: "Accepted" as const,
              seq: emitted.length as JournalEvent.Seq,
              sourceSeq: emitted.length as JournalEvent.SourceSeq
            }
          })
      })
      const boundary = (
        id: string,
        metadata?: unknown
      ) =>
        EffectBoundary.guard({
          id,
          kind: "mail.send",
          tier: "sealed",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter",
          ...boundaryAuthority,
          ...(metadata === undefined ? {} : { metadata })
        }, Effect.succeed("sent")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))

      yield* boundary("string-metadata", "legacy metadata")
      yield* boundary("no-metadata")

      expect(emitted[0]?.meta).toMatchObject({ upstream: "legacy metadata", lineageId: "run/root" })
      // An unset description contributes no key at all: `{ upstream: undefined }`
      // would put a dead key on every boundary entry the engine writes.
      expect(Object.keys(emitted[2]?.meta ?? {})).not.toContain("upstream")
      expect(emitted[2]?.meta).toMatchObject({ lineageId: "run/root" })
    }))

  it.effect("fences the intended append and refuses to re-execute a duplicate boundary", () =>
    Effect.gen(function*() {
      let actionRuns = 0
      const owners: Array<unknown> = []
      const journal = Journal.makeNoop({
        emitDurable: (_input, owner) =>
          Effect.sync(() => {
            owners.push(owner)
            return {
              _tag: "Duplicate" as const,
              seq: 1 as JournalEvent.Seq,
              sourceSeq: 0 as JournalEvent.SourceSeq,
              status: "committed" as const
            }
          })
      })

      const failure = yield* Effect.flip(
        EffectBoundary.guard({
          id: "duplicate-boundary",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter",
          ...boundaryAuthority
        }, Effect.sync(() => ++actionRuns)).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )

      // `already_crossed`, not `busy`: a caller branching on the closed code
      // list has to tell a re-armed effect from a contended run.
      expect(failure).toMatchObject({ code: "already_crossed" })
      expect(actionRuns).toBe(0)
      expect(owners).toEqual([boundaryAuthority.owner])
    }))

  it.effect("rejects invalid and unfenceable boundary descriptions before resolving the journal", () => {
    // A journal that records every touch: the assertion is that validation
    // refuses these descriptions *before* the journal is resolved, so the
    // count must stay zero.
    let emits = 0
    const journal = Journal.makeNoop({
      emitDurable: () =>
        Effect.sync(() => {
          emits += 1
          return {
            _tag: "Accepted" as const,
            seq: 1 as JournalEvent.Seq,
            sourceSeq: 1 as JournalEvent.SourceSeq
          }
        })
    })
    return Effect.gen(function*() {
      const base = {
        id: "invalid-boundary",
        kind: "mail.send",
        tier: "sealed" as const,
        runId: "run",
        lineageId: "run/root",
        sourceId: "adapter",
        owner: boundaryAuthority.owner,
        sourceSeq: boundaryAuthority.sourceSeq
      }

      const malformed = yield* Effect.flip(
        EffectBoundary.guard({ ...base, sourceSeq: -1 }, Effect.void)
      )
      const exhausted = yield* Effect.flip(
        EffectBoundary.guard({ ...base, sourceSeq: Number.MAX_SAFE_INTEGER }, Effect.void)
      )
      const irreversible = yield* Effect.flip(
        EffectBoundary.guard({
          ...base,
          tier: "irreversible"
        }, Effect.void)
      )

      expect(malformed).toMatchObject({ code: "invalid", message: "effect boundary description is invalid" })
      expect(exhausted).toMatchObject({
        code: "invalid",
        message: "effect invalid-boundary has no terminal source sequence"
      })
      expect(irreversible).toMatchObject({
        code: "invalid",
        message: "irreversible effect invalid-boundary requires an idempotency key"
      })
      expect(emits).toBe(0)
    }).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))
  })

  it.effect("reports a succeeded-boundary persistence failure after the action has completed", () =>
    Effect.gen(function*() {
      let actionRuns = 0
      let emits = 0
      const journal = Journal.makeNoop({
        emitDurable: () =>
          Effect.suspend(() => {
            emits += 1
            return emits === 1
              ? Effect.succeed({
                _tag: "Accepted" as const,
                seq: 1 as JournalEvent.Seq,
                sourceSeq: 1 as JournalEvent.SourceSeq
              })
              : Effect.fail(new Journal.JournalError({ code: "unknown", message: "terminal journal failure" }))
          })
      })

      const failure = yield* (
        Effect.flip(
          EffectBoundary.guard({
            id: "terminal-success-failure",
            kind: "mail.send",
            tier: "irreversible",
            runId: "run",
            lineageId: "run/root",
            sourceId: "adapter",
            ...boundaryAuthority
          }, Effect.sync(() => ++actionRuns)).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal))
          )
        )
      )

      expect(actionRuns).toBe(1)
      expect(emits).toBe(2)
      expect(failure).toMatchObject({
        code: "unknown",
        message: "could not record succeeded boundary for effect terminal-success-failure"
      })
    }))

  it.effect("records unknown and preserves the original action failure", () =>
    Effect.gen(function*() {
      const emitted: Array<JournalEvent.Input> = []
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            emitted.push(input)
            return {
              _tag: "Accepted" as const,
              seq: emitted.length as JournalEvent.Seq,
              sourceSeq: emitted.length as JournalEvent.SourceSeq
            }
          })
      })
      const failure = yield* (
        Effect.flip(
          EffectBoundary.guard({
            id: "effect-failed",
            kind: "mail.send",
            tier: "irreversible",
            runId: "run",
            lineageId: "run/root",
            sourceId: "adapter",
            ...boundaryAuthority
          }, Effect.fail("action-failed")).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal))
          )
        )
      )

      expect(failure).toBe("action-failed")
      expect(emitted.map((input) =>
        (input.payload as {
          readonly effect: { readonly status: string }
        }).effect.status
      )).toEqual(["intended", "unknown"])
    }))

  it.effect("records unknown and preserves an action defect as a defect", () =>
    Effect.gen(function*() {
      const emitted: Array<string> = []
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            emitted.push((input.payload as { readonly effect: { readonly status: string } }).effect.status)
            return {
              _tag: "Accepted" as const,
              seq: emitted.length as JournalEvent.Seq,
              sourceSeq: emitted.length as JournalEvent.SourceSeq
            }
          })
      })

      const exit = yield* (
        Effect.exit(
          EffectBoundary.guard({
            id: "effect-defect",
            kind: "mail.send",
            tier: "irreversible",
            runId: "run",
            lineageId: "run/root",
            sourceId: "adapter",
            ...boundaryAuthority
          }, Effect.die("action-defect")).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal))
          )
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const defect = Cause.findDefect(exit.cause)
        expect(Result.isSuccess(defect) ? defect.success : undefined).toBe("action-defect")
      }
      expect(emitted).toEqual(["intended", "unknown"])
    }))

  it.effect("preserves an action failure when recording its unknown boundary also fails", () =>
    Effect.gen(function*() {
      let emits = 0
      const journal = Journal.makeNoop({
        emitDurable: () =>
          Effect.suspend(() => {
            emits += 1
            return emits === 2
              ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "terminal journal failure" }))
              : Effect.succeed({
                _tag: "Accepted" as const,
                seq: emits as JournalEvent.Seq,
                sourceSeq: emits as JournalEvent.SourceSeq
              })
          })
      })

      const failure = yield* (
        Effect.flip(
          EffectBoundary.guard({
            id: "terminal-emit-failure",
            kind: "mail.send",
            tier: "irreversible",
            runId: "run",
            lineageId: "run/root",
            sourceId: "adapter",
            ...boundaryAuthority
          }, Effect.fail("action-failed")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))
        )
      )

      expect(failure).toBe("action-failed")
      expect(emits).toBe(2)
    }))

  it.effect("settles an interrupted action as unknown before the fiber exits", () =>
    Effect.gen(function*() {
      const emitted: Array<string> = []
      const entered = Effect.runSync(Deferred.make<void>())
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            emitted.push((input.payload as { readonly effect: { readonly status: string } }).effect.status)
            return {
              _tag: "Accepted" as const,
              seq: emitted.length as JournalEvent.Seq,
              sourceSeq: emitted.length as JournalEvent.SourceSeq
            }
          })
      })
      const fiber = Effect.runFork(
        EffectBoundary.guard({
          id: "interrupted",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter",
          ...boundaryAuthority
        }, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )

      yield* (Deferred.await(entered))
      yield* (Fiber.interrupt(fiber))
      const exit = yield* (Fiber.await(fiber))

      expect(exit._tag).toBe("Failure")
      expect(emitted).toEqual(["intended", "unknown"])
    }))
})

/**
 * The handler safety contract, enforced before a rewind acts on a verdict.
 *
 * A rewind truncates the evidence of every effect it crosses, so a verdict
 * that let an effect through unreverted was unrecoverable: the registry now
 * decodes what a handler returns, resolves by the compensation descriptor the
 * producer recorded, and refuses the key and tier drifts that a handler swapped
 * in after a restart would otherwise slip past.
 */
describe("EffectHandlerRegistry safety", () => {
  const withCompensation = (compensation: string | undefined): EffectHandlerRegistry.Handler => ({
    ...handler(),
    ...(compensation === undefined ? {} : { compensation })
  })

  it("blocks a custom assessment that does not decode instead of trusting it", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        assess: () => Effect.succeed({ classification: "reverted", reason: 1 } as never)
      }])
    )

    expect(Effect.runSync(registry.assess(crossed()))).toEqual({
      classification: "blocking",
      reason: expect.stringContaining("Handler mail.send returned a malformed assessment"),
      residue: "the recipient may retain the message"
    })
  })

  it("blocks and refuses to revert an effect that recorded no idempotency key the handler requires", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const { idempotencyKey: _, ...keyless } = crossed()

    expect(Effect.runSync(registry.assess(keyless))).toEqual({
      classification: "blocking",
      reason: "Effect effect-1 recorded no idempotency key, which handler mail.send requires.",
      residue: "the recipient may retain the message"
    })
    expect(Effect.runSync(Effect.flip(registry.revert(keyless)))).toMatchObject({
      code: "irreversible",
      message: "handler mail.send cannot compensate effect-1: Effect effect-1 recorded no idempotency key, " +
        "which handler mail.send requires."
    })
    // The flag off: the same keyless evidence resolves normally.
    const lenient = Effect.runSync(
      EffectHandlerRegistry.make([{ ...handler(), requiresIdempotencyKey: false }])
    )
    expect(Effect.runSync(lenient.assess(keyless)).classification).toBe("revertible")
  })

  it("resolves by the recorded compensation descriptor, never by kind alone", () => {
    const recorded = { ...crossed(), compensation: "mail/refund/v1" }
    const receipt = { id: "effect-1:rollback", effect: recorded, data: {} }

    // A handler that declares no descriptor does not own evidence that
    // recorded one: a restart replaced the adapter.
    const undeclared = Effect.runSync(EffectHandlerRegistry.make([withCompensation(undefined)]))
    expect(Effect.runSync(undeclared.assess(recorded))).toMatchObject({
      classification: "blocking",
      reason: "Effect effect-1 recorded compensation mail/refund/v1, which handler mail.send does not declare."
    })
    expect(Effect.runSync(Effect.flip(undeclared.revert(recorded)))).toMatchObject({ code: "irreversible" })
    expect(Effect.runSync(Effect.flip(undeclared.rollback(receipt)))).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send cannot roll back effect-1: Effect effect-1 recorded compensation " +
        "mail/refund/v1, which handler mail.send does not declare."
    })

    // A handler declaring another descriptor is another implementation.
    const other = Effect.runSync(EffectHandlerRegistry.make([withCompensation("mail/refund/v2")]))
    expect(Effect.runSync(other.assess(recorded))).toMatchObject({
      classification: "blocking",
      reason: "Effect effect-1 recorded compensation mail/refund/v1, but handler mail.send implements mail/refund/v2."
    })
    expect(Effect.runSync(Effect.flip(other.rollback(receipt)))).toMatchObject({ code: "compensation_failed" })

    // The declaring handler owns it, and evidence that recorded no descriptor
    // still resolves by kind, because its producer had nothing more to say.
    const events: Array<string> = []
    const owning = Effect.runSync(EffectHandlerRegistry.make([{ ...handler(events), compensation: "mail/refund/v1" }]))
    expect(Effect.runSync(owning.assess(recorded)).classification).toBe("revertible")
    expect(Effect.runSync(owning.assess(crossed())).classification).toBe("revertible")
    Effect.runSync(owning.rollback(Effect.runSync(owning.revert(recorded))))
    expect(events).toEqual(["revert:effect-1", "rollback:effect-1:message-1"])
  })

  it("refuses to roll a receipt back through a handler registered for another tier", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const failure = Effect.runSync(
      Effect.flip(registry.rollback({
        id: "effect-1:rollback",
        effect: { ...crossed(), tier: "compensable" },
        data: {}
      }))
    )

    expect(failure).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send cannot roll back effect-1: handler mail.send is registered for irreversible, " +
        "and the receipt records compensable"
    })
  })

  it("refuses a declaration it could not resolve safely, at construction and at registration", () => {
    const malformed: ReadonlyArray<EffectHandlerRegistry.Handler> = [
      { ...handler(), kind: "" },
      { ...handler(), tier: "durable" as never },
      { ...handler(), requiresIdempotencyKey: "yes" as never },
      { ...handler(), compensation: "" },
      { ...handler(), rollback: undefined as never }
    ]

    for (const declaration of malformed) {
      expect(Effect.runSync(Effect.flip(EffectHandlerRegistry.make([declaration])))).toMatchObject({
        code: "invalid"
      })
    }
    expect(Effect.runSync(Effect.flip(EffectHandlerRegistry.make([{ ...handler(), rollback: undefined as never }]))))
      .toMatchObject({ message: "effect handler mail.send has no rollback function" })
  })
})
