import * as Schema from "effect/Schema";
import * as Home from "../.vibe/declarations/src/Home.vibe";
import * as Target from "./Target.ts";
/**
 * Maximum length of one declared flow id.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumIdLength = 256;
/**
 * The shape of a discovered flow id: path segments of letters, digits, `-`,
 * `_`, and `.`, joined by `/`, exactly as discovery derives them from the
 * directory path below `flows/`.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const idPattern: RegExp;
/**
 * Schema for one inert flow declaration.
 *
 * `summary` is absent rather than empty when a declaration carries none, and
 * `featured` is always present, so a catalog row never has to guess at a
 * default the declaration did not state.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Declaration: Schema.TaggedStruct<"FlowDeclaration", {
    /** The flow id, the directory path below `flows/`. */
    readonly flow: Schema.NonEmptyString;
    /** The one-line summary a listing shows under the id. */
    readonly summary: Schema.optional<Schema.NonEmptyString>;
    /** Whether the repository recommends this flow first. */
    readonly featured: Schema.Boolean;
    /** The view the flow draws: on the run's monitor, and as the repository's default view when the home names it. */
    readonly view: Schema.optional<Schema.NonEmptyArray<Schema.Union<readonly [Schema.Struct<{
        readonly type: Schema.Literal<"text">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly text: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"links">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly links: Schema.NonEmptyArray<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"flows">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"prompt">;
        readonly flow: Schema.optional<Schema.NonEmptyString>;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly placeholder: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stack">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"app">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
    }>]>>>;
}>;
/**
 * One inert flow declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type;
/**
 * What a `FACTORY.ts` writes to declare a flow's presentation.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Target.Presentation {
    /** The flow id, the directory path below `flows/`. */
    readonly flow: string;
    /** The view the flow draws, from the declared blocks a view may hold (`Home.FlowViewBlock`). */
    readonly view?: ReadonlyArray<typeof Home.FlowViewBlock.Type> | undefined;
}
/**
 * Declares how the repository presents one of its flows.
 *
 * The declaration is validated where it is written: the id has to be a
 * discovery-shaped path, the summary one non-empty line, and `featured` a
 * boolean. Whether the id names a flow that exists is decided when the
 * catalog is rendered, because only discovery knows.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const review = Smithers.Flow({
 *   flow: "review",
 *   summary: "Review the working-copy change and return a verdict with reasons.",
 *   featured: true
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Flow: (options: Options) => Declaration;
