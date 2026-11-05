/**
 * Memory flow declarations and runtime bindings.
 *
 * The declarations describe the runtime operation but intentionally perform
 * no memory I/O while a graph is being built.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @see https://smithers.sh/docs/reference/api/patterns
 * @since 0.1.0
 */
import * as Effects from "@smthrs/core/Effects";
import type * as Flow from "@smthrs/core/Flow";
import type * as DurableFlow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MemoryError } from "./MemoryError.vibe";
import * as MemoryStore from "../../../src/MemoryStore.ts";
import * as Namespace from "./Namespace.vibe";
import * as Recall from "./Recall.vibe";
import * as WithMemory from "./WithMemory.vibe";
/**
 * The registry name of the `remember` flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export declare const rememberName = "remember";
/**
 * The registry name of the `recall` flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export declare const recallName = "recall";
/**
 * The one-line description the model sees for the `remember` flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export declare const rememberDescription = "Persist a memory record in a named bank.";
/**
 * The one-line description the model sees for the `recall` flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export declare const recallDescription = "Recall advisory memory rows from named banks.";
/**
 * Maximum UTF-8 byte length of a remembered key.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_REMEMBER_KEY_BYTES = 1024;
/**
 * Maximum UTF-8 byte length of a remembered text: the recall query cap, so a
 * fact never outgrows what one recall budget can return.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_REMEMBER_TEXT_BYTES: number;
/**
 * The tag prefix a `remember` caller may not write.
 *
 * A `source:` tag claims where a record came from, and recall filters on it to
 * select trusted-source memory, so only a host writing through the store may
 * set it. A model-written fact carrying `source:eval` would otherwise pose as
 * an evaluation's finding.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const RESERVED_REMEMBER_TAG_PREFIX = "source:";
/**
 * Input schema for remember.
 *
 * Tags use `Namespace.Tags` so model decoding and durable writes enforce the
 * same vocabulary, uniqueness rule, and 16-tag cap before the handler performs
 * I/O, and refuse the reserved `source:` prefix. The bank uses `Recall.BankName`, so every remembered
 * fact is in a bank recall can name, and key and text are byte-capped. `ttlMs` is passed to the authoritative fact row.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RememberInput: Schema.Struct<{
    readonly bank: Schema.NonEmptyString;
    readonly key: Schema.NonEmptyString;
    readonly text: Schema.String;
    readonly tags: Schema.optional<Schema.$Array<Schema.TemplateLiteral<readonly [Schema.Literals<readonly ["branch:", "stream:", "source:", "scope:"]>, Schema.NonEmptyString]>>>;
    readonly ttlMs: Schema.optional<Schema.Int>;
}>;
/**
 * Output schema for remember.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RememberOutput: Schema.Struct<{
    readonly key: Schema.String;
}>;
/**
 * Input schema for the `recall` flow: `Recall.Input`, re-exported beside
 * `RememberInput` so a host declares both flows from this module.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RecallInput: Schema.Struct<{
    readonly banks: Schema.$Array<Schema.NonEmptyString>;
    readonly query: Schema.String;
    readonly tagGroups: Schema.optional<Schema.$Array<Schema.compose<Schema.Codec<Namespace.TagGroup, Namespace.TagGroup, never, never>, Schema.declare<Namespace.TagGroup, Namespace.TagGroup>>>>;
    readonly maxTokens: Schema.optional<Schema.Int>;
    readonly budget: Schema.optional<Schema.Literals<readonly ["low", "mid", "high"]>>;
}>;
/**
 * Output schema for the `recall` flow: `Recall.Output`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RecallOutput: Schema.$Array<Schema.Struct<{
    readonly bank: Schema.String;
    readonly key: Schema.String;
    readonly text: Schema.String;
    readonly score: Schema.Number;
    readonly updatedAtMs: Schema.optional<Schema.Number>;
}>>;
/**
 * Unsealed effect declaration for durable memory writes.
 *
 * @category effects
 * @since 0.1.0
 */
export declare const rememberEffects: Effects.Declaration;
/**
 * Sealed effect declaration for mutable cross-run memory reads.
 *
 * The core declaration shape requires a conflict policy, so this pure read
 * uses `fail` instead of the serializing policy reserved for writes.
 *
 * @category effects
 * @since 0.1.0
 */
export declare const recallEffects: Effects.Declaration;
/**
 * Declaration for a memory write.
 *
 * @category flows
 * @since 0.1.0
 */
export declare const remember: {
    readonly capabilities: readonly [];
    readonly name: "remember";
    readonly description: "Persist a memory record in a named bank.";
    readonly input: Schema.Struct<{
        readonly bank: Schema.NonEmptyString;
        readonly key: Schema.NonEmptyString;
        readonly text: Schema.String;
        readonly tags: Schema.optional<Schema.$Array<Schema.TemplateLiteral<readonly [Schema.Literals<readonly ["branch:", "stream:", "source:", "scope:"]>, Schema.NonEmptyString]>>>;
        readonly ttlMs: Schema.optional<Schema.Int>;
    }>;
    readonly output: Schema.Struct<{
        readonly key: Schema.String;
    }>;
    readonly effects: Effects.Declaration;
};
/**
 * Declaration for advisory memory recall.
 *
 * @category flows
 * @since 0.1.0
 */
