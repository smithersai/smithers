/**
 * Safe, compact copy for typed model and harness failures.
 *
 * @since 1.0.0-rc.1
 */
import { Fault as Faults } from "@smthrs/flow";
/**
 * Whose action can repair a stopped run: the registered class of the failure.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Fault = Faults.Class;
/**
 * Keys a failure surface can offer.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Action = "resume" | "switch-model" | "wait" | "details";
/**
 * Safe copy shown outside technical details.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Description {
    readonly headline: string;
    readonly fault: Fault;
    readonly line: string;
    readonly actions: ReadonlyArray<Action>;
}
/**
 * The account a seat or route runs on, by its provider prefix: `OpenAI`,
 * `Anthropic`, or `Model` when the prefix is unknown.
 * @category utilities
 * @since 1.0.0
 */
export declare const provider: (seat: string | undefined) => string;
/**
 * Walks wrapped causes and turns typed failure codes into safe UI copy.
 * @category utilities
 * @since 1.0.0-rc.1
 */
export declare const describe: (error: unknown, seat?: string) => Description;
