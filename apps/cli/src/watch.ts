export declare const WATCH_MIN_INTERVAL_MS = 500;
export type WatchRenderContext = {
    tickCount: number;
    initial: boolean;
};
export type WatchLoopResult<T> = {
    intervalMs: number;
    tickCount: number;
    stoppedBySignal: boolean;
    reachedTerminal: boolean;
    signal?: NodeJS.Signals;
    lastData: T;
};
export type WatchLoopOptions<T> = {
    intervalSeconds: number;
    clearScreen?: boolean;
    fetch: () => Promise<T>;
    render: (snapshot: T, context: WatchRenderContext) => Promise<void> | void;
    isTerminal?: (snapshot: T) => boolean;
};
export declare function clampWatchIntervalMs(requestedMs: number): number;
export declare function watchIntervalSecondsToMs(intervalSeconds: number): number;
export declare function runWatchLoop<T>(options: WatchLoopOptions<T>): Promise<WatchLoopResult<T>>;
