import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
export type OverlayOptions = {
    /** Directory basenames to exclude from overlay */
    exclude?: string[];
};
/**
 * Build a generation overlay by hardlinking (or copying) the hot root
 * tree into a new generation directory.
 *
 * Returns the absolute path to the overlay directory.
 */
export declare function buildOverlayEffect(hotRoot: string, outDir: string, generation: number, opts?: OverlayOptions): Effect.Effect<string, SmithersError>;
export declare function buildOverlay(hotRoot: string, outDir: string, generation: number, opts?: OverlayOptions): Promise<string>;
/**
 * Remove old generation directories, keeping only the last `keepLast`.
 */
export declare function cleanupGenerationsEffect(outDir: string, keepLast: number): Effect.Effect<void, SmithersError>;
export declare function cleanupGenerations(outDir: string, keepLast: number): Promise<void>;
/**
 * Resolve the overlay entry path given the original entry path,
 * the hot root, and the overlay generation directory.
 */
export declare function resolveOverlayEntry(entryPath: string, hotRoot: string, genDir: string): string;
