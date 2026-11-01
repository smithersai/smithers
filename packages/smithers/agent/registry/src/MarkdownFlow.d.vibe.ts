/**
 * Discovery and prompt rendering for markdown-backed flows.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */
import type * as CoreMarkdown from "@smthrs/core/Markdown";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type DiscoveryWarning, FlowBodyPrompt, type FlowBudget, type FlowDescriptor as FlowDescriptorType, type Provenance } from "./Descriptor.js";
/**
 * The fixed decoded input schema for markdown flows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Input: Schema.Struct<{
    readonly args: Schema.String;
}>;
/**
 * The decoded input accepted by every markdown flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type;
/**
 * The fixed output schema for markdown flows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Output: Schema.String;
/**
 * The prompt text returned by a markdown flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type;
/**
 * Parameters used to derive a descriptor from already-read markdown text.
 *
 * @category models
 * @since 0.1.0
 */
export interface FromMarkdownOptions {
    readonly text: string;
    /** SHA-256 of the complete source when the supplied text is a metadata prefix. */
    readonly contentDigest?: string | undefined;
    readonly path: string;
    readonly baseDirectory: string;
    readonly naming: "path" | "frontmatter";
    readonly name: Option.Option<string>;
    readonly dirBasename: string;
    readonly provenance: Provenance;
}
/**
 * The metadata result of markdown flow discovery.
 *
 * @category models
 * @since 0.1.0
 */
export interface FromMarkdownResult {
    readonly descriptor: Option.Option<FlowDescriptorType>;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
}
/**
 * Derives a markdown flow descriptor without retaining the prompt body.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const fromMarkdown: (options: FromMarkdownOptions) => FromMarkdownResult;
/**
 * Loads a markdown prompt body after discovery, removing only leading frontmatter.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const loadBody: (text: string, baseDirectory: string) => FlowBodyPrompt;
/**
 * Renders decoded markdown-flow arguments using the compatible skill convention.
 *
 * @category rendering
 * @since 0.1.0
 */
export declare const renderPrompt: (body: FlowBodyPrompt, input: {
    readonly args: string;
}) => string;
/**
 * Projects a registry descriptor into the one authoring value accepted by
 * `/core/Markdown`. This is the deliberate registry-to-core adapter
 * boundary; metadata is not independently reinterpreted downstream.
 *
 * Every limit the author declared crosses it: `modelInvocable`, the budget's
 * ceilings, its `deadline` (the descriptor folds it into `budget`; core takes
 * it as the flow's own deadline), and the sandbox selection.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const toCoreFrontmatter: (descriptor: FlowDescriptorType) => CoreMarkdown.MarkdownFrontmatter;
/**
 * Reads a declared budget: the tokens, milliseconds and dollars this flow
 * asks a control plane to approve for one of its runs, and what exceeding them
 * does. Frontmatter declares it in YAML; a module declares the same keys as a
 * `Flow.make` literal, which discovery reads into `fields.budget` and names
 * in warnings by `label`.
 *
 * ```yaml
 * budget:
 *   tokens: 120000
 *   milliseconds: 900000
 *   usd: 2.5
 *   onExceeded: park
 * ```
 *
 * A malformed budget is dropped rather than tightened, which is the opposite of
 * how every other field here reads a malformed value. The other fields have a
 * conservative reading to fall back on; a budget has none. Its conservative
 * number is zero, and a zero ceiling refuses the run's first call, so a typo
 * would be reported as a spending decision. An unreadable declaration therefore
 * leaves the flow exactly where an undeclared one leaves it, unbounded, and
 * says so in a warning an operator reads back through `registry.warnings()`.
 *
 * @category parsing
 * @since 1.0.0-rc.1
 */
export declare const deriveBudget: (fields: Record<string, unknown>, path: string, warnings: Array<DiscoveryWarning>, label?: string) => FlowBudget | undefined;
