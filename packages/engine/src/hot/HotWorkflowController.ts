import { Effect } from "effect";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { HotReloadOptions } from "@smithers/driver/RunOptions";
import { SmithersError } from "@smithers/errors/SmithersError";
export type HotReloadEvent = {
    type: "reloaded";
    generation: number;
    changedFiles: string[];
    newBuild: SmithersWorkflow<any>["build"];
} | {
    type: "failed";
    generation: number;
    changedFiles: string[];
    error: unknown;
} | {
    type: "unsafe";
    generation: number;
    changedFiles: string[];
    reason: string;
};
export declare class HotWorkflowController {
    private entryPath;
    private hotRoot;
    private outDir;
    private maxGenerations;
    private watcher;
    private generation;
    private closed;
    constructor(entryPath: string, opts?: HotReloadOptions);
    /** Initialize: start file watchers. Call once before using wait/reload. */
    init(): Promise<void>;
    /** Current generation number. */
    get gen(): number;
    /**
     * Wait for the next file change event.
     * Returns the list of changed file paths.
     * Use this in Promise.race with inflight tasks to wake the engine loop.
     */
    wait(): Promise<string[]>;
    /**
     * Perform a hot reload:
     * 1. Build a new generation overlay
     * 2. Import the workflow module from the overlay
     * 3. Validate the module
     * 4. Return the result (reloaded, failed, or unsafe)
     *
     * The caller is responsible for swapping workflow.build on success.
     */
    reload(changedFiles: string[]): Promise<HotReloadEvent>;
    initEffect(): Effect.Effect<void, SmithersError, never>;
    waitEffect(): Effect.Effect<string[], never, never>;
    reloadEffect(changedFiles: string[]): Effect.Effect<{
        type: "failed";
        generation: number;
        changedFiles: string[];
        error: SmithersError;
        newBuild?: undefined;
    } | {
        type: "reloaded";
        generation: number;
        changedFiles: string[];
        newBuild: (ctx: import("smithers").SmithersCtx<any>) => import("react/jsx-runtime").JSX.Element;
        error?: undefined;
    } | {
        type: "unsafe";
        generation: number;
        changedFiles: string[];
        reason: string;
        error?: undefined;
    } | {
        type: "failed";
        generation: number;
        changedFiles: string[];
        error: SmithersError;
        reason?: undefined;
    }, never, never>;
    /** Stop watchers and clean up overlay directory. */
    close(): Promise<void>;
    closeEffect(): Effect.Effect<void, never, never>;
}
