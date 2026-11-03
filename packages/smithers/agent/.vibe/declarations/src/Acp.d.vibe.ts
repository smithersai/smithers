/**
 * A client of the Agent Client Protocol (ACP): JSON-RPC 2.0 between a client
 * and an agent, one message per line on the agent's stdio
 * (https://agentclientprotocol.com).
 *
 * {@link make} speaks to one agent over a {@link Transport}, two plain values
 * a host builds from a child process's stdout and stdin, so this module names
 * no platform. It covers what a runner needs to drive any ACP agent through
 * one task: `initialize`, `session/new` or `session/load`, `session/prompt`
 * and its stop reason, `session/cancel`, the `_session/steering` extension
 * for a message in the middle of a turn, and every `session/update` the agent
 * streams, passed on as it arrived. The client offers the agent no file
 * system and no terminal, so the agent works with its own tools, and it
 * answers a permission request with the agent's first option of the kind its
 * `permission` policy picks.
 *
 * Errors carry codes only: an agent's error message can quote its task.
 *
 * @since 1.0.0
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
/**
 * The protocol version this client speaks.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const PROTOCOL_VERSION = 1;
/**
 * Why a prompt turn ended, as the agent said.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const STOP_REASONS: readonly ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
/**
 * Why a prompt turn ended, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type StopReason = (typeof STOP_REASONS)[number];
declare const AcpError_base: Schema.Class<AcpError, Schema.TaggedStruct<"@smthrs/agent/Acp/AcpError", {
    readonly code: Schema.Literals<readonly ["closed", "protocol", "remote"]>;
    readonly method: Schema.String;
    readonly rpcCode: Schema.optional<Schema.Int>;
}>, Cause.YieldableError>;
/**
 * The conversation with the agent failed: `closed` (its output ended or could
 * not be written), `protocol` (it sent what the protocol doesn't allow), or
 * `remote` (it answered a request with an error, whose JSON-RPC code is
 * `rpcCode`). The agent's own message is never kept.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class AcpError extends AcpError_base {
}
/**
 * The two ends of an agent's stdio: the lines it writes, and how to write one
 * line to it (without its newline).
 *
 * @category models
 * @since 1.0.0
 */
export interface Transport<E = never, R = never> {
    readonly incoming: Stream.Stream<string, E, R>;
    readonly send: (line: string) => Effect.Effect<void, unknown>;
}
/**
 * One `session/update` as the agent sent it: its session, its kind (the
 * `sessionUpdate` discriminator, such as `agent_message_chunk`, `tool_call`
 * or `usage_update`), and the whole update object.
 *
 * @category models
 * @since 1.0.0
 */
export interface Update {
    readonly sessionId: string;
    readonly kind: string;
    readonly update: Readonly<Record<string, unknown>>;
}
/**
 * What the agent said of itself at `initialize`: the version it agreed to,
 * whether it can load a session it ran before, and whether it takes a message
 * in the middle of a turn (`_session/steering`, which it advertises as
 * `_meta.steering.supported`).
 *
 * @category models
 * @since 1.0.0
 */
export interface Initialized {
    readonly protocolVersion: number;
    readonly loadSession: boolean;
    readonly steering: boolean;
}
/**
 * The client of one agent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Client {
    readonly initialize: Effect.Effect<Initialized, AcpError>;
    readonly newSession: (cwd: string) => Effect.Effect<string, AcpError>;
    readonly loadSession: (sessionId: string, cwd: string) => Effect.Effect<void, AcpError>;
    /** Sends `text` as one prompt turn and answers its stop reason once the turn ends. */
    readonly prompt: (sessionId: string, text: string) => Effect.Effect<StopReason, AcpError>;
    /** Asks the agent to end the session's turn; its prompt then answers `cancelled`. */
    readonly cancel: (sessionId: string) => Effect.Effect<void, AcpError>;
    /**
     * Hands `text` to the session's turn in flight (`_session/steering`, an
     * extension the published ACP adapters of two coding agents serve): whether the
     * agent took it in. Ask it only of an agent whose `initialize` said
     * `steering`. Taken in is not read: the agent's next update is the first
     * sign it read the message.
     */
    readonly steer: (sessionId: string, text: string) => Effect.Effect<boolean, AcpError>;
}
/**
 * How the client answers the agent's permission requests: `allow` picks the
 * first `allow_always` or `allow_once` option, `reject` the first
 * `reject_once` or `reject_always` option. A request with no such option is
 * answered `cancelled`.
 *
 * @category models
 * @since 1.0.0
 */
export type Permission = "allow" | "reject";
/**
 * How {@link make} is set up.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    /** Runs for each `session/update`, in order; a failure it raises is logged by kind and dropped. */
    readonly onUpdate: (update: Update) => Effect.Effect<void>;
    /** `allow` unless set. */
    readonly permission?: Permission | undefined;
    /** The client's name and version, as `initialize` sends them. */
    readonly clientInfo?: {
        readonly name: string;
        readonly version: string;
    } | undefined;
}
/**
 * Starts a client of the agent at the other end of `transport`, reading its
 * lines on a fiber in the current scope. Requests in flight when the agent's
 * output ends fail `closed`.
 *
 * @example
 * ```ts
 * import { Acp } from "@smthrs/agent"
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 *
 * const session = (transport: Acp.Transport, cwd: string) =>
 *   Effect.gen(function*() {
 *     const client = yield* Acp.make(transport, { onUpdate: (update) => Effect.log(update.kind) })
 *     yield* client.initialize
 *     const id = yield* client.newSession(cwd)
 *     return yield* client.prompt(id, "Add a README")
 *   }).pipe(Effect.scoped)
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: <E, R>(transport: Transport<E, R>, options: Options) => Effect.Effect<Client, never, R | Scope.Scope>;
/**
 * The text of an `agent_message_chunk` update whose content is text, else
 * none.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const messageText: (update: Update) => Option.Option<string>;
/**
 * What a `usage_update` says: the tokens in context, and the session's
 * cumulative cost in US dollars when the agent reports it in USD.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const usage: (update: Update) => Option.Option<{
    readonly contextTokens: number;
    readonly costUsd: number | undefined;
}>;
export {};
