/**
 * Inert mise version-authority declarations and tool references.
 *
 * mise is the version pin authority for every toolchain layer in a
 * multi-language workspace: the `[tools]` table of the declared
 * `.mise.toml`/`mise.toml` keys the tools a target uses, so bumping one pin
 * invalidates exactly the targets keyed on that tool. This module declares
 * the config as a workspace toolchain layer and the `bin` reference a
 * target uses to name one config-pinned executable; resolution and the
 * typed host refusal when mise is absent live in the planner.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
import * as Input from "../../../src/Input.ts";
import * as Reference from "../../../src/Reference.ts";
/**
 * A mise config participating in the workspace toolchain layer list.
 *
 * @category declarations
 * @since 0.1.0
 */
export declare const Declaration: Schema.TaggedStruct<"Mise", {
    readonly config: Schema.TaggedStruct<"File", {
        readonly path: Schema.NonEmptyString;
    }>;
}>;
/**
 * A mise config participating in the workspace toolchain layer list.
 *
 * @category declarations
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type;
/**
 * Checks whether a value is an `S.Mise` declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export declare const isDeclaration: (value: unknown) => value is Declaration;
declare const make: (options: {
    readonly config: Input.File;
}) => Declaration;
/**
 * `S.Mise({ config })`, with `S.Mise.bin(name)` for config-pinned tools.
 *
 * @category declarations
 * @since 0.1.0
 */
export declare const Mise: typeof make & {
    readonly bin: (name: string) => Reference.MiseBin;
};
export {};
