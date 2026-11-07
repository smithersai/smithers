import { Host } from "@smthrs/plugin";
import { Effect } from "effect";
/** One open wait, as `core/waits` has it. */
export interface Wait {
    readonly runId: string;
    readonly version: number;
    readonly execution: string;
    readonly kind: "question" | "approval";
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
    readonly question: boolean;
    readonly approval: boolean;
    readonly createdAt: string;
}
/** Where the queue stands: the item shown, its place (0 first) and how many wait. */
export interface Current {
    readonly item: Wait | undefined;
    readonly index: number;
    readonly total: number;
}
/** The queue's view. */
export declare const VIEW = "queue/queue";
/** Where the cursor moves to: `index` kept inside `total` items, `0` when there are none. */
export declare const clamp: (index: number, total: number) => number;
/**
 * Where the cursor goes when the waits change: it stays on its item, or, when that one left (answered here or on
 * another device), on the item that took its place.
 */
export declare const follow: (rows: ReadonlyArray<{
    readonly runId: string;
}>, runId: string | undefined, index: number) => number;
/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
    readonly current: () => A;
    readonly subscribe: (listener: () => void) => () => void;
}
/** What the queue's components read and do. */
export interface QueueTab {
    readonly queries: {
        readonly waits: Host.Live<Wait>;
        readonly current: Watched<Current>;
    };
    readonly actions: {
        readonly open: () => void;
    };
}
/** The tab: built by the host in the plugin's scope on first use. */
export declare const tab: Effect.Effect<{
    queries: {
        waits: Host.Live<Wait>;
        current: {
            current: () => Current;
            subscribe: (listener: () => void) => () => undefined;
        };
    };
    actions: {
        open: () => undefined;
    };
}, Host.PluginRefused, Host.PluginHost | import("effect/Scope").Scope>;
