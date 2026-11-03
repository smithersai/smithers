/**
 * The authored artifact of one link: flow-script text plus its content
 * digest.
 *
 * The digest is the replay identity of every call the script makes
 * (https://chain.smithers.sh/contract/). Extraction implements gate 1
 * (shape): the author's output must contain exactly one fenced flow block.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * A link's flow-script text paired with the content digest that keys every
 * call it makes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Script: Schema.Struct<{
    readonly text: Schema.String;
    readonly digest: Schema.String;
}>;
/**
 * The decoded form of {@link Script}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Script = typeof Script.Type;
/**
 * Builds a script from its text, digesting it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (text: string) => Script;
/**
 * The result of applying the shape gate: an extracted script, or the
 * rejection prose the next authoring reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Extraction = {
    readonly _tag: "Extracted";
    readonly script: Script;
} | {
    readonly _tag: "Rejected";
    readonly reason: string;
};
/**
 * Applies the shape gate to raw author output: exactly one fenced `flow`
 * block, whose body becomes the script. The block opens with three or more
 * backticks followed by `flow` and closes on a line holding only at least
 * as many backticks, so a longer opening fence can carry inner fences.
 * CRLF line endings are read as LF, so the script text always uses LF.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export declare const extract: (raw: string) => Extraction;
