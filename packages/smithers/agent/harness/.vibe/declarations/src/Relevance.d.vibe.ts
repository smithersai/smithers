/**
 * What a run is shown of the human-provided items it could be shown.
 *
 * Memory rows, catalog flows and skills, and chunks of instruction files such
 * as `AGENTS.md` are items. {@link judge} asks Jev one question about each:
 * is it unnecessary for the task as stated? An item is withheld only when Jev
 * says so with probability at or above {@link withholdAt}; everything else is
 * kept. An item longer than {@link itemBytes} is sent head-kept and always
 * kept: Jev cannot be confident about text it was not shown. A reading that
 * cannot be judged keeps everything, and the caller
 * journals `decision-unjudged` for it: keeping is the rule, withholding is
 * the exception Jev must be confident of.
 *
 * Nothing here journals or filters a live catalog. {@link settled} is the row
 * a caller writes for a reading, and {@link render} the instruction block a
 * caller builds from what was kept.
 *
 * @since 1.0.0-rc.0
 */
import type * as Evaluator from "@smthrs/model/Evaluator";
import type * as Descriptor from "@smthrs/registry/Descriptor";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AgentEvent from "../../../src/AgentEvent.ts";
import * as Judgement from "../../../src/Judgement.ts";
/**
 * What an item is.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const Kind: Schema.Literals<readonly ["flow", "skill", "instruction", "memory"]>;
/**
 * The decoded form of {@link Kind}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Kind = typeof Kind.Type;
/**
 * One human-provided item a run could be shown.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Item: Schema.Struct<{
    readonly kind: Schema.Literals<readonly ["flow", "skill", "instruction", "memory"]>;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * The decoded form of {@link Item}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Item = typeof Item.Type;
/**
 * What every reading is told beside its items.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Context: Schema.Struct<{
    readonly task: Schema.String;
    readonly query: Schema.optionalKey<Schema.String>;
    readonly recent: Schema.optionalKey<Schema.String>;
}>;
/**
 * The decoded form of {@link Context}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Context = typeof Context.Type;
/**
 * The probability of "unnecessary" at or above which an item is withheld.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const withholdAt = 0.9;
/**
 * The most of one item's text a reading carries, in UTF-8 bytes; the head
 * kept.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const itemBytes = 1024;
/**
 * The reading: one question per item, `unnecessary_${index}`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const reader: Judgement.PerItem<{
    readonly task: string;
    readonly query?: string;
    readonly recent?: string;
}, {
    readonly kind: "flow" | "instruction" | "memory" | "skill";
    readonly id: string;
    readonly text: string;
}, {
    readonly unnecessary: (i: number) => Evaluator.BooleanQuestion;
}>;
/**
 * Jev's verdict on one item. `p` is the probability it is unnecessary.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Verdict {
    readonly item: Item;
    /** `Digest.digest` of the item's whole text. */
    readonly digest: string;
    readonly p: number;
    readonly withheld: boolean;
}
/**
 * One reading: a verdict per item in input order, and the record of asking.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Reading {
    readonly verdicts: ReadonlyArray<Verdict>;
    readonly asked: ReadonlyArray<Judgement.Asked>;
    /** Wall-clock milliseconds the reading took. */
    readonly latencyMs: number;
    /** Token usage summed over every request, absent when none reported any. */
    readonly usage?: Evaluator.Usage | undefined;
}
/**
 * Asks Jev which of `items` the run does not need. Each item's text is sent
 * head-kept to {@link itemBytes}, and an item that was cut is never withheld.
 * No items ask nothing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const judge: (context: Context, items: ReadonlyArray<Item>) => Effect.Effect<Reading, Judgement.Unjudged>;
/**
 * The `relevance-settled` row for a reading: ids and digests, never text.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const settled: (reading: Reading, at: {
    readonly scope: string;
    readonly frame: number;
    readonly source: AgentEvent.RelevanceSettled["source"];
}) => AgentEvent.RelevanceSettled;
/**
 * A catalog entry as an item: a `skill` when its body is markdown, else a
 * `flow`. Its description is untrusted data.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const flowItem: (descriptor: Descriptor.FlowDescriptor) => Item;
/**
 * One human-provided instruction file.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Document: Schema.Struct<{
    readonly path: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * The decoded form of {@link Document}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Document = typeof Document.Type;
/**
 * One piece of an instruction file, as {@link chunks} splits it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Chunk {
    /** `${path}#${n}`, `n` counting from 0 within the file. */
    readonly id: string;
    readonly path: string;
    readonly text: string;
}
/**
 * Splits instruction files into the chunks a reading judges, in order.
 *
 * A chunk starts at each markdown heading and at each top-level list item,
 * whose indented and wrapped lines are its own. Every other line, blank lines
 * included, joins the chunk before it, and nothing inside a fence is split.
 * A file's chunks concatenate back to the file.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const chunks: (documents: ReadonlyArray<Document>) => ReadonlyArray<Chunk>;
/**
 * The project-instructions block of every chunk not in `withheld`, in order.
 * A file whose every chunk is withheld is left out, and `""` is returned when
 * nothing is left.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const render: (documents: ReadonlyArray<Document>, withheld: ReadonlySet<string>) => string;
