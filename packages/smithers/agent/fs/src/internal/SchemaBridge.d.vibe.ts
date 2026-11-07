/**
 * Bridges loaded Effect schemas to command-line shaped input.
 *
 * @private
 * @since 0.1.0
 */
import { Effect, Schema } from "effect";
import type * as Descriptor from "@smthrs/registry/Descriptor";
import { z } from "incur";
import { FsError } from "../FsError.vibe";
import * as Boundary from "./Boundary.ts";
/**
 * Positional values collected by the agent parser or Incur.
 *
 * @private
 * @since 0.1.0
 */
export type Positional = ReadonlyArray<string> | Readonly<Record<string, unknown>>;
/**
 * Input assembled before authoritative Effect schema decoding.
 *
 * @private
 * @since 0.1.0
 */
export interface Assembly {
    value: unknown;
}
/**
 * Declarative Incur descriptors plus the authoritative Effect decoder.
 *
 * @private
 * @since 0.1.0
 */
export interface CommandSchema {
    args: z.ZodObject<any> | undefined;
    options: z.ZodObject<any> | undefined;
    /** @throws {never} */
    assemble: (args: Positional, options: Readonly<Record<string, unknown>>) => Assembly;
    decode: (assembly: Assembly) => Effect.Effect<unknown, FsError>;
}
/**
 * Runs a program and turns any cause, defects included, into one sanitized
 * failure. A loaded flow's `Schema.Top` types its decoding services as
 * `unknown`; one that needs a service dies here, and that defect is the
 * failure too.
 *
 * @private
 * @since 0.1.0
 */
export declare function recover<A>(program: Effect.Effect<A, unknown, unknown>, failure: 
/** @throws {never} */
() => FsError): Effect.Effect<A, FsError>;
/**
 * Authoritatively decodes and snapshots one loaded flow input.
 *
 * @private
 * @since 0.1.0
 */
export declare function decodeInput(schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError>;
/**
 * Projects a loaded route input schema onto command-line args and options.
 *
 * @private
 * @since 0.1.0
 */
export declare function toCommandSchema(ref: Descriptor.SchemaRef, schema: Schema.Top): Effect.Effect<CommandSchema, FsError>;
/**
 * Encodes and snapshots a flow output through its declared schema.
 *
 * @private
 * @since 0.1.0
 */
export declare function encodeOutput(schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError>;
/**
 * Snapshots programmatic input before any module-loading await.
 *
 * @private
 * @since 0.1.0
 */
export declare function snapshotInput(input: unknown): Effect.Effect<Boundary.Json | undefined, FsError, never>;
