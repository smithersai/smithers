/**
 * Frozen signature projection for Markdown lowering and metadata combinators.
 *
 * @since 1.0.0
 */
import { Action, Flow as Durable } from "@smthrs/flow";
import type * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import { type Pipeable } from "effect/Pipeable";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type * as Effects from "../Effects.ts";
import * as Node from "../Node.ts";
import type * as Placement from "../Placement.ts";
import type * as Limits from "./Limits.vibe";
/**
 * Runtime type identifier carried by flow values.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export declare const TypeId: TypeId;
/**
 * Type-level representation of the flow runtime type identifier.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export type TypeId = "~flows/core/Flow";
/**
 * The name of a model seat a flow may run on.
 *
 * Seats are referred to by name, never by provider model id.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Seat = string & {};
/**
 * A collaborator a flow declares: a flow value, or a registry name the harness
 * resolves before execution.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Reference = Any | string;
/**
 * The struct payload a declared `input` schema becomes.
 *
 * `@smthrs/flow` requires a struct payload, and a signature may declare any
 * schema, so a non-struct input travels as the one field `input`.
 * {@link Flow.call} takes the declared shape and wraps it, so an author never
 * writes the wrapper.
 *
 * @category models
 * @since 1.0.0
 */
export type Payload<I extends Schema.Top> = (I extends Durable.AnyStructSchema ? I : Schema.Struct<{
    readonly input: I;
}>) & Durable.AnyStructSchema;
/**
 * A schema-described flow signature.
 *
 * The input schema is invariant because it participates in both decoding and
 * encoding. Output and error schemas are covariant.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Flow<I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top = typeof Schema.Never, Requires = Action.Requirement<string>> extends Pipeable {
    readonly [TypeId]: {
        readonly _Input: Types.Invariant<I>;
        readonly _Output: Types.Covariant<O>;
        readonly _Error: Types.Covariant<Err>;
    };
    /** The declared name, which is the tag of the flow and of the action. */
    readonly name: string;
    readonly description: string | undefined;
    /** The input schema as DECLARED, before {@link Payload} wraps a non-struct. */
    readonly input: I;
    readonly output: O;
    readonly error: Err;
    readonly capabilities: ReadonlyArray<string>;
    readonly effects: Effects.Declaration | undefined;
    /**
     * Advisory model seat metadata recorded on the flow.
     *
     * @since 0.1.0
     */
    readonly model: Seat | readonly [Seat, ...Array<Seat>] | undefined;
    /**
     * Advisory collaborator metadata recorded on the flow.
     *
     * @since 0.1.0
     */
    readonly flows: ReadonlyArray<Reference> | undefined;
    /**
     * Advisory prompt metadata recorded on the flow.
     *
     * @since 0.1.0
     */
    readonly prompt: string | undefined;
    /**
     * The ceilings declared for one run, or `undefined`. The deadline is the
     * native flow's `flow.deadline`.
     *
     * @since 1.0.0-rc.17
     */
    readonly budget: Limits.Budget | undefined;
    /**
     * The sandbox the flow selects, or `undefined`.
     *
     * @since 1.0.0-rc.17
     */
    readonly sandbox: Limits.SandboxSelection | undefined;
    /**
     * The annotation bag the lowered flow and action carry, with the declared
     * `capabilities` and `effects` already in it.
     */
    readonly annotations: Context.Context<never>;
    /**
     * The `@smthrs/flow` flow this signature IS, tagged with {@link Flow.name}.
     *
     * It is what `Graph.build`, an `Interpreter`, and a registry that checks
     * `@smthrs/flow`'s own type id are handed.
     */
    readonly flow: Durable.Flow<string, Payload<I>, O, Err, Requires>;
    /**
     * The declared action a host implements with `toLayer`, on a signature that
     * declared no body. A signature with a body carries `undefined`: its body IS
     * the implementation.
     */
    readonly action: Action.Declared<string, Payload<I>, O, Err, Requires> | undefined;
    /**
     * Records a call in the input schema's constructor shape, like the native
     * flow. In particular a class schema accepts its inert field data here.
     *
     * It never runs the body: graph construction evaluates pure bodies at plan
     * time.
     */
    readonly call: (input: I["~type.make.in"]) => Node.Node<O["Type"], Err["Type"], Requires>;
}
/**
 * Marker-only existential type for heterogeneous collections of flows.
 *
 * It names every property a consumer outside this package reads off a
 * signature, so a decorator that holds one erased can still read what it
 * declares.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export interface Any {
    readonly [TypeId]: object;
    readonly name: string;
    readonly description: string | undefined;
    readonly input: Schema.Top;
    readonly output: Schema.Top;
    readonly capabilities: ReadonlyArray<string>;
    readonly effects: Effects.Declaration | undefined;
    readonly flows: ReadonlyArray<Reference> | undefined;
    readonly annotations: Context.Context<never>;
    readonly flow: Durable.Any;
    readonly call: (input: never) => Node.Node<unknown, unknown, unknown>;
}
/**
 * Extracts the decoded input type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Input<F> = F extends {
    readonly input: infer I extends Schema.Top;
} ? I["Type"] : never;
/**
 * Extracts the decoded output type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Output<F> = F extends {
    readonly output: infer O extends Schema.Top;
} ? O["Type"] : never;
/**
 * Extracts the decoded error type of a flow.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Error<F> = F extends {
    readonly error: infer Err extends Schema.Top;
} ? Err["Type"] : never;
/** Everything a signature is built from, with every default already applied. */
interface Options<I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires> {
    readonly name: string;
    readonly description: string | undefined;
    readonly input: I;
    readonly output: O;
    readonly error: Err;
    readonly capabilities: ReadonlyArray<string>;
    readonly effects: Effects.Declaration | undefined;
    readonly model: Seat | readonly [Seat, ...Array<Seat>] | undefined;
    readonly flows: ReadonlyArray<Reference> | undefined;
    readonly prompt: string | undefined;
    readonly modelInvocable?: boolean | undefined;
    readonly budget?: Limits.Budget | undefined;
    readonly deadline?: Duration.Input | undefined;
    readonly sandbox?: Limits.SandboxSelection | undefined;
    /**
     * The annotations the AUTHOR supplied, before the declared `capabilities`
     * and `effects` are lowered onto them.
     *
     * A combinator rebuilds from these rather than from the lowered bag the
     * value exposes, so lowering a declaration twice cannot overwrite an
     * annotation a caller put on top of it.
     */
    readonly annotations: Context.Context<never>;
    readonly body: ((input: I["Type"]) => Node.Node<O["Type"], Err["Type"], Requires>) | undefined;
    /** The original native declarations whose diagnostic source locations survive a rebuild. */
    readonly original?: {
        readonly flow: object;
        readonly action: object | undefined;
    } | undefined;
}
/**
 * Builds a signature from Markdown-lowered options: annotated capabilities and
 * effects override the declared ones, and a signature without a body becomes the
 * action a host implements later.
 *
 * @since 1.0.0
 * @private
 */
