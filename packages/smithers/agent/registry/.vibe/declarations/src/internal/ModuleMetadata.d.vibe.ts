/**
 * Metadata extraction from a discovered flow module: its description, its
 * declared schemas, and the effect envelope inferred from what it calls.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type EffectDeclaration, ModelSelection, type Placement } from "../Descriptor.vibe";
/**
 * @since 0.1.0
 * @private
 */
export interface MetadataWarning {
    readonly line?: number;
    readonly message: string;
}
/**
 * @since 0.1.0
 * @private
 */
export interface Metadata {
    readonly description: string | undefined;
    readonly hasInput: boolean;
    readonly inputDocument?: Schema.Json;
    readonly hasOutput: boolean;
    readonly model: Option.Option<ModelSelection>;
    readonly flows: ReadonlyArray<string>;
    readonly capabilities: ReadonlyArray<string>;
    readonly effects: EffectDeclaration;
    readonly placement: Option.Option<Placement>;
    readonly modelInvocable: boolean;
    /**
     * The declared `budget` literal's members, each a literal value or, when it
     * is not one, its source text, so the budget reader refuses it by name
     * rather than reading it as undeclared.
     */
    readonly budget?: Record<string, unknown>;
    readonly prompt?: true;
    readonly declaresName: boolean;
    /**
     * The name the module declares, when it is a readable string literal.
     *
     * `None` covers both a module that declares none and one whose name is an
     * expression this reader cannot evaluate, which is why {@link declaresName}
     * is a separate answer: a name that is present but unreadable cannot be
     * checked against the path, and a caller that must decide treats it as a
     * name it has to warn about rather than as no name at all.
     */
    readonly declaredName: Option.Option<string>;
    /**
     * The tag `Flow.make("<tag>", { ... })` declares as its first argument,
     * when it is a readable string literal. A record declaration, or a tag this
     * reader cannot evaluate, has none.
     */
    readonly tag: Option.Option<string>;
    readonly warnings: ReadonlyArray<MetadataWarning>;
}
/**
 * One lexical token of module source.
 *
 * An identifier's `value` is its name with every `\u` escape decoded, so
 * `requir\u0065` reads as the `require` binding it is. `escaped` marks such
 * a name: an escaped name is never a keyword. A private name keeps its `#`.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @private
 */
export interface Token {
    readonly kind: "identifier" | "number" | "punctuation" | "regex" | "string" | "unparsed";
    readonly value: string;
    readonly start: number;
    readonly end: number;
    readonly escaped?: true;
}
/**
 * How {@link tokenize} reads a `/` whose meaning the tokens before it do not
 * settle.
 *
 * Two places are ambiguous to a lexer. A `/` that starts a line after a name,
 * a literal, `)` or `]` is a division in JavaScript, but begins a regular
 * expression after a TypeScript type annotation (`let x: string` then a line
 * starting `/re/`). A `/` after `}` begins a regular expression after a block
 * and is a division after an object literal. `"likely"` reads the first as a
 * division and the second as a regular expression; `"alternate"` reads each
 * the other way. A reader that must not miss code reads both.
 *
 * @category parsing
 * @since 1.0.0
 * @private
 */
export type SlashReading = "likely" | "alternate";
/**
 * Splits module source into tokens, skipping strings, comments, and regular
 * expressions.
 *
 * Exported so {@link module:ModuleClosure} reads import specifiers with the
 * same lexer this module reads declarations with. A second scanner would be a
 * second answer to "is this `import` real code or a word inside a comment",
 * and the two would drift. `reading` says how a `/` the tokens cannot settle
 * is read; see {@link SlashReading}.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export declare const tokenize: (source: string, reading?: SlashReading) => ReadonlyArray<Token>;
/**
 * Returns whether the default flow declaration is complete in a source prefix.
 * @category predicates
 *
 * @since 0.1.0
 * @private
 */
export declare const isComplete: (source: string) => boolean;
/**
 * The value of a quoted literal, or `undefined` for anything else — an
 * unterminated quote, or a template carrying a substitution, whose value is
 * not decidable without running the module.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export declare const stringLiteral: (source: string | undefined) => string | undefined;
/**
 * Statically reads the metadata carried by the default `Flow.make` value
 * without evaluating the module.
 * @category parsing
 *
 * @since 0.1.0
 * @private
 */
export declare const parse: (source: string) => Metadata;
