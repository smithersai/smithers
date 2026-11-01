/**
 * Golden vectors for the durable identities this package derives.
 *
 * A step key is a cache address. Every other case in this suite asserts a
 * RELATION between keys — two calls agree, two runs differ, a park replays —
 * and a relation survives a change that moves every key at once. Rewriting the
 * material a sealed model call hashes, or the composition token folded into a
 * cell call, makes previously recorded steps miss even while the relational
 * assertions all still hold. A live model host would dispatch those calls again.
 *
 * So these cases pin the exact strings. A failure needs its key material
 * investigated before the fixture changes. This 1.0 rewrite has not been
 * released; these vectors establish the baseline for its first release.
 * Deliberate future identity changes belong in CHANGELOG.md so hosts can
 * account for cache invalidation.
 *
 * Each key is read back through `Action.CurrentInvocationKey` inside the
 * dispatched activity, so what is pinned is the identity the ENGINE carried,
 * not a value recomputed from the same source the assertion is checking.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import type * as EngineLike from "@smthrs/harness/EngineLike"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"

/** The one prepared wire request both vectors are sealed against. */
const prepared: Route.PreparedRequest = {
  routeId: "route-golden",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{\"golden\":true}"),
  bodyText: "{\"golden\":true}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const request = ModelRequest.ModelRequest.make({
  modelId: "golden-model",
  system: [],
  messages: [ModelRequest.Message.user("seal me")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

/** The sealed declaration, fixed in every field the key material reads. */
const sealed: EngineLike.SealedModelStep = {
  request,
  keyMaterial: {
    version: "flows/key-material/v2",
    kind: "sealed",
    body: { _tag: "ModelCall", request },
    inputs: [{
      _tag: "Literal",
      value: { contextDigest: ContextWindow.make({ modelId: "golden-model", segments: [] }).digest }
    }],
    layers: [],
    capabilities: [],
    effects: undefined,
    placement: undefined
  }
}

/** The sealed cell call, fixed the same way. */
const cellCall = new Cell.Call({
  flowName: "fs/write",
  input: { path: "out.txt", text: "done" },
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.none(),
  identity: new Cell.CallIdentity({
    session: "golden-session",
    frame: 0,
    cell: "golden-cell-digest",
    ordinal: 0,
    declaration: "golden-declaration-digest",
    layers: []
  })
})

/**
 * A model that answers with the idempotency key the engine dispatched it
 * under.
 */
const reportingModel: Model.Model = Model.make({
  stream: () =>
    Stream.unwrap(
      Effect.map(Action.CurrentInvocationKey, (key) =>
        Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: key ?? "missing" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ]))
    )
})

const goldenFlow = Flow.make("agent/test/step-key-golden", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** Runs one body as a real execution and hands back what it produced. */
const drive = <A>(
  body: Effect.Effect<
    A,
    unknown,
    | Crypto.Crypto
    | FlowRuntime.FlowRuntime
    | FlowRuntime.FlowInstance
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
  >
): Promise<A> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<A, unknown>()
    yield* engine.register(
      goldenFlow,
      () => Effect.exit(body).pipe(Effect.flatMap((exit) => Deferred.done(settled, exit)))
    ).pipe(Scope.provide(scope))
    yield* engine.execute(goldenFlow, { executionId: "exec-golden", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FlowEngine.layerMemory,
        Crypto.layerFromDigest(NodeCrypto.layerDigest),
        Budget.layerUnbounded(),
        QuotaPolicy.layerUnclassified()
      )
    ),
    Effect.scoped,
    Effect.orDie,
    Effect.runPromise
  )

/** Derives a key the way an engine before key encoding 3 wrote it. */
const underEncoding2 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FlowEngine.ActionKeyEncoding, 2)

/** Seals the fixed step through a port built over `layers`. */
const sealUnder = (layers: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const port = yield* FlowEngineLike.make({ model: reportingModel, route, layers, capabilities: {} })
    const events = yield* Stream.runCollect(port.sealStep(sealed))
    const delta = events.find((event) => event.type === "text-delta")
    return delta === undefined ? "missing" : (delta as { readonly text: string }).text
  })

/** Dispatches the fixed cell call through a port built over `layers`. */
const callUnder = (layers: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const port = yield* FlowEngineLike.make({
      model: reportingModel,
      route,
      layers,
      capabilities: {},
      calls: {
        run: () =>
          Effect.map(
            Action.CurrentInvocationKey,
            (key) => new Cell.CallResult({ outcome: "success", value: key ?? "missing" })
          )
      }
    })
    const result = yield* port.call(cellCall)
    return String(result.value)
  })

