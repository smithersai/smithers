import type * as Suite from "./suite.ts";
/** The rubric version: bump it when a criterion or the instructions change, and re-run every suite's calibration. */
export declare const version = "2";
/** A labelled calibration example as the file stores it. */
export interface Labelled {
    readonly id: string;
    readonly verdict: "pass" | "fail";
    readonly context: string;
    readonly output: string;
    readonly focus?: string | undefined;
    readonly why: string;
    readonly anchor?: boolean | undefined;
}
/** Loads a calibration file (`examples:` list). */
export declare const loadCalibration: (path: string) => ReadonlyArray<Labelled>;
/** What a judge verdict on this case depends on besides the turn itself: the rubric version and each turn's judge notes. */
export declare const judgeKey: (suiteCase: Pick<Suite.Case, "turns">) => string;
