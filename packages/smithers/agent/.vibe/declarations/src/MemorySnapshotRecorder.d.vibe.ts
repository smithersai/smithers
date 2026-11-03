/**
 * The durable implementation of `@smthrs/memory/SnapshotRecorder`.
 *
 * Memory declares the port and remains below the harness. This adapter lives
 * in `@smthrs/agent`, which already depends on both packages, and translates a
 * snapshot identity into an `EngineLike.record` boundary that holds the
 * snapshot's rows.
 *
 * @since 0.1.0
 */
import * as EngineLike from "@smthrs/harness/EngineLike";
import * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder";
import * as Layer from "effect/Layer";
/**
 * Builds the memory recorder backed by a harness engine.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (engine: EngineLike.EngineLike) => SnapshotRecorder.Service;
/**
 * Provides durable opening-memory snapshots through the current harness
 * engine.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<SnapshotRecorder.SnapshotRecorder, never, EngineLike.EngineLike>;
