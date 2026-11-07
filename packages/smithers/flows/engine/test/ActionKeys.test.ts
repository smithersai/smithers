import { describe, expect, it } from "@effect/vitest"
import { Sha256 } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { DerivedKey } from "@smthrs/keys"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schedule, Schema, Scope, Tracer } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import { vi } from "vitest"
import { actionKey } from "../src/FlowEngine/ActionKey.ts"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

vi.mock("effect/SchemaRepresentation", { spy: true })

const hostFlow = Flow.make("ActionKeys/host", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const provideHost = <A, E>(
  self: Effect.Effect<
    A,
    E,
    (EffectDigest.Digest | SecureRandom.SecureRandom) | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Scope.Scope
  >
): Effect.Effect<A, E, (EffectDigest.Digest | SecureRandom.SecureRandom)> =>
  self.pipe(
    Effect.scoped,
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(hostFlow, "host-run")
    ),
    Effect.provide(FlowEngine.layerMemory)
  )

describe("action execution keys", () => {
  effect("pins the compact declaration digest in a run-scoped string key", () =>
    Effect.gen(function*() {
      const action = Action.make({
        name: "ActionKeys/fixture",
        success: Schema.String,
        idempotencyKey: "row",
        execute: Effect.succeed("ok")
      })
      // Encodings 1 and 2, written before keys named their encoding, never
      // change: recorded runs are found under them. They agree for a
      // declaration with no brand.
      expect(yield* actionKey(action, "run", 1, undefined, "scope", 1))
        .toBe("key1_5ba06eea63e4a5187bb73bb4ea7951e5048014dd09e18c33d7408b80dc4bc124")
      expect(yield* actionKey(action, "run", 1, undefined, "scope", 2))
        .toBe("key1_5ba06eea63e4a5187bb73bb4ea7951e5048014dd09e18c33d7408b80dc4bc124")
      // Encoding 3 names itself, so its bytes differ, and new records are written under it by default.
      const current = yield* actionKey(action, "run", 1, undefined, "scope")
      expect(current).toBe(yield* actionKey(action, "run", 1, undefined, "scope", 3))
      expect(current).toBe("key1_e61fb72d3a7a261dd0ae28244d4893a2b4676d011fcf640b0ab853c4e4323692")
    }))

  effect(
    "keeps the rc.115 key for a declaration whose checks effect renamed after rc.115",
    () =>
      Effect.gen(function*() {
        // effect@4.0.4 renamed isStartsWith, isLengthBetween and isIncludes (and
        // three more) in the representation it encodes. The declaration digest
        // must not move with the installed release, or every recorded sealed
        // step behind such a schema re-keys. The literal is the key this action
        // derived on effect@4.0.0-rc.115.
        const action = Action.make({
          name: "ActionKeys/renamed-checks",
          success: Schema.String.check(Schema.isStartingWith("ord-")),
          error: Schema.Struct({
            ids: Schema.Array(Schema.String).check(Schema.isBetweenLength(1, 3)),
            note: Schema.String.check(Schema.isIncluding("x"))
          }),
          idempotencyKey: "row",
          execute: Effect.succeed("ord-1")
        })
        expect(yield* actionKey(action, "run", 1, undefined, "scope", 1))
          .toBe("key1_840e188c5c26df4ba4b9cdfd7b5a8e543e28524b31840a8fae11529e63fc2f84")
      })
  )

  effect(
    "derives a branded declaration's rc.115 key at encoding 1, because effect@4.0.4 dropped brands from the AST",
    () =>
      Effect.gen(function*() {
        // Under effect@4.0.0-rc.115 `Schema.brand` wrote a `brands` annotation
        // into the representation; from 4.0.4 on a brand is not part of the AST.
        // Encoding 2 (the current one) hashes the brandless document; encoding 1
        // restores the brand from the schema value and derives the key rc.115
        // wrote, so a record written then is found again. In this repository
        // that covers three build install declarations, all through
        // `Sha256.Digest`: `smithers-build/install`, `install/link` and
        // `install/fetch/pnpm`. This pins both keys.
        const rc115 = {
          representation: {
            _tag: "String",
            checks: [{
              _tag: "Filter",
              representation: { id: "effect/schema/isPattern", payload: { source: "^[0-9a-f]{64}$", flags: "" } },
              annotations: {
                expected: "a 64-character lowercase hexadecimal SHA-256 digest",
                arbitraryConstraint: { patterns: [{ source: "^[0-9a-f]{64}$", flags: "" }] },
                brands: ["@smthrs/crypto/Sha256/Digest"]
              },
              aborted: false
            }]
          },
          references: {}
        }
        const { brands: _brands, ...annotations } = rc115.representation.checks[0]!.annotations
        expect(JSON.stringify(Node.representationIdentity(Sha256.Digest))).toBe(JSON.stringify({
          ...rc115,
          representation: { ...rc115.representation, checks: [{ ...rc115.representation.checks[0]!, annotations }] }
        }))
        expect(JSON.stringify(Node.representationIdentity(Sha256.Digest, 1))).toBe(JSON.stringify(rc115))
        const action = Action.make({
          name: "ActionKeys/branded",
          success: Schema.Struct({ store: Sha256.Digest }),
          idempotencyKey: "row",
          execute: Effect.die("unused")
        })
        // The key this action derived on rc.115, and the one it derives now.
        expect(FlowEngine.keyEncodings).toEqual([3, 2, 1])
        expect(yield* actionKey(action, "run", 1, undefined, "scope", 1))
          .toBe("key1_74c8862a35bde5cafe29effa5914ea0bf56540df0b3920271a603bebdcf1608a")
        expect(yield* actionKey(action, "run", 1, undefined, "scope", 2))
          .toBe("key1_690b4cf451009c72a16a06e4f3df233b7c3ed88c9b7b8171be68a15da7ef7752")
        // A declaration whose shared definition is branded at one position and
        // not at another has no rc.115 document version 1 can print, so it
        // derives no older key: none that could be another declaration's.
        const Name = Schema.String.annotate({ identifier: "ActionKeys/Name" })
        const keyed = (success: Schema.Top) =>
          Action.make({ name: "ActionKeys/shared", success, idempotencyKey: "row", execute: Effect.die("unused") })
        const alike = keyed(Schema.Struct({ a: Name.pipe(Schema.brand("A")), b: Name.pipe(Schema.brand("A")) }))
        const mixed = keyed(Schema.Struct({ a: Name.pipe(Schema.brand("A")), b: Name }))
        expect(yield* actionKey(mixed, "run", 1, undefined, "scope", 1))
          .toBe(yield* actionKey(mixed, "run", 1, undefined, "scope", 2))
        expect(yield* actionKey(mixed, "run", 1, undefined, "scope", 1))
          .not.toBe(yield* actionKey(alike, "run", 1, undefined, "scope", 1))
        // A brandless declaration derives one key under both encodings.
        const plain = Action.make({
          name: "ActionKeys/branded",
          success: Schema.Struct({ store: Schema.String }),
          idempotencyKey: "row",
          execute: Effect.die("unused")
        })
        expect(yield* actionKey(plain, "run", 1, undefined, "scope", 1))
          .toBe(yield* actionKey(plain, "run", 1, undefined, "scope", 2))
      })
  )

  effect("memoizes declaration digests by both schema ASTs across action instances", () =>
    Effect.gen(function*() {
      const success = Schema.Struct({ value: Schema.String })
      const error = Schema.Struct({ reason: Schema.String })
      const make = () =>
        Action.make({
          name: "ActionKeys/memoized",
          success,
          error,
          idempotencyKey: "row",
          execute: Effect.succeed({ value: "ok" })
        })
      const representation = vi.spyOn(SchemaRepresentation, "toRepresentation")
      try {
        const first = yield* actionKey(make(), "run", 1, undefined, "scope")
        const calls = representation.mock.calls.length
        expect(calls).toBeGreaterThan(0)
        expect(yield* actionKey(make(), "run", 2, undefined, "scope")).toBe(first)
        expect(representation.mock.calls.length).toBe(calls)
      } finally {
        representation.mockRestore()
      }
    }))

  effect("does not create a named actionKey span on repeated dispatch", () => {
    const spans: Array<string> = []
    const tracer = Tracer.make({
      span(options) {
        spans.push(options.name)
        return new Tracer.NativeSpan(options)
      }
    })
    const action = Action.make({
      name: "ActionKeys/untraced",
      success: Schema.Void,
      idempotencyKey: "row",
      execute: Effect.void
    })
    return Effect.gen(function*() {
      yield* action
      yield* action
      expect(spans).toContain("caller")
      expect(spans).not.toContain("FlowEngine.actionKey")
    }).pipe(provideHost, Effect.withSpan("caller"), Effect.withTracer(tracer))
  })

  effect("namespaces string idempotency keys by action name so distinct actions never collide", () => {
    // Issue #9: `chargeCard` and `sendEmail` both declaring
    // `idempotencyKey: "order-123"` must NOT share a step key — otherwise the
    // second replays the first's persisted outcome against the wrong schema.
    let charges = 0
    let emails = 0
    const chargeCard = Action.make({
      name: "ActionKeys/chargeCard",
      success: Schema.Number,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        charges++
        return 42
      })
    })
    const sendEmail = Action.make({
      name: "ActionKeys/sendEmail",
      success: Schema.String,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        emails++
        return "sent"
      })
    })
    const flowActionDeclaration = Action.make("ActionKeys/no-collision/action", {
      payload: { run: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("ActionKeys/no-collision", {
      payload: { run: Schema.String },
      success: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const amount = yield* chargeCard
          const receipt = yield* sendEmail
          return `${amount}:${receipt}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe("42:sent")
      expect(charges).toBe(1)
      expect(emails).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("replays the same action's string idempotency key across attempts", () => {
    let executions = 0
    const action = () =>
      Action.make({
        name: "ActionKeys/stable",
        success: Schema.Number,
        idempotencyKey: "sealed/caller-key",
        execute: Effect.sync(() => ++executions)
      })
    const flowActionDeclaration = Action.make("ActionKeys/replay/action", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("ActionKeys/replay", {
      payload: { run: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.andThen(action(), action())),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("folds declared output nondeterminism into the sealed action key", () => {
    let executions = 0
    const action = (nondeterministic?: true) =>
      Action.make({
        name: "ActionKeys/nondeterministic",
        success: Schema.Number,
        idempotencyKey: "shared",
        ...(nondeterministic === undefined ? {} : { nondeterministic }),
        execute: Effect.sync(() => ++executions)
      })
    const flowActionDeclaration = Action.make("ActionKeys/nondeterministic/action", {
      payload: {},
      success: Schema.Number
    })
    const flow = Flow.make("ActionKeys/nondeterministic/flow", {
      payload: {},
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          expect(yield* action()).toBe(1)
          expect(yield* action(true)).toBe(2)
          return yield* action(true)
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({}, { executionId: "nondeterministic-key" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("folds the boundary descriptor into string idempotency keys so a changed read set misses (issue #25)", () => {
    // Skyframe's dirty→recheck→rebuild collapses to key-based invalidation
    // here: the hermetic descriptor (readSet digests, writeSet,
    // boundaryMode) is part of the cache key, so an action whose
    // declared inputs changed can never replay the stale cached result.
    let executions = 0
    const build = (digest: string) =>
      Action.make({
        name: "ActionKeys/build",
        success: Schema.Number,
        idempotencyKey: "v1",
        metadata: {
          readSet: [{ path: "src/input.ts", digest }],
          writeSet: ["out/artifact"],
          boundaryMode: "hard"
        },
        execute: Effect.sync(() => ++executions)
      })
    const flowActionDeclaration = Action.make("ActionKeys/boundary-invalidation/action", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("ActionKeys/boundary-invalidation", {
      payload: { run: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          // Same digest replays; the changed digest must re-execute.
          yield* build("d1")
          yield* build("d1")
          return yield* build("d2")
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-boundary" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("keeps object identity caller-owned so replay survives an action rename", () => {
    // The object-form idempotencyKey is the escape hatch for rename-stable
    // identity: the caller owns the full key input, so the action name
    // intentionally does not enter the digest.
    let executions = 0
    const identity = {
      operation: "sealed/caller-owned"
    }
    const first = Action.make({
      name: "ActionKeys/first-name",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const renamed = Action.make({
      name: "ActionKeys/renamed",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const flowActionDeclaration = Action.make("ActionKeys/rename-stable/action", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("ActionKeys/rename-stable", {
      payload: { run: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.andThen(first, renamed)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect(
    "folds the boundary descriptor into object-form keys so the rename-stable escape hatch cannot bypass invalidation (issue #57)",
    () => {
      // A caller-owned object, on a sealed
      // action declaring a hard boundary descriptor, must still fold the
      // read-set material into the key: otherwise a changed read-set digest
      // replays the stale cross-run cache entry #25 was filed for.
      let executions = 0
      const identity = {
        operation: "sealed/boundary-escape-hatch"
      }
      const build = (digest: string) =>
        Action.make({
          name: "ActionKeys/object-boundary",
          success: Schema.Number,
          idempotencyKey: identity,
          metadata: {
            readSet: [{ path: "src/input.ts", digest }],
            writeSet: ["out/artifact"],
            boundaryMode: "hard"
          },
          execute: Effect.sync(() => ++executions)
        })
      const flowActionDeclaration = Action.make("ActionKeys/object-boundary-invalidation/action", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const flow = Flow.make("ActionKeys/object-boundary-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number,
        body: (payload) => flowActionDeclaration.call(payload)
      })
      const layer = Layer.mergeAll(
        flowActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            // Same digest replays; the changed digest must re-execute.
            yield* build("d1")
            yield* build("d1")
            return yield* build("d2")
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-object-boundary" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect(
    "overrides a caller-pinned stale hermetic with the metadata descriptor so the read-set change still misses (issue #83)",
    () => {
      // Issue #57's mechanism is spread order alone: the descriptor derived
      // from `action.metadata` must win over a `boundary` the caller
      // pinned inside the object-form identity. This is the
      // caller-supplies case the #57 test never covered — a refactor that
      // spread the caller's field last (`{ boundary, ...identity }`) would
      // freeze the key on the pinned digest and restore the #25 stale-replay
      // bypass.
      let executions = 0
      const identity = { operation: "sealed/pinned-hermetic" }
      const build = (digest: string) =>
        Action.make({
          name: "ActionKeys/pinned-hermetic",
          success: Schema.Number,
          idempotencyKey: identity,
          metadata: {
            readSet: [{ path: "src/input.ts", digest }],
            writeSet: ["out/artifact"],
            boundaryMode: "hard"
          },
          execute: Effect.sync(() => ++executions)
        })
      const flowActionDeclaration = Action.make("ActionKeys/pinned-hermetic-invalidation/action", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const flow = Flow.make("ActionKeys/pinned-hermetic-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number,
        body: (payload) => flowActionDeclaration.call(payload)
      })
      const layer = Layer.mergeAll(
        flowActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            // The pinned "frozen" digest never enters the key: same metadata
            // digest replays, the changed digest re-executes.
            yield* build("d1")
            yield* build("d1")
            return yield* build("d2")
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-pinned-hermetic" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect("folds the declared schemas into string idempotency keys so a schema change misses (issue #120)", () => {
    // The step-key spec requires the content body to be the *compiled
    // declaration* — schemas and combinators applied. Folding only
    // `{action, idempotencyKey}` let an action whose success schema
    // changed keep its old key, replaying a stale cached row decoded under
    // the new schema.
    let executions = 0
    const v1 = Action.make({
      name: "ActionKeys/schema-change",
      success: Schema.Struct({ a: Schema.Number }),
      idempotencyKey: "row",
      execute: Effect.sync(() => {
        executions++
        return { a: 1 }
      })
    })
    const v2 = Action.make({
      name: "ActionKeys/schema-change",
      success: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
      idempotencyKey: "row",
      execute: Effect.sync(() => {
        executions++
        return { a: 1, b: 2 }
      })
    })
    const flowActionDeclaration = Action.make("ActionKeys/schema-invalidation/action", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("ActionKeys/schema-invalidation", {
      payload: { run: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          // Same declaration replays; the changed success schema must miss and
          // re-execute rather than decode v1's cached row as v2's shape.
          yield* v1
          yield* v1
          const out = yield* v2
          return out.b
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-schema-change" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect(
    "folds the declared error schema into string idempotency keys so an error-schema change misses (issue #136)",
    () => {
      // `declarationDigest` folds BOTH declared schemas; the #120 regression
      // test varied only the success schema, so dropping the error term kept
      // the suite green while an action whose error schema changed replayed
      // a stale row decoded under the new error type. This cell pins the
      // error-schema axis: identical success schema and idempotencyKey, only
      // the error schema differs, and the second declaration must re-execute.
      let executions = 0
      const make = <Error extends Schema.Constraint>(error: Error) =>
        Action.make({
          name: "ActionKeys/error-schema-change",
          success: Schema.Struct({ a: Schema.Number }),
          error,
          idempotencyKey: "row",
          execute: Effect.sync(() => {
            executions++
            return { a: executions }
          })
        })
      const v1 = make(Schema.Struct({ reason: Schema.String }))
      const v2 = make(Schema.Struct({ reason: Schema.String, retriable: Schema.Boolean }))
      const flowActionDeclaration = Action.make("ActionKeys/error-schema-invalidation/action", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const flow = Flow.make("ActionKeys/error-schema-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number,
        body: (payload) => flowActionDeclaration.call(payload)
      })
      const layer = Layer.mergeAll(
        flowActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            // Same declaration replays; the changed error schema must miss and
            // re-execute rather than replay v1's cached row under v2's key.
            // The declared errors are unreachable here — `execute` only succeeds —
            // so die on them to keep the flow's declared error channel empty.
            yield* Effect.orDie(v1)
            yield* Effect.orDie(v1)
            const out = yield* Effect.orDie(v2)
            return out.a
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-error-schema-change" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect("distinguishes a caller object that spells the string form's encoding (B3)", () =>
    Effect.gen(function*() {
      // The string form builds `{action, idempotencyKey, declaration}` and the
      // object form uses the caller's object verbatim. With no tag naming which
      // form produced the input, a caller object that spells the string form's
      // encoding — the shape a caller reaches for when copying the engine's own
      // encoding to get a rename-stable key — digested byte-identically, shared
      // one attempt row and one cache row, and replayed the string form's
      // recorded outcome under its own schema. This is the fourth corner of the
      // suite: name namespacing, schema folding, and rename stability are
      // already covered above.
      let declaredRuns = 0
      let spelledRuns = 0
      const success = Schema.String
      const declaration = yield* Schema.decodeUnknownEffect(DerivedKey)({
        success: Node.representationIdentity(success),
        error: Node.representationIdentity(Schema.Never)
      })
      const declared = Action.make({
        name: "ActionKeys/charge",
        success,
        idempotencyKey: "order-7",
        execute: Effect.sync(() => {
          declaredRuns++
          return "declared"
        })
      })
      const spelled = Action.make({
        name: "ActionKeys/spells-the-string-form",
        success,
        idempotencyKey: {
          action: "ActionKeys/charge",
          idempotencyKey: "order-7",
          declaration
        },
        execute: Effect.sync(() => {
          spelledRuns++
          return "spelled"
        })
      })
      const flowActionDeclaration = Action.make("ActionKeys/form-aliasing/action", {
        payload: { run: Schema.String },
        success: Schema.String
      })
      const flow = Flow.make("ActionKeys/form-aliasing", {
        payload: { run: Schema.String },
        success: Schema.String,
        body: (payload) => flowActionDeclaration.call(payload)
      })
      const layer = Layer.mergeAll(
        flowActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            const first = yield* declared
            const second = yield* spelled
            return `${first}:${second}`
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )

      return yield* Effect.gen(function*() {
        // Before the form tag this returned "declared:declared" with
        // `spelledRuns === 0`: the second dispatch never ran.
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-form-aliasing" })).toBe("declared:spelled")
        expect(declaredRuns).toBe(1)
        expect(spelledRuns).toBe(1)
      }).pipe(Effect.provide(layer))
    }))

  effect("classifies tagged infrastructure interrupts for retry exhaustion", () => {
    const action = Action.make({
      name: "ActionKeys/infra-interrupt",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(0),
      execute: Effect.fail(new Action.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
    }).pipe(provideHost)
  })
})
