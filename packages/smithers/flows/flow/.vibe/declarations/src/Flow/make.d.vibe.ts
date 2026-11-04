/**
 * Constructs executable flow declarations from schema and policy data.
 *
 * @since 0.1.0
 */
import type * as Effects from "@smthrs/plan/Effects";
import * as Node from "@smthrs/plan/Node";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import type * as RetryPolicy from "../RetryPolicy.vibe";
import type { Any, AnyStructSchema, BodySuccess, DeclarationMetadata, Flow, PromptFlow } from "./Flow.vibe";
/**
 * The declaration data every flow takes beside its body.
 *
 * @private
 */
interface MakeOptions<Payload extends Schema.Struct.Fields | AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top> extends DeclarationMetadata {
    readonly payload: Payload;
    /**
     * Native declaration whose source location this reconstructed flow retains.
     * A source with no recorded location preserves that absence. This affects
     * diagnostics only, never identity; the new flow keeps its own body and calls.
     */
    readonly declaredFrom?: object | undefined;
    /**
     * One sentence saying what this flow does, read by a catalog that lists it.
     */
    readonly description?: string | undefined;
    /**
     * The capability ceiling this flow's body runs under, as string literals.
     *
     * It is the same ceiling {@link Annotations.Capabilities} carries, and
     * declaring it here is what makes it READABLE without importing the module:
     * a catalog projects a discovered flow's authority from the declaration, and
     * an annotation built at run time is invisible to that projection.
     */
    readonly capabilities?: ReadonlyArray<string> | undefined;
    /**
     * The effect envelope this flow's body runs under, as a literal.
     *
     * It is the same declaration {@link Annotations.EffectEnvelope} carries, and
     * declaring it here is what makes it READABLE without importing the module,
     * exactly as `capabilities` is: a catalog projects a discovered flow's
     * authority from the source text of this literal, and an annotation built at
     * run time is invisible to that projection.
     *
     * {@link module:Graph.build} refuses a composition beneath this flow that
     * reads or writes outside the envelope, loosens `hermetic` to `expected`, or
     * raises the tier. `reads` and `writes` are normalized to sorted,
     * duplicate-free arrays, so two spellings of one envelope are one envelope.
     */
    readonly effects?: Effects.MakeOptions | undefined;
    /**
     * Whether a catalog may offer this flow to a model, as a literal. Defaults
     * to `true`.
     *
     * It is the same statement {@link Annotations.ModelInvocable} carries, and
     * declaring it here is what makes it READABLE without importing the module,
     * exactly as `capabilities` and `effects` are: a registry projects a
     * discovered flow's visibility from the source text of this literal onto the
     * descriptor it lists, and an annotation built at run time is invisible to
     * that projection.
     *
     * Declare `false` when the actions this flow's body calls are implemented by
     * one host only. The file is discoverable wherever it sits, so a catalog
     * elsewhere would otherwise teach an agent a call with no implementation to
     * reach.
     */
    readonly modelInvocable?: boolean | undefined;
    /**
     * The tokens, milliseconds and dollars one run asks a control plane to
     * approve, and what exceeding them does, as a literal.
     *
     * Discovery reads it from the source text onto the descriptor's budget,
     * exactly as Markdown frontmatter's `budget` is read; the control plane, not
     * this flow, enforces it.
     */
    readonly budget?: {
        readonly tokens?: number | undefined;
        readonly milliseconds?: number | undefined;
        readonly usd?: number | undefined;
        readonly onExceeded?: "fail" | "warn" | "skip-remaining" | "park" | undefined;
    } | undefined;
    readonly idempotencyKey?: ((payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]) => string) | undefined;
    readonly success?: Success;
    readonly error?: Error;
    readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined;
    /**
     * The round budget a trampoline lineage started from this flow runs under.
     */
    readonly maxRounds?: number | undefined;
    /**
     * How long one execution may take, counted from its journaled first start.
     * A positive finite duration of at most `Number.MAX_SAFE_INTEGER`
     * milliseconds; see {@link Flow.deadline}.
     */
    readonly deadline?: Duration.Input | undefined;
    readonly annotations?: Context.Context<never>;
}
/**
 * The pure plan-time body, typed with the decoded payload.
 *
 * @private
 */
type Body<Payload extends Schema.Struct.Fields | AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top, Requires> = (payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>;
/**
 * The payload schema a declaration's `payload` field stands for.
 *
 * @private
 */
type PayloadSchemaOf<Payload extends Schema.Struct.Fields | AnyStructSchema> = Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload;
/**
 * Whether a value is a flow this package made.
 *
 * The check is the runtime type id, not the shape: a host that loads a module
 * and finds a default export has to decide whether it holds a flow before it
 * reads anything off it, and a structural guess would accept a look-alike from
 * another flow model.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const isFlow: (value: unknown) => value is Any;
/**
 * Creates a durable flow with one plan-time body or a typed prompt renderer.
 * A prompt lowers to one ordinary action implemented by the host; neither
 * construction nor planning renders it. Model metadata is interpreted by the
 * host and adds no execution model to this package.
 *
 * Invocation IDs are caller-selected or opt-in deterministic IDs derived
 * from the flow tag and idempotency key.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: {
    <const Tag extends string, Payload extends Schema.Struct.Fields | AnyStructSchema, Success extends Schema.Top = Schema.Void, Error extends Schema.Top = Schema.Never, Requires = never>(tag: Tag, options: MakeOptions<Payload, Success, Error> & {
        readonly body: Body<Payload, Success, Error, Requires>;
        readonly prompt?: never;
    }): Flow<Tag, PayloadSchemaOf<Payload>, Success, Error, Requires>;
    <const Tag extends string, Payload extends Schema.Struct.Fields | AnyStructSchema, Success extends Schema.Top = Schema.Void, Error extends Schema.Top = Schema.Never>(tag: Tag, options: MakeOptions<Payload, Success, Error> & {
        readonly prompt: (payload: PayloadSchemaOf<Payload>["Type"]) => string;
        readonly body?: never;
        readonly implementationVersion?: string | undefined;
    }): PromptFlow<Tag, PayloadSchemaOf<Payload>, Success, Error>;
};
export {};
