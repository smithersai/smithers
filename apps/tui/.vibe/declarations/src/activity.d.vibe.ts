import { type JournalRecord, type TraceModel } from "@smthrs/gateway/RunTrace";
import type { AgentEvent } from "@smthrs/harness/AgentEvent";
/** Stored model calls keep timing and identity without the growing request. */
export type Unrequested = Omit<Extract<AgentEvent, {
    _tag: "model-requested";
}>, "request"> & {
    readonly request?: undefined;
};
export type Observed = AgentEvent | Unrequested;
export interface Activity {
    readonly records: ReadonlyArray<JournalRecord>;
    readonly status: "running" | "completed" | "failed" | "cancelled";
}
export declare const empty: Activity;
export declare const apply: (activity: Activity, event: Observed, at: number) => Activity;
/** The frame ordinal a sequence was recorded in: 1-based, 0 before the first frame. */
export declare const frameAt: (activity: Activity, seq: number) => number;
/** How many frames the journal opened. */
export declare const frames: (activity: Activity) => number;
/** Where each frame opened, in order. */
export declare const openings: (activity: Activity) => ReadonlyArray<number>;
export declare const finish: (activity: Activity, status: "completed" | "failed" | "cancelled", at: number, message: string) => Activity;
export declare const model: (activity: Activity) => TraceModel;
/** The owner is journal order, including ties and regressing clocks. */
export declare const owner: (model: TraceModel, seq: number) => string;
