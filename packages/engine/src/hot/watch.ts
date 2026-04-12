import { Effect } from "effect";
export type WatchTreeOptions = {
    /** Patterns to ignore (directory basenames) */
    ignore?: string[];
    /** Debounce interval in ms (default: 100) */
    debounceMs?: number;
};
export declare class WatchTree {
    private watchers;
    private rootDir;
    private ignore;
    private debounceMs;
    private changedFiles;
    private debounceTimer;
    private waitResolve;
    private closed;
    constructor(rootDir: string, opts?: WatchTreeOptions);
    /** Start watching. Call once. */
    start(): Promise<void>;
    /**
     * Returns a promise that resolves with changed file paths
     * the next time file changes are detected (after debounce).
     * Can be called repeatedly.
     */
    wait(): Promise<string[]>;
    /** Stop all watchers and clean up. */
    close(): void;
    startEffect(): Effect.Effect<void, import("smithers").SmithersError, never>;
    waitEffect(): Effect.Effect<string[], never, never>;
    private shouldIgnore;
    private watchDir;
    private onFileChange;
    private flush;
}
