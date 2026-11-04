/**
 * Provider-neutral chat leg execution for every trusted Smithers host.
 *
 * @since 1.0.0-rc.0
 */
import { type Model, ModelError, ModelRequest } from "@smthrs/model";
import { type NativeAgent } from "@smthrs/rpc";
import { Effect } from "effect";
import type { HostDiagnostics } from "./HostDiagnostics.vibe";
/**
 * Provider route and output controls for one model turn.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnOptions {
    readonly modelId: string;
    readonly outputTokenLimitSupported?: boolean;
    readonly maxTokens?: number;
    readonly credential?: string;
    /** Other host-resolved route credentials to remove from every output channel. */
    readonly additionalCredentials?: ReadonlyArray<string>;
}
/**
 * Commits one renderer-compatible frame.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FrameWriter<E> = (frame: NativeAgent.AgentTurnFrame) => Effect.Effect<void, E>;
/**
 * Projects the renderer request into the canonical provider model request.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const providerRequest: (turn: NativeAgent.StartAgentTurnRequest, options: ModelTurnOptions) => ModelRequest.ModelRequest;
/**
 * Removes a configured credential even when provider chunks split it. The
 * concatenation of everything `push` and `finish` return never contains the
 * credential: when cutting one echo joins text already returned with text
 * still to come, the joining text is dropped too.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export declare class StreamingCredentialCutter {
    private pending;
    /** The end of the returned text, one character shorter than the longest secret part. */
    private returned;
    private readonly parts;
    constructor(secret: string | undefined, additional?: ReadonlyArray<string>);
    private cut;
    push(value: string): string;
    finish(): string;
    /**
     * Drops the start of `text` while it completes a secret part begun in the
     * returned text. Both sides are already free of whole parts, so any part
     * found from one part-length before the seam straddles it.
     */
    private release;
}
/**
 * One tool call a host-owned leg ended with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HeldToolCall {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
}
/**
 * How a host-owned leg ended: with tool calls the host runs before the next
 * leg, and the turn's token counts so far. No terminal frame was written.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HeldToolCalls {
    readonly calls: ReadonlyArray<HeldToolCall>;
    readonly usage: NativeAgent.AgentTurnUsage | undefined;
}
/**
 * A leg of a host-owned turn: its tool calls are held for the host rather
 * than written as `tool_call` frames for a renderer, and `usage` is what the
 * turn's earlier legs spent.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HostLeg {
    readonly usage: NativeAgent.AgentTurnUsage | undefined;
}
/**
 * Runs one provider stream and emits the established renderer frame contract.
 * A host-owned leg (`host`) holds its tool calls and, when it ends in them,
 * returns them instead of writing the terminal frame.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export declare const runModelTurn: <E>(model: Model.Model, turn: NativeAgent.StartAgentTurnRequest, options: ModelTurnOptions, write: FrameWriter<E>, host?: HostLeg, diagnostics?: HostDiagnostics) => Effect.Effect<HeldToolCalls | undefined, Model.ModelFailure | ModelError.ModelError | E>;
