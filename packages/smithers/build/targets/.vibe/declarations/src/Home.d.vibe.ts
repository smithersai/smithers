/**
 * The homepage a factory declares for its repository: `.smithers/home.json`.
 *
 * A repository's workspace chat opens with its homepage message, a README
 * alternative the maintainer declares in
 * `.smithers/FACTORY.ts` as `export const home = Smithers.Factory.Home({ blocks })`,
 * the second export beside the factory itself. Blocks are declared values,
 * never raw HTML, in the one home format `@smthrs/views` defines (`Home`),
 * which the app reads the file with. The app renders every block from data;
 * a string carrying an HTML tag is refused where it is written.
 *
 * The declaration is inert, like {@link Flow.Flow}. The `FactoryProjection`
 * target (`Factory.ts`) projects it into a checked-in JSON file beside
 * `.smithers/factory.json` the same way `ci.yml` and the root `tsconfig.json`
 * are projected: `write` renders it, `check` fails on drift, and the `lint`
 * verb never writes. The file is checked in so the public mirror serves it
 * signed out and a workspace without `node_modules` never has to evaluate
 * `FACTORY.ts`.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Maximum length of one block's title or one link's label (`Home.maximumTitleLength` of `@smthrs/views`).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumTitleLength = 120;
/**
 * Maximum length of one text block (`Home.maximumTextLength` of `@smthrs/views`).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumTextLength = 4096;
/**
 * Maximum length of one link URL (`Home.maximumUrlLength` of `@smthrs/views`).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumUrlLength = 2048;
/**
 * Maximum number of blocks one home declares (`Home.maximumBlocks` of `@smthrs/views`).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumBlocks = 32;
/**
 * The shape of raw HTML in a string (`Home.htmlPattern` of `@smthrs/views`): a
 * tag, a closing tag, a comment, or a processing instruction opener.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const htmlPattern: RegExp;
/**
 * A one-line title or label: non-empty, bounded, one line, no HTML.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Title: Schema.NonEmptyString;
/**
 * A paragraph of plain text: non-empty, bounded, no HTML.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Prose: Schema.NonEmptyString;
/**
 * A link target: an absolute `http` or `https` URL.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Url: Schema.NonEmptyString;
/**
 * A relative path that cannot escape the repository.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const RepositoryPath: Schema.NonEmptyString;
/**
 * A slash leaf name or repository flow id (`Home.FlowName` of `@smthrs/views`).
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PromptFlow: Schema.NonEmptyString;
/**
 * A paragraph of plain text under an optional title.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const TextBlock: Schema.Struct<{
    readonly type: Schema.Literal<"text">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly text: Schema.NonEmptyString;
}>;
/**
 * One link: the label the app shows and the URL it opens.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Link: Schema.Struct<{
    readonly label: Schema.NonEmptyString;
    readonly url: Schema.NonEmptyString;
}>;
/**
 * A list of links under an optional title.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const LinksBlock: Schema.Struct<{
    readonly type: Schema.Literal<"links">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly links: Schema.NonEmptyArray<Schema.Struct<{
        readonly label: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
    }>>;
}>;
/**
 * The repository's flows, which the app lists from its own catalog. The block carries no rows.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const FlowsBlock: Schema.Struct<{
    readonly type: Schema.Literal<"flows">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * A prompt: a heading over the way to ask, and the flow that takes the question.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PromptBlock: Schema.Struct<{
    readonly type: Schema.Literal<"prompt">;
    readonly flow: Schema.optional<Schema.NonEmptyString>;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly placeholder: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The pictures an app tile may wear: what the app's result looks like.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const AppPicture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
/**
 * An app: one flow's button, with a title and a picture.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const AppBlock: Schema.Struct<{
    readonly type: Schema.Literal<"app">;
    readonly flow: Schema.NonEmptyString;
    readonly title: Schema.NonEmptyString;
    readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
}>;
/**
 * A repository markdown file, read at the home's own commit.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const MarkdownBlock: Schema.Struct<{
    readonly type: Schema.Literal<"markdown">;
    readonly path: Schema.NonEmptyString;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The repository's live stack of changes, which the app reads itself. The block carries no rows.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const StackBlock: Schema.Struct<{
    readonly type: Schema.Literal<"stack">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The view a repository flow declares (`Smithers.Flow({ view })`), drawn here
 * in its place: `Factory.Home({ blocks: [Smithers.Home.View({ flow })] })`.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ViewBlock: Schema.Struct<{
    readonly type: Schema.Literal<"view">;
    readonly flow: Schema.NonEmptyString;
}>;
/**
 * One declared block: any kind `@smthrs/views` reads, the landing page's
 * (`hero`, `code`, `cards`, `stats`, `releases`) and the live ones (`issues`,
 * `runs`) included.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Block: Schema.Union<readonly [Schema.Struct<{
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
    readonly type: Schema.Literal<"markdown">;
    readonly path: Schema.NonEmptyString;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"stack">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"app">;
    readonly flow: Schema.NonEmptyString;
    readonly title: Schema.NonEmptyString;
    readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"view">;
    readonly flow: Schema.NonEmptyString;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"hero">;
    readonly title: Schema.NonEmptyString;
    readonly tagline: Schema.optional<Schema.NonEmptyString>;
    readonly text: Schema.optional<Schema.NonEmptyString>;
    readonly install: Schema.optional<Schema.NonEmptyString>;
    readonly actions: Schema.optional<Schema.NonEmptyArray<Schema.Struct<{
        readonly label: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
    }>>>;
    readonly announcement: Schema.optional<Schema.Struct<{
        readonly label: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
    }>>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"code">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly file: Schema.optional<Schema.NonEmptyString>;
    readonly language: Schema.optional<Schema.NonEmptyString>;
    readonly code: Schema.NonEmptyString;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"cards">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly cards: Schema.NonEmptyArray<Schema.Struct<{
        readonly title: Schema.NonEmptyString;
        readonly text: Schema.optional<Schema.NonEmptyString>;
        readonly label: Schema.optional<Schema.NonEmptyString>;
        readonly url: Schema.optional<Schema.NonEmptyString>;
    }>>;
    readonly more: Schema.optional<Schema.Struct<{
        readonly label: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
    }>>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"stats">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly stats: Schema.NonEmptyArray<Schema.Struct<{
        readonly value: Schema.NonEmptyString;
        readonly label: Schema.NonEmptyString;
    }>>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"releases">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly releases: Schema.NonEmptyArray<Schema.Struct<{
        readonly name: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
        readonly date: Schema.String;
        readonly summary: Schema.optional<Schema.NonEmptyString>;
    }>>;
    readonly more: Schema.optional<Schema.Struct<{
        readonly label: Schema.NonEmptyString;
        readonly url: Schema.NonEmptyString;
    }>>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"issues">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"runs">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"action">;
    readonly flow: Schema.NonEmptyString;
    readonly title: Schema.NonEmptyString;
    readonly key: Schema.optional<Schema.String>;
}>]>;
/**
 * One block of a flow's own view: every block that needs no server
 * resolution. A markdown block reads a file at main, which only the
 * homepage route resolves, and a view block inside a view would recurse.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const FlowViewBlock: Schema.Union<readonly [Schema.Struct<{
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
}>]>;
/**
 * The view a flow declares: its blocks, in declaration order.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const FlowView: Schema.NonEmptyArray<Schema.Union<readonly [Schema.Struct<{
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
}>]>>;
/**
 * One declared block.
 *
 * @category models
 * @since 1.0.0
 */
