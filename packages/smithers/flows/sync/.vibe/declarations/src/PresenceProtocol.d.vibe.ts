/**
 * The wire protocol between a page and a presence room: who is on a page, and
 * where, live. One WebSocket per page, all JSON text.
 *
 * - **A page sends its state.** A `state` frame carries the participant's own
 *   opaque state, such as JSON of where they are. The room relays it and
 *   never reads it.
 * - **The room sends the roster.** After every change, each connection
 *   receives a `roster` frame: every participant in join order, itself
 *   included, with `self` naming its own connection id.
 * - **Frames are capped.** A state holds at most {@link maxStateBytes} and a
 *   page's frame at most {@link maxFrameBytes}, in UTF-8 bytes. A frame over
 *   the cap closes the socket with {@link CloseCode.tooBig}; a binary or
 *   malformed frame with {@link CloseCode.unsupported}.
 * - **Close codes say whether to come back.** {@link isFinal} is true for a
 *   close that ends the connection for good; any other close reconnects after
 *   {@link reconnect}'s backoff.
 *
 * The module is pure, so the room in a Worker and the page in a browser share
 * one definition.
 *
 * @since 1.0.0-rc.17
 */
/**
 * The largest state one participant may hold: 1 KiB of UTF-8.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const maxStateBytes = 1024;
/**
 * The largest frame a page may send: 2 KiB of UTF-8.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const maxFrameBytes = 2048;
/**
 * The most connections one room holds at once.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const maxParticipants = 256;
/**
 * The most host-only data one connection may carry: 512 bytes of UTF-8.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const maxDataBytes = 512;
/**
 * The close codes the room uses.
 *
 * - `left` (1000): the page left, or the room closed normally; final.
 * - `unsupported` (1003): a binary frame, or one {@link decodeClientFrame}
 *   refuses, a state over {@link maxStateBytes} included; final.
 * - `noAccess` (1008): the participant may not join, or lost access; final.
 * - `tooBig` (1009): a frame over {@link maxFrameBytes}; final.
 * - `changed` (1012): the host changed this connection's identity or access;
 *   the page reconnects and joins as the new one.
 * - `full` (1013): the room holds {@link maxParticipants} already; the page
 *   reconnects later.
 *
 * A connection that drops without a close frame arrives as 1006 and
 * reconnects too.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const CloseCode: {
    readonly left: 1000;
    readonly unsupported: 1003;
    readonly noAccess: 1008;
    readonly tooBig: 1009;
    readonly changed: 1012;
    readonly full: 1013;
};
/**
 * Whether a close code ends the connection for good: no reconnect follows.
 *
 * @category close codes
 * @since 1.0.0-rc.17
 */
export declare const isFinal: (code: number) => boolean;
/**
 * How a page reconnects after a close that is not final: after `initialMs`,
 * doubling up to `maxMs`, at most `maxAttempts` times in a row. A connection
 * that receives a roster resets the count.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const reconnect: {
    readonly initialMs: 1000;
    readonly maxMs: 30000;
    readonly maxAttempts: 10;
};
/**
 * The delay before reconnect attempt `attempt` (1 for the first), or
 * `undefined` once `reconnect.maxAttempts` attempts have been spent.
 *
 * @category close codes
 * @since 1.0.0-rc.17
 */
export declare const reconnectDelay: (attempt: number) => number | undefined;
/**
 * What a participant may do on the page the room covers: change it
 * (`write`) or only watch (`read`). The room reports it and enforces nothing
 * with it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Access = "read" | "write";
/**
 * One connection in a room.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Participant {
    /** The connection's id: a UUID the room makes when it joins. */
    readonly id: string;
    /** Who it is, as the host's authentication says. */
    readonly principal: string;
    /** The name to show, such as a GitHub login. */
    readonly name: string;
    /** What the host lets it do. */
    readonly access: Access;
    /** The page's own opaque state, at most {@link maxStateBytes}; `null` until it sends one. */
    readonly state: string | null;
}
/**
 * A page's frame: its latest state.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ClientFrame {
    readonly type: "state";
    readonly state: string | null;
}
/**
 * The room's frame: every participant in join order, `self` included.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ServerFrame {
    readonly type: "roster";
    /** This connection's own participant id. */
    readonly self: string;
    readonly participants: ReadonlyArray<Participant>;
}
/**
 * Encodes a page's frame as a text frame.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export declare const encodeClientFrame: (frame: ClientFrame) => string;
/**
 * Decodes a page's text frame, or `undefined` for text over
 * {@link maxFrameBytes}, malformed JSON, any other shape, or a state over
 * {@link maxStateBytes}.
 *
 * @category decoding
 * @since 1.0.0-rc.17
 */
export declare const decodeClientFrame: (text: string) => ClientFrame | undefined;
/**
 * Encodes a room's frame as a text frame.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export declare const encodeServerFrame: (frame: ServerFrame) => string;
/**
 * Decodes a room's text frame, or `undefined` for malformed JSON, any other
 * shape, more than {@link maxParticipants} participants, or a state over
 * {@link maxStateBytes}.
 *
 * @category decoding
 * @since 1.0.0-rc.17
 */
export declare const decodeServerFrame: (text: string) => ServerFrame | undefined;
