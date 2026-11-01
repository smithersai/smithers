/**
 * Agent Skills frontmatter support.
 *
 * Governing contracts:
 * `packages/smithers/flows/core/docs/api.md`, published as https://smithers.sh/docs/reference/api/core,
 * and https://agentskills.io/specification.
 *
 * @since 0.0.0
 */
import * as Result from "effect/Result";
/**
 * Separates leading SKILL.md frontmatter from its markdown body.
 *
 * @since 0.0.0
 * @category parsing
 * @slop
 */
export declare const split: (text: string) => {
    readonly frontmatter: string | undefined;
    readonly body: string;
};
/**
 * Parses complete Agent Skills YAML using YAML's failsafe schema. Failsafe
 * parsing preserves scalar strings while accepting unmodified third-party
 * frontmatter, including folded and literal block scalars. A mapping at any
 * depth that uses the reserved key `__proto__`, `constructor`, or `prototype`
 * is refused, as is an alias that refers back to its own anchor.
 *
 * @since 0.0.0
 * @category parsing
 * @slop
 */
export declare const parse: (frontmatter: string) => Result.Result<Record<string, unknown>, string>;