export type Block = typeof Block.Type;
/**
 * The home declaration `.smithers/FACTORY.ts` exports as `home`.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Declaration: Schema.TaggedStruct<"HomeDeclaration", {
    readonly blocks: Schema.NonEmptyArray<Schema.Union<readonly [Schema.Struct<{
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
        readonly type: Schema.Literal<"markdown">;
        readonly path: Schema.NonEmptyString;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stack">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"app">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"view">;
        readonly flow: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"hero">;
        readonly title: Schema.NonEmptyString;
        readonly tagline: Schema.optional<Schema.NonEmptyString>;
        readonly text: Schema.optional<Schema.NonEmptyString>;
        readonly install: Schema.optional<Schema.NonEmptyString>;
        readonly actions: Schema.optional<Schema.NonEmptyArray<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>>;
        readonly announcement: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"code">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly file: Schema.optional<Schema.NonEmptyString>;
        readonly language: Schema.optional<Schema.NonEmptyString>;
        readonly code: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"cards">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly cards: Schema.NonEmptyArray<Schema.Struct<{
            readonly title: Schema.NonEmptyString;
            readonly text: Schema.optional<Schema.NonEmptyString>;
            readonly label: Schema.optional<Schema.NonEmptyString>;
            readonly url: Schema.optional<Schema.NonEmptyString>;
        }>>;
        readonly more: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stats">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly stats: Schema.NonEmptyArray<Schema.Struct<{
            readonly value: Schema.NonEmptyString;
            readonly label: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"releases">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly releases: Schema.NonEmptyArray<Schema.Struct<{
            readonly name: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
            readonly date: Schema.String;
            readonly summary: Schema.optional<Schema.NonEmptyString>;
        }>>;
        readonly more: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"issues">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"runs">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"action">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly key: Schema.optional<Schema.String>;
    }>]>>;
}>;
/**
 * The home declaration `.smithers/FACTORY.ts` exports as `home`.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type;
/**
 * The document `.smithers/home.json` holds: the blocks, in declaration order.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Document: Schema.Struct<{
    readonly blocks: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
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
        readonly type: Schema.Literal<"markdown">;
        readonly path: Schema.NonEmptyString;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stack">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"app">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"view">;
        readonly flow: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"hero">;
        readonly title: Schema.NonEmptyString;
        readonly tagline: Schema.optional<Schema.NonEmptyString>;
        readonly text: Schema.optional<Schema.NonEmptyString>;
        readonly install: Schema.optional<Schema.NonEmptyString>;
        readonly actions: Schema.optional<Schema.NonEmptyArray<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>>;
        readonly announcement: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"code">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly file: Schema.optional<Schema.NonEmptyString>;
        readonly language: Schema.optional<Schema.NonEmptyString>;
        readonly code: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"cards">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly cards: Schema.NonEmptyArray<Schema.Struct<{
            readonly title: Schema.NonEmptyString;
            readonly text: Schema.optional<Schema.NonEmptyString>;
            readonly label: Schema.optional<Schema.NonEmptyString>;
            readonly url: Schema.optional<Schema.NonEmptyString>;
        }>>;
        readonly more: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stats">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly stats: Schema.NonEmptyArray<Schema.Struct<{
            readonly value: Schema.NonEmptyString;
            readonly label: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"releases">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly releases: Schema.NonEmptyArray<Schema.Struct<{
            readonly name: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
            readonly date: Schema.String;
            readonly summary: Schema.optional<Schema.NonEmptyString>;
        }>>;
        readonly more: Schema.optional<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"issues">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"runs">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"action">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly key: Schema.optional<Schema.String>;
    }>]>>;
}>;
/**
 * The document `.smithers/home.json` holds.
 *
 * @category models
 * @since 1.0.0
 */