export declare const build: <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires = Action.Requirement<string>>(options: Options<I, O, Err, Requires>) => Flow<I, O, Err, Requires>;
/**
 * Returns `true` when a value is a flow signature.
 *
 * @category guards
 * @since 0.0.0
 * @slop
 */
export declare const isFlow: (value: unknown) => value is Any;
/**
 * Places a flow within a host directive, returning a fresh flow.
 *
 * @category combinators
 * @since 0.0.0
 * @slop
 */
export declare const within: {
    (placement: Placement.Placement): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>;
    <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(self: Flow<I, O, Err, Requires>, placement: Placement.Placement): Flow<I, O, Err, Requires>;
};
/**
 * Attaches one typed annotation to a flow, returning a fresh flow.
 *
 * Annotations are metadata a host or a decorator reads. A custom key is
 * advisory, so a flow annotated with one plans the same graph as the flow it
 * was built from. The built-in {@link Annotations.Placement} and
 * {@link Annotations.Effects} keys are not advisory: `Graph.build` projects
 * both into node key material, so annotating with either changes the keys the
 * graph plans. {@link within} is the placement-shaped special case of this
 * combinator.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const annotate: {
    <Key, S>(key: Context.Key<Key, S>, value: S): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>;
    <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires, Key, S>(self: Flow<I, O, Err, Requires>, key: Context.Key<Key, S>, value: S): Flow<I, O, Err, Requires>;
};
/**
 * Replaces the collaborators a flow declares, returning a fresh flow.
 *
 * Everything else comes across unchanged: name, schemas, capabilities,
 * effects, body, and annotations. That is what lets a decorator rewrite a flow
 * tree without dropping the metadata a host reads back, such as a placement or
 * a lane.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const withFlows: {
    (flows: ReadonlyArray<Reference>): <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>;
    <I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires>(self: Flow<I, O, Err, Requires>, flows: ReadonlyArray<Reference>): Flow<I, O, Err, Requires>;
};
export {};
