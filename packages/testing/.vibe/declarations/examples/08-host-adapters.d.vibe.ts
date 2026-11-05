import * as Effect from "effect/Effect";
export interface Summary {
    readonly scriptedRead: string;
    readonly scriptedExec: string;
    readonly nodeRead: string;
    readonly nodeExec: string;
}
export declare const main: Effect.Effect<Summary>;