export type Document = typeof Document.Type;
/**
 * Reports whether a value is a home declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isHomeDeclaration: (value: unknown) => value is Declaration;
/**
 * Reads one constructor's options as a plain object of enumerable data
 * properties, exactly once, or throws the reason it is not one. Shared with
 * the factory declaration in `Factory.ts`, so every declaration constructor
 * refuses the same shapes with the same words.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const plainOptions: (name: string, options: unknown, keys: ReadonlySet<string>) => Record<string, unknown>;
/**
 * Decodes a value through a schema or throws a `TypeError` naming the
 * constructor and the first issue.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const decode: <S extends Schema.Decoder<unknown, never>>(name: string, schema: S, value: unknown) => S["Type"];
/**
 * Freezes a value and every nested object it holds, so a declaration never
 * changes after it is written.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const freezeDeep: <T>(value: T) => T;
/**
 * What a `FACTORY.ts` writes for a text block.
 *
 * @category models
 * @since 1.0.0
 */
export interface TextOptions {
    readonly title?: string | undefined;
    readonly text: string;
}
/**
 * What a `FACTORY.ts` writes for a links block.
 *
 * @category models
 * @since 1.0.0
 */
export interface LinksOptions {
    readonly title?: string | undefined;
    readonly links: ReadonlyArray<{
        readonly label: string;
        readonly url: string;
    }>;
}
/**
 * What a `FACTORY.ts` writes for a flows block.
 *
 * @category models
 * @since 1.0.0
 */
