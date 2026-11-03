/**
 * A model that answers from a script, for the turns a recording cannot make.
 *
 * Record and replay (`CachedModel`) is the default double: it answers with
 * what a real model said. Some tests need an answer no real model gives on
 * demand: a planner that asks a question, an edit that breaks the build once
 * and then repairs it, a turn that waits until the test releases it. A script
 * gives those answers on purpose. `ScriptedModel.make` runs one: each request
 * is offered to the script, a matched request is answered with the script's
 * text, and an unmatched one goes to `fallback`, which is usually a
 * `CachedModel`, so scripted turns and recorded turns serve one run.
 *
 * A script that throws refuses the request with an `invalid_request`
 * `ModelError` naming the reason, which `ModelServer` answers `400`.
 *
 * A reply may name a hold key. The turn then waits on the `TurnGate` until the
 * test releases the key, exactly as `TurnGate.model` holds a turn.
 *
 * @since 1.0.0
 */
import * as Model from "@smthrs/model/Model";
import type { ModelRequest } from "@smthrs/model/ModelRequest";
import type * as TurnGate from "./TurnGate.vibe";
import type * as TurnLog from "../../../src/TurnLog.ts";
/**
 * One scripted answer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Reply {
    /** The turn's name, which the turn log counts and traces. */
    readonly name: string;
    /** The assistant's whole answer. */
    readonly text: string;
    /** A key the turn waits on before it answers; see `TurnGate`. */
    readonly hold?: string | undefined;
    /** Extra fields for this turn's trace entry. */
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
}
/**
 * A script: the reply for a request, or `undefined` when the script does not
 * answer it.
 *
 * @category models
 * @since 1.0.0
 */
export type Script = (request: ModelRequest) => Reply | undefined;
/**
 * One rule of a script built with {@link fromTurns}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Turn {
    readonly name: string;
    /** Whether this turn answers the request. */
    readonly when: (request: ModelRequest) => boolean;
    /** The assistant's answer. */
    readonly reply: (request: ModelRequest) => string;
    /** The key the turn waits on, or `undefined` to answer at once. */
    readonly hold?: ((request: ModelRequest) => string | undefined) | undefined;
}
/**
 * A script that answers with the first turn whose `when` holds.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const fromTurns: (turns: ReadonlyArray<Turn>) => Script;
/**
 * One message of a request as plain text: its role and every text it carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface TranscriptMessage {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
}
/**
 * A request as the plain messages a Chat Completions client sent: one system
 * message per system part, then each message's text, tool-call arguments and
 * tool results joined.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const transcript: (request: ModelRequest) => ReadonlyArray<TranscriptMessage>;
/**
 * What a scripted model is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    readonly script: Script;
    /**
     * Answers what the script does not. Without one, an unscripted request dies
     * with `UnscriptedModelError`, which `ModelServer` answers `501`.
     */
    readonly fallback?: Model.Model | undefined;
    /** Holds a reply that names a key. A reply with a hold and no gate answers at once. */
    readonly gate?: TurnGate.TurnGate | undefined;
    /** Records each turn when it is dispatched, before any hold. */
    readonly log?: TurnLog.TurnLog | undefined;
    /**
     * The usage each scripted answer reports, so a metering proxy in front of
     * the server settles the call. 100 input and 100 output tokens by default.
     */
    readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
    } | undefined;
}
/**
 * Builds a model that answers from `options.script` and sends the rest to
 * `options.fallback`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options: Options) => Model.Model;
