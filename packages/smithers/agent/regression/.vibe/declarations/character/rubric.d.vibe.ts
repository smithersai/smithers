import * as Rubric from "../../../../scorers/src/Rubric.ts";
import * as Subject from "../../../character/subject.ts";
import type * as Suite from "../../../character/suite.ts";
import type { Labelled } from "../../../character/rubric.vibe.platform.js";
export { judgeKey, loadCalibration, version } from "../../../character/rubric.vibe.platform.js";
export type { Labelled } from "../../../character/rubric.vibe.platform.js";
/** The criteria. Ids are stable: reports and calibration files use them. */
export declare const criteria: ReadonlyArray<Rubric.Criterion>;
/** Instructions that frame the judge. */
export declare const instructions: string;
/** The anchors shown to the judge: the examples marked `anchor: true`. */
export declare const anchors: (labelled: ReadonlyArray<Labelled>) => Array<Rubric.Example>;
/** Summarises what a turn did, one line per action, for the judge. */
export declare const actionsSummary: (actions: Subject.Turn["actions"]) => string;
/**
 * Every message a person reads in this turn, in full, for the judge: the
 * reply first (or "(no reply)"), then each message by where it went.
 */
export declare const judgedOutput: (trigger: Suite.Message, turn: Subject.Turn) => string;
/**
 * Whether a saved conversation needs the judge again on a rescore: it had no
 * verdict (its checks failed then, or the judge was off), or the verdict was
 * made under other notes or another rubric. A saved run without a key is
 * judged again, since nothing says what its verdict depended on.
 */
export declare const needsJudge: (saved: {
    readonly checksPass: boolean;
    readonly judge?: string | undefined;
    readonly judgeKey?: string | undefined;
}, key: string) => boolean;
/** Usage of the judge's calls, like the role's. */
export declare const judgeUsage: Array<Subject.Usage>;
/**
 * A judge on a live seat: one plain model call per verdict, on a seat
 * resolved for that call alone (see `Subject.resolveLive`).
 */
export declare const seatJudge: (seatId: string, root: string, effort?: "low" | "medium" | "high") => Rubric.Judge<never>;
/** Declares the rubric scorer over a judge. */
export declare const make: (judge: Rubric.Judge<never>, examples: ReadonlyArray<Rubric.Example>) => import("@smthrs/scorers/Scorer").Scorer<never>;