export interface FlowsOptions {
    readonly title?: string | undefined;
}
/**
 * What a `FACTORY.ts` writes for a prompt block.
 *
 * @category models
 * @since 1.0.0
 */
export interface PromptOptions {
    readonly flow?: string | undefined;
    readonly title?: string | undefined;
    readonly placeholder?: string | undefined;
}
/**
 * What a `FACTORY.ts` writes for an app block.
 *
 * @category models
 * @since 1.0.0
 */
export interface AppOptions {
    readonly flow: string;
    readonly title: string;
    readonly picture: typeof AppPicture.Type;
}
/**
 * What a `FACTORY.ts` writes for a markdown block.
 *
 * @category models
 * @since 1.0.0
 */
export interface MarkdownOptions {
    readonly path: string;
    readonly title?: string | undefined;
}
/**
 * What a `FACTORY.ts` writes for a stack block.
 *
 * @category models
 * @since 1.0.0
 */
export interface StackOptions {
    readonly title?: string | undefined;
}
/**
 * What a `FACTORY.ts` writes for a view block.
 *
 * @category models
 * @since 1.0.0
 */
export interface ViewOptions {
    readonly flow: string;
}
/**
 * What a `FACTORY.ts` writes for the home declaration.
 *
 * @category models
 * @since 1.0.0
 */
export interface HomeOptions {
    readonly blocks: ReadonlyArray<Block>;
}
/**
 * Declares a paragraph of plain text.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Text: (options: TextOptions) => typeof TextBlock.Type;
/**
 * Declares a list of links.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Links: (options: LinksOptions) => typeof LinksBlock.Type;
/**
 * Declares the featured-flows block.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Flows: (options?: FlowsOptions) => typeof FlowsBlock.Type;
/**
 * Declares the homepage prompt.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Prompt: (options?: PromptOptions) => typeof PromptBlock.Type;
/**
 * Declares an app: a flow presented as a picture tile on the home.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const App: (options: AppOptions) => typeof AppBlock.Type;
/**
 * Declares a markdown file inside this repository.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Markdown: (options: MarkdownOptions) => typeof MarkdownBlock.Type;
/**
 * Declares the repository's live mythical stack.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Stack: (options?: StackOptions) => typeof StackBlock.Type;
/**
 * Draws a repository flow's declared view in this place.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const View: (options: ViewOptions) => typeof ViewBlock.Type;
/**
 * Declares the repository's homepage from declared blocks.
 *
 * Every block has to be a value one of the block constructors returned, or
 * an equal plain value; a string, an element, or any other shape is refused
 * with the block index in the message.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const home = Smithers.Factory.Home({
 *   blocks: [
 *     Smithers.Home.Text({ text: "Smithers builds itself with Smithers." }),
 *     Smithers.Home.Flows({ title: "Try first" }),
 *     Smithers.Home.Markdown({ path: "README.md" })
 *   ]
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Home: (options: HomeOptions) => Declaration;
/**
 * Renders the projected document: two-space indentation and a trailing
 * newline, so the checked-in file diffs like a hand-written one.
 *
 * @category rendering
 * @since 1.0.0
 */
export declare const render: (declaration: Declaration) => string;
/**
 * Reads a rendered document back, or reports why the text is not one.
 *
 * @category parsing
 * @since 1.0.0
 */
export declare const parse: (text: string) => Document | string;