describe("the sealed model step key", () => {
  it("is exactly this string for this prepared request and composition", async () => {
    const observed = await drive(Effect.gen(function*() {
      return {
        host: yield* sealUnder(["golden-host-layer"]),
        again: yield* sealUnder(["golden-host-layer"]),
        other: yield* sealUnder(["another-host-layer"]),
        encoding2: yield* underEncoding2(sealUnder(["golden-host-layer"]))
      }
    }))

    // This candidate upgrades Effect rc.112 to rc.115. Upstream refinement
    // implementations participate in schema fingerprints, so these sealed
    // activity keys change too (see core's SchemaUpgradeIdentity fixture and
    // RELEASE_SUPPORT.md). Old runs must finish with their original lockfile.
    // The key still includes the prepared request, harness declaration, and
    // cache environment's composition token.
    //
    // It moved a second time when the completion brake stopped falling back
    // and `HarnessErrorCode` gained `completion_unjudged`, and a third time
    // when it gained `claim_unproven` for a claim the brake read and the run
    // could not prove: the harness declaration in this preimage spells out the
    // whole error union, so a new member is a new key. Same rule as above for
    // runs already in flight.
    //
    // It moved a fourth time when `@smthrs/capability`'s `Action` literal union
    // gained `jj:op-restore` (cc5f26313, #1810): the declaration's capability
    // schema is in this preimage the same way the error union is.
    //
    // It moved a fifth time when that union gained `memory:read` and
    // `memory:write` for capability-scoped role memory (06a13ab4ee).
    //
    // It moved a sixth time when `ModelEvent.Settle` gained `sessionId`, the
    // vendor session a wrapped CLI seat answered from (45aa1347): the
    // activity's `RecordedModelStep` success schema embeds the event union,
    // and its fingerprint is in this key.
    //
    // It moved a seventh time when `ModelErrorCode` gained `out_of_credit`
    // (f52aa3f1d5, #1844): the step's error schema embeds the code union.
    expect(observed.host).not.toBe("key1_b5b3584a4ab3f2df73c684edccbb962e95e5497a4c33ac14d7f6601a4b3b043f")
    expect(observed.host).not.toBe("key1_a577eb74c0f86b94bec571cfe4ee22fc88b149a371652057677c28fb49effebe")
    expect(observed.host).not.toBe("key1_46a73bc13be2fe77a111e193fb0f1fafbaab470fb6c2a5c36a86dce446e027f5")
    expect(observed.host).not.toBe("key1_7e84313af37d0f9ac1e55b49529d1784837d40536a74e879aadb5a13074b8cc1")
    expect(observed.host).not.toBe("key1_6326d2f880ff8a393a69657ad23575ad6587c01328ab81742a6e7465bbc7a154")
    expect(observed.host).not.toBe("key1_71b2f391813935739bf19fb2ade03b31af6f751f85c8c9fc1708852a297971eb")
    expect(observed.host).not.toBe("key1_674672c55bd09f6b4907f8961f14598b0bb900c5d2aadacd28a51bbd3c3e209b")
    // Moved an eighth time when the evaluator's typed failure joined the
    // error union the step embeds (fc7f29e867, #2807).
    expect(observed.host).not.toBe("key1_15a4c2592ebebcb92233e55ddcdc49a1b1c4fad7ee7273af7c0ac3192cdc4bcc")
    // Moved a ninth time when that failure carried what a failed reading
    // paid (#3010).
    expect(observed.host).not.toBe("key1_0f7a7d81883e298518a57713e6cb7218a527b713388fe7e7b1cf5310e61350a9")
    // Moved a tenth time when `HarnessErrorCode` gained
    // `completion_incomplete` for a completion reporting its own work
    // unfinished (#3009).
    expect(observed.host).not.toBe("key1_4fd148a67a94aaa4ec702d424fa156e78b71935a61c926d4fca4753683a812af")
    // Moved an eleventh time when required asks without an approval channel
    // gained the typed `approval_unavailable` failure (#3161). Preserve the
    // preceding declaration identity; an unchanged Effect lock alone does not
    // make different harness declarations replay-compatible (#3317).
    expect(observed.host).not.toBe("key1_91d1fb4dc2465b267ef74cda2fad8d7d42e3986e293fcd0f642ec2e33b0a80fa")
    // Moved a twelfth time on 2026-10-13, when a model call learned to say
    // where its time went (1ae37f2b82, #3840): `ModelEvent.Settle` gained
    // `timing` (`ModelEvent.Timing`, with its `failedTries`) and `servedTier`,
    // and `ModelEvent.Retry` gained `elapsedMs` and `httpStatus`. Every field
    // is optional and an old record still decodes, but the activity's
    // `RecordedModelStep` success schema embeds the event union and its
    // fingerprint is in this key. A run journaled before the change and
    // resumed after it asks the provider again for the model calls in its
    // prefix, so in-flight runs finish on their original revision.
    expect(observed.host).not.toBe("key1_3f683043bfe48814c4f4fe4ea219b2f5475539f72142abaef067987e9bf8241e")
    expect(observed.host).not.toBe("key1_1f993b7602a78244c50e2d62884a7adaf57aa1d9bb84d96c71f3a4938a2f85a3")
    // EvaluatorError usage now declares the reported cost (#3824).
    expect(observed.host).not.toBe("key1_598ea5fa58ff895d326e7542cd8c166083fdff827c01165992bdd165b27945c1")
    expect(observed.encoding2).not.toBe("key1_598ea5fa58ff895d326e7542cd8c166083fdff827c01165992bdd165b27945c1")
    // Moved when `HarnessError.cause` gained the provider's typed `ModelError`
    // (9904ce12f1): a declaration change, which moves the key under every key
    // encoding. With that commit's `HarnessError` swapped back, encoding 2
    // derives the key above byte for byte, so the derivation itself did not move.
    //
    // Moved again on 2026-10-21 when sealed keys began to name their encoding
    // (`keyEncoding: 3`, engine 631bbbe2). This move strands nothing: key
    // encoding 2 still derives the previous key, and a run journaled under it
    // replays there (CellCallIdentityReplay.test.ts).
    expect(observed.encoding2).toBe("key1_8ea4786bba8082954abcb2c65b209b3528f9b4307df90a94d34031369879cc2d")
    expect(observed.host).toBe("key1_f56e335aa68923604edc22e7c3da6298f8198caeb3cf3d5c75da647d1629c58c")
    // Sealed means content-addressed: the same declaration through a second
    // port of the same composition is one recorded answer, not two calls.
    expect(observed.again).toBe(observed.host)
    // And the composition is genuinely in it, which is what keeps a step
    // recorded under a broader envelope from being served to a narrower one.
    expect(observed.other).not.toBe(observed.host)
  })
})

