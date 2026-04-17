export type WatchLoopResult<T> = {
    intervalMs: number;
    tickCount: number;
    stoppedBySignal: boolean;
    reachedTerminal: boolean;
    signal?: NodeJS.Signals;
    lastData: T;
};
