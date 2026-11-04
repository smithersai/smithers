/**
 * Defect recorded when a trampoline lineage runs past its declared round budget.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const MaxRoundsExceeded_base: Schema.Class<MaxRoundsExceeded, Schema.TaggedStruct<"@smthrs/flow/MaxRoundsExceeded", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"max_rounds_exceeded">>;
    readonly flowName: Schema.String;
    readonly lineageId: Schema.String;
    readonly maxRounds: Schema.Number;
    readonly roundOrdinal: Schema.Number;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A lineage asked for one more round than its flow's `maxRounds` allows.
 *
 * `docs/concepts/trampoline-rounds.md` chooses a budget over loop
 * detection: identical consecutive rounds are legal (a poller is exactly
 * that), so the only honest stop condition is a declared bound on how many
 * rounds one lineage may open. Exceeding it is terminal for the lineage — the
 * round that asked for the handoff is settled with this defect rather than
 * handed off — because a lineage that has run out of budget has nowhere left
 * to continue, and letting it keep going would make the bound advisory.
 *
 * `roundOrdinal` is the zero-based ordinal of the round that was refused, so
 * it always equals `maxRounds` when the refusal is raised.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class MaxRoundsExceeded extends MaxRoundsExceeded_base {
}
export {};
