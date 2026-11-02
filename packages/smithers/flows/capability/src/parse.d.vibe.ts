/**
 * The exact capability parser for the `action:resource` text form.
 *
 * @since 0.1.0
 */
import { Option } from "effect";
import type { Capability } from "./ExactCapability.vibe";
/**
 * Parses an exact capability. The action is the first two colon-separated
 * components; all remaining text belongs to the resource.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export declare const parse: (input: string) => Option.Option<Capability>;
