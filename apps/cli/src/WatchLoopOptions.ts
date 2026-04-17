import type { WatchRenderContext } from "./WatchRenderContext.ts";

export type WatchLoopOptions<T> = {
    intervalSeconds: number;
    clearScreen?: boolean;
    fetch: () => Promise<T>;
    render: (snapshot: T, context: WatchRenderContext) => Promise<void> | void;
    isTerminal?: (snapshot: T) => boolean;
};