export declare const recall: {
    readonly capabilities: readonly [];
    readonly name: "recall";
    readonly description: "Recall advisory memory rows from named banks.";
    readonly input: Schema.Struct<{
        readonly banks: Schema.$Array<Schema.NonEmptyString>;
        readonly query: Schema.String;
        readonly tagGroups: Schema.optional<Schema.$Array<Schema.compose<Schema.Codec<Namespace.TagGroup, Namespace.TagGroup, never, never>, Schema.declare<Namespace.TagGroup, Namespace.TagGroup>>>>;
        readonly maxTokens: Schema.optional<Schema.Int>;
        readonly budget: Schema.optional<Schema.Literals<readonly ["low", "mid", "high"]>>;
    }>;
    readonly output: Schema.$Array<Schema.Struct<{
        readonly bank: Schema.String;
        readonly key: Schema.String;
        readonly text: Schema.String;
        readonly score: Schema.Number;
        readonly updatedAtMs: Schema.optional<Schema.Number>;
    }>>;
    readonly effects: Effects.Declaration;
};
/**
 * Resolves the recall slot to a supplied signature.
 *
 * A slot is filled with the `@smthrs/flow` flow a signature carries, because
 * that is the value a pattern composes into a graph. The signature is what a
 * caller holds, so it is what this takes.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const bindRecall: (supplied: Flow.Any | DurableFlow.Any) => DurableFlow.Any;
/**
 * Runtime binding for the remember declaration, carrying explicit provenance.
 *
 * Provenance is bound once, when a host builds the handler, and every call the
 * returned function serves records it. Binding time is when a host knows the
 * run coordinates, and keeping the handler itself one-argument is what lets it
 * satisfy the `(input, call)` handler contract `FlowBinding.make` types: a
 * second positional argument there would receive the `Call`, not provenance,
 * and would persist the whole call payload into `provenance_json`.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const runRememberWith: (provenance: MemoryStore.Provenance) => (input: RememberInputType) => Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore>;
/**
 * Runtime binding for the remember declaration.
 *
 * Records no provenance. It takes exactly one argument so a host can hand it
 * straight to `FlowBinding.make({ flow, handler })`. Use
 * {@link runRememberWith} to bind run coordinates.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const runRemember: (input: RememberInputType) => Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore>;
/**
 * Runtime binding for the selected recall service.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const runRecall: (input: Recall.Input) => Effect.Effect<Recall.Output, MemoryError, Recall.Recall>;
/**
 * Applies the memory policy a flow carries to a recall request.
 *
 * Empty banks use the policy namespace; every explicit bank must resolve to
 * that same namespace or the entire request fails before recall runs. The
 * policy budget is a default the caller may override. `recall: "none"`
 * returns no rows before bank validation or any call to the recall service.
 * A flow that carries no policy fails with `invalid_namespace` before recall
 * runs; `runRecall` is the explicitly unscoped call.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const runRecallFor: (flow: WithMemory.Declared, input: Recall.Input) => Effect.Effect<Recall.Output, MemoryError, Recall.Recall>;
/**
 * Applies the memory policy a flow carries to a memory write.
 *
 * An unnamed bank resolves to the policy namespace. An explicit foreign bank
 * fails before the store runs. `retain: "never"` drops the write before bank
 * validation: the caller still receives the key it asked for, and nothing
 * reaches the store. The optional provenance argument is forwarded unchanged.
 * A flow that carries no policy fails with `invalid_namespace` before the store
 * runs; `runRememberWith` is the explicitly unscoped write.
 *
 * The flow comes first so this can never be mistaken for a `FlowBinding`
 * handler; {@link handlersFor} is the one-argument handler a host binds.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const runRememberFor: (flow: WithMemory.Declared, input: RememberInputType, provenance?: MemoryStore.Provenance) => Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore>;
/**
 * The runtime handlers one bound memory declaration answers with.
 *
 * Each handler takes exactly one argument, the decoded flow input, so it
 * satisfies the `(input, call)` handler contract `FlowBinding.make` types.
 * Provenance is bound by {@link handlersFor}, not passed per call.
 *
 * @category models
 * @since 0.1.0
 */
export interface Handlers {
    readonly remember: (input: RememberInputType) => Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore>;
    readonly recall: (input: Recall.Input) => Effect.Effect<Recall.Output, MemoryError, Recall.Recall>;
}
/**
 * Builds the handlers for one memory declaration, reading the memory policy
 * that declaration carries.
 *
 * A host binds the declaration a cell was given, which for delegated work is
 * the policy-carrying copy `withMemory` produced, not the bare declaration
 * exported here. Passing that copy is what makes the namespace, the recall
 * budget, and `recall: "none"` reach the runtime:
 *
 * ```ts
 * const bound = WithMemory.withMemory(Flows.recall, policy)
 * FlowBinding.make({ flow: bound, handler: Flows.handlersFor(bound).recall })
 * ```
 *
 * The optional `provenance` is bound here, once, and recorded on every fact the
 * returned `remember` handler writes. A host that knows its run coordinates
 * passes them at binding time; the handler stays one-argument so it remains a
 * legal `FlowBinding` handler.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const handlersFor: (flow: WithMemory.Declared, provenance?: MemoryStore.Provenance) => Handlers;
/**
 * What the `remember` flow accepts.
 *
 * @category types
 * @since 0.1.0
 */
export type RememberInputType = typeof RememberInput.Type;
