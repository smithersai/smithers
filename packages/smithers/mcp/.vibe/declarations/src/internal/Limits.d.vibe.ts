/**
 * Positive-integer option bounds shared by the transport and the client.
 *
 * Both `connect` functions resolve their defaults and then reject the first
 * option that is not a positive safe integer, before any process is spawned.
 * The check and its error prose live here so the two option lists cannot
 * drift in wording or in semantics.
 *
 * @since 1.0.0-rc.0
 */
import { Effect } from "effect";
import { McpError } from "../McpError.vibe";
/**
 * Builds the `protocol_error` failure both modules report for malformed
 * options and frames.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare const protocolError: (server: string, message: string) => McpError;
/**
 * Whether a value is a positive safe integer.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const isPositiveInteger: (value: number) => boolean;
/**
 * Fails with `protocol_error` naming the first option whose resolved value is
 * not a positive safe integer. Entries are checked in the order given.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const checkPositiveIntegers: (server: string, entries: ReadonlyArray<readonly [name: string, value: number]>) => Effect.Effect<void, McpError>;