describe("the sealed cell-call key", () => {
  it("is exactly this string, and moves with the composition", async () => {
    const observed = await drive(Effect.gen(function*() {
      return {
        host: yield* callUnder(["golden-host-layer"]),
        other: yield* callUnder(["another-host-layer"]),
        encoding2: yield* underEncoding2(callUnder(["golden-host-layer"]))
      }
    }))

    // The same warning applies. This key additionally folds in the composition
    // token `flows/agent/composition/v1:<digest of the layer set>`, so a rename
    // of that prefix, or a change to how the layer set is digested, moves this
    // string while leaving the sealed model key above untouched.
    expect(observed.host).not.toBe("key1_8ab2962732794ee8d8b3bf550657b41d475fd082ec9c8c7073b1d24a8d77d4b9")
    expect(observed.host).not.toBe("key1_a889e8b3453778007938b385090ec68cf8af50a2b26626874f88db14f852faef")
    expect(observed.host).not.toBe("key1_dac0642a1dac92f2089981c1ae3c0625b5b63455c38e9695d15c713098aa2a00")
    // Moved when CallFailureCode gained flow_withheld (#1929).
    expect(observed.host).not.toBe("key1_824e8c645a1b3c6bcae2e2d1041e8017a791bde3dda10ce72e90d4631db41849")
    // Moved when `HarnessError.cause` gained the typed `EvaluatorError`
    // member (fc7f29e867, #2807).
    expect(observed.host).not.toBe("key1_0336839392318b217d1892c2ae94ae09d6a644dd695239675803285d5e475b14")
    // Moved when that `EvaluatorError` carried what a failed reading paid
    // (#3010).
    expect(observed.host).not.toBe("key1_88223cc71e3c3ad27cb1dffea61a732b14dcfd48282f61d2253173adbd4d8d7b")
    // Moved when `HarnessErrorCode` gained `completion_incomplete` (#3009).
    expect(observed.host).not.toBe("key1_a839b582877e4aed09963b2cc3aa15af094379d286e83018dd67dd3efb06d4c8")
    // The same schema migration for `approval_unavailable` (#3161/#3317).
    expect(observed.host).not.toBe("key1_425bb2aeef11571a366804d4700e45def8ac0aceac7c7c585b3e1f9461259283")
    expect(observed.host).not.toBe("key1_1e7f6586798d0220c9866f7d53e4d17ba33245e13e476b7e59ce3d080ec2fc8e")
    expect(observed.host).not.toBe("key1_5a55d5f0eb804f94c23df600642072cbe5e926f26ae6c8cbb549d3834bfcb68c")
    // Moved when `HarnessError.cause` gained the provider's typed `ModelError`
    // (9904ce12f1), a declaration change; and again when sealed keys began to
    // name their encoding (`keyEncoding: 3`), which key encoding 2 undoes, so a
    // recorded call replays.
    expect(observed.encoding2).toBe("key1_c753452803048e450f3f45a4ff5b97455bc729f6c3011cc8364f4c344caf6208")
    expect(observed.host).toBe("key1_e389acc8bba469bfdf24e19262d93e98f8631fd8a1e4729747c93d7ecb960388")
    // The composition really is in the key: the same call resolved under a
    // different layer set is a different boundary, not a cache hit.
    expect(observed.other).not.toBe(observed.host)
  })
})
