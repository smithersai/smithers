/**
 * A repository's own home: the blocks `.smithers/home.json` declares, read
 * where the home is shown.
 *
 * A home is data, never code. Each block is one of a closed set of kinds,
 * every string in it is bounded, and a string carrying an HTML tag is
 * refused (a `code` block's source excepted: a page draws it as text), so a
 * page draws a home from these values and runs nothing the repository
 * wrote. A button a block names runs only when a person presses it.
 *
 * Blocks sit in sections, and each section names its {@link Audience}: who
 * may see it. A page shows a viewer only the sections {@link sees} allows,
 * and {@link visible} picks them. A file with a bare `blocks` array is one
 * section for everyone. The live blocks (`issues`, `runs`, `flows`,
 * `stack`) carry no rows: the page reads them itself, through its own
 * access checks.
 *
 * {@link read} is the reader a page uses: it takes the file's text and
 * answers the sections to draw, skipping a kind it doesn't know so a newer
 * declaration still shows on an older page, or says the file is invalid.
 * This module is the format's one copy: `@smthrs/targets` writes the same
 * document from `.smithers/FACTORY.ts` (`Smithers.Factory.Home`) with these
 * very schemas.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * The file a repository declares its home in, at its default branch's head.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const path = ".smithers/home.json";
/**
 * Maximum length of one block's title or one link's label.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumTitleLength = 120;
/**
 * Maximum length of one text block.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumTextLength = 4096;
/**
 * Maximum length of one link URL.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumUrlLength = 2048;
/**
 * Maximum number of blocks one home declares, unknown kinds included.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumBlocks = 32;
/**
 * Maximum number of sections one home declares.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumSections = 8;
/**
 * Maximum number of entries in one list a block carries: a `cards` block's
 * cards, a `releases` block's releases, a `links` block's links.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumEntries = 12;
/**
 * Maximum number of a `stats` block's stats.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumStats = 6;
/**
 * Maximum number of a `hero` block's actions.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumActions = 3;
/**
 * Maximum length of a short line of prose: a card's text, a release's summary,
 * a hero's tagline.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumLineLength = 280;
/**
 * Maximum length of a `code` block's source.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumCodeLength = 4096;
/**
 * The shape of raw HTML in a string: a tag, a closing tag, a comment, or a
 * processing instruction opener. Prose that mentions `a < b` does not match;
 * `<b>bold</b>` and `<!-- note -->` do.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const htmlPattern: RegExp;
/**
 * A one-line title or label: non-empty, bounded, one line, no HTML.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Title: Schema.NonEmptyString;
/**
 * A paragraph of plain text: non-empty, bounded, no HTML.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Prose: Schema.NonEmptyString;
/**
 * A link target: an absolute `http` or `https` URL.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Url: Schema.NonEmptyString;
/**
 * Where a home's docs are listed: the absolute `https` URL of the docs site's
 * index in the `llms.txt` format, such as `https://vibelang.sh/llms.txt`,
 * with no user or password. `@smthrs/views`' `Docs` reads the index.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const DocsUrl: Schema.NonEmptyString;
/**
 * A relative path that cannot escape the repository.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RepositoryPath: Schema.NonEmptyString;
/**
 * A flow's name as a home names it: a slash command or a repository flow,
 * at most {@link maximumTitleLength} characters.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const FlowName: Schema.NonEmptyString;
/**
 * A short line of prose: non-empty, one line, at most
 * {@link maximumLineLength} characters, no HTML.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Line: Schema.NonEmptyString;
/**
 * A shell command a person copies, such as `npm install effect`: one line, at
 * most {@link maximumLineLength} characters, no HTML. A page shows it as text
 * and runs nothing.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Command: Schema.NonEmptyString;
/**
 * A `code` block's source: non-empty, at most {@link maximumCodeLength}
 * characters, no NUL. It may hold `<` and `>`, since source code does, and a
 * page draws it as text, never as markup.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Code: Schema.NonEmptyString;
/**
 * The language a `code` block is written in, as a lowercase name such as
 * `ts`, `tsx`, `sh` or `json`: a page may color it, and shows it as plain
 * text otherwise.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Language: Schema.NonEmptyString;
/**
 * A calendar date, `YYYY-MM-DD`, that exists.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const IsoDate: Schema.String;
/**
 * A link: a label and the absolute `http` or `https` URL it opens.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Link: Schema.Struct<{
    readonly label: Schema.NonEmptyString;
    readonly url: Schema.NonEmptyString;
}>;
/**
 * Who may see a section:
 *
 * - `everyone`: anyone who may open the repository's page, signed out
 *   included;
 * - `contributor`: anyone signed in with a role on the repository, a Guest
 *   included, and anyone at all when the home opens its contributors'
 *   sections ({@link Contributors});
 * - `maintainer`: a Maintainer and above.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Audience: Schema.Literals<readonly ["everyone", "contributor", "maintainer"]>;
/**
 * Who may see a section.
 *
 * @category models
 * @since 0.1.0
 */
export type Audience = typeof Audience.Type;
/**
 * The audiences, from the widest to the narrowest.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const audiences: ReadonlyArray<Audience>;
/**
 * Who counts as a contributor to a home: `role`, a person signed in with a
 * role on the repository (the default); or `anyone`, everyone with the link,
 * for a repository that welcomes contributions from anyone.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Contributors: Schema.Literals<readonly ["role", "anyone"]>;
/**
 * Who counts as a contributor to a home.
 *
 * @category models
 * @since 0.1.0
 */
export type Contributors = typeof Contributors.Type;
/**
 * A paragraph of plain text under an optional title.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TextBlock: Schema.Struct<{
    readonly type: Schema.Literal<"text">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly text: Schema.NonEmptyString;
}>;
/**
 * A list of links under an optional title: each a label and the URL it opens.
 *
 * @category schemas
 * @since 0.1.0
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
 * The repository's flows, which the page lists from its own catalog: the
 * block carries no rows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const FlowsBlock: Schema.Struct<{
    readonly type: Schema.Literal<"flows">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * A prompt: a heading over the way to ask, and the flow that takes the
 * question, if not the conversation itself.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const PromptBlock: Schema.Struct<{
    readonly type: Schema.Literal<"prompt">;
    readonly flow: Schema.optional<Schema.NonEmptyString>;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly placeholder: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The pictures an app block may wear: what the flow's result looks like.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const AppPicture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
/**
 * An app: one flow's button, with a title and a picture. A page shows it only
 * when it has that flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const AppBlock: Schema.Struct<{
    readonly type: Schema.Literal<"app">;
    readonly flow: Schema.NonEmptyString;
    readonly title: Schema.NonEmptyString;
    readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
}>;
/**
 * A Markdown file of the repository, read at the home's own commit.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const MarkdownBlock: Schema.Struct<{
    readonly type: Schema.Literal<"markdown">;
    readonly path: Schema.NonEmptyString;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The repository's live stack of changes, which the page reads itself: the
 * block carries no rows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const StackBlock: Schema.Struct<{
    readonly type: Schema.Literal<"stack">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * The view a repository flow declares, drawn in this place.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ViewBlock: Schema.Struct<{
    readonly type: Schema.Literal<"view">;
    readonly flow: Schema.NonEmptyString;
}>;
/**
 * A project's opening: its name, a tagline, a paragraph, the command that
 * installs it, up to {@link maximumActions} links (the first is the primary
 * one) and an announcement above the name.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const HeroBlock: Schema.Struct<{
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
}>;
/**
 * Source code shown as an example, with the file it would live in and its
 * language.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CodeBlock: Schema.Struct<{
    readonly type: Schema.Literal<"code">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly file: Schema.optional<Schema.NonEmptyString>;
    readonly language: Schema.optional<Schema.NonEmptyString>;
    readonly code: Schema.NonEmptyString;
}>;
/**
 * One card: a title, a line under it, a small label above it (such as a
 * package's name) and the URL it opens.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Card: Schema.Struct<{
    readonly title: Schema.NonEmptyString;
    readonly text: Schema.optional<Schema.NonEmptyString>;
    readonly label: Schema.optional<Schema.NonEmptyString>;
    readonly url: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * A grid of up to {@link maximumEntries} cards, with a link to the rest.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CardsBlock: Schema.Struct<{
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
}>;
/**
 * One stat: a short value over its label, such as `MIT` over `License`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Stat: Schema.Struct<{
    readonly value: Schema.NonEmptyString;
    readonly label: Schema.NonEmptyString;
}>;
/**
 * A row of up to {@link maximumStats} declared facts. They are the
 * repository's own words, never counted by the page.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const StatsBlock: Schema.Struct<{
    readonly type: Schema.Literal<"stats">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly stats: Schema.NonEmptyArray<Schema.Struct<{
        readonly value: Schema.NonEmptyString;
        readonly label: Schema.NonEmptyString;
    }>>;
}>;
/**
 * One release: its name, the page that describes it, its date and a line of
 * what changed.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Release: Schema.Struct<{
    readonly name: Schema.NonEmptyString;
    readonly url: Schema.NonEmptyString;
    readonly date: Schema.String;
    readonly summary: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * Up to {@link maximumEntries} releases, newest first as declared, with a link
 * to the rest.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ReleasesBlock: Schema.Struct<{
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
}>;
/**
 * The repository's issues and pull requests at a glance, which the page
 * reads itself: how many are proposed, accepted and not accepted, the ones
 * that need triage, and the pull requests waiting. The block carries no rows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const IssuesBlock: Schema.Struct<{
    readonly type: Schema.Literal<"issues">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * A key a person presses for an `action` block's button: one lowercase letter.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Key: Schema.String;
/**
 * A primary button that runs one flow when a person presses it, or presses
 * its `key` while not typing, such as New branch: unlike an `app` block, it
 * starts the flow at once rather than opening the composer. A page shows it
 * only when it has that flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ActionBlock: Schema.Struct<{
    readonly type: Schema.Literal<"action">;
    readonly flow: Schema.NonEmptyString;
    readonly title: Schema.NonEmptyString;
    readonly key: Schema.optional<Schema.String>;
}>;
/**
 * Recent flow runs, which the page reads itself, failures first. The block
 * carries no rows.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RunsBlock: Schema.Struct<{
    readonly type: Schema.Literal<"runs">;
    readonly title: Schema.optional<Schema.NonEmptyString>;
}>;
/**
 * One declared block.
 *
 * @category schemas
 * @since 0.1.0
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
 * One declared block.
 *
 * @category models
 * @since 0.1.0
 */
export type Block = typeof Block.Type;
/**
 * The kinds of block this reader knows, by their `type`.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const kinds: ReadonlyArray<Block["type"]>;
/**
 * The kinds of block whose rows a page reads itself, under its own access
 * checks: the declaration names the block, never its data.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const liveKinds: ReadonlyArray<Block["type"]>;
/**
 * A section's heading and audience, as declared. A section's blocks are read
 * one by one, so a block of a kind this reader doesn't know is skipped there
 * as anywhere.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const SectionHeading: Schema.Struct<{
    readonly title: Schema.optional<Schema.NonEmptyString>;
    readonly audience: Schema.optional<Schema.Literals<readonly ["everyone", "contributor", "maintainer"]>>;
}>;
/**
 * One section of a home: an optional heading, who may see it, and its blocks.
 *
 * @category models
 * @since 0.1.0
 */
export interface Section {
    readonly title?: string;
    readonly audience: Audience;
    readonly blocks: ReadonlyArray<Block>;
}
/**
 * Why a file is not a home:
 *
 * - `json`: the text is not JSON;
 * - `shape`: it is not an object with either a `blocks` array or a
 *   `sections` array (both is refused too), its `contributors` isn't one
 *   of {@link Contributors}, or its `docs` isn't a {@link DocsUrl};
 * - `sections`: it declares more than {@link maximumSections} sections;
 * - `section`: a section is not an object with a `blocks` array, or its title
 *   or audience breaks its bounds;
 * - `blocks`: it declares more than {@link maximumBlocks} blocks in all,
 *   unknown kinds included;
 * - `block`: a block of a known kind breaks its bounds, such as a title over
 *   {@link maximumTitleLength} characters, HTML in a string or a link that
 *   isn't `http` or `https`.
 *
 * @category models
 * @since 0.1.0
 */
export type Invalid = "json" | "shape" | "sections" | "section" | "blocks" | "block";
/**
 * What {@link read} answers: the sections to draw, in order, each with its
 * blocks, and how many blocks it skipped because their kind is unknown; or
 * why the file is not a home. A home may declare no blocks at all.
 *
 * @category models
 * @since 0.1.0
 */
export type Read = {
    readonly _tag: "Declared";
    readonly sections: ReadonlyArray<Section>;
    readonly contributors: Contributors;
    /** The docs index the home declares, a {@link DocsUrl}; absent when it declares none. */
    readonly docs?: string;
    readonly skipped: number;
} | {
    readonly _tag: "Invalid";
    readonly reason: Invalid;
};
/**
 * Reads `.smithers/home.json`'s text: the sections it declares, or why it is
 * not a home. A file with `blocks` is one section for everyone; a file with
 * `sections` names each section's audience, `everyone` when it names none, and
 * may say `"contributors": "anyone"` to show its contributors' sections to
 * everyone with the link, and `"docs"` to name its docs index. A
 * block of a kind this reader doesn't know is skipped and counted; any other
 * block that breaks its schema makes the whole file invalid, so a page never
 * draws half of a home. The answer carries no text from the file but the
 * sections themselves.
 *
 * @example
 * ```ts
 * import { Home } from "@smthrs/views"
 *
 * const home = Home.read('{"blocks":[{"type":"text","text":"Hello."},{"type":"chart"}]}')
 * // { _tag: "Declared", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "Hello." }] }],
 * //   contributors: "role", skipped: 1 }
 * ```
 *
 * @category reading
 * @since 0.1.0
 */
export declare const read: (text: string) => Read;
/**
 * Whether a viewer of audience `viewer` may see a section for `section`: a
 * maintainer sees every section, a contributor every section but a
 * maintainer's, and anyone else only `everyone`'s.
 *
 * @example
 * ```ts
 * import { Home } from "@smthrs/views"
 *
 * Home.sees("contributor", "maintainer") // false
 * Home.sees("maintainer", "contributor") // true
 * ```
 *
 * @category audiences
 * @since 0.1.0
 */
export declare const sees: (viewer: Audience, section: Audience) => boolean;
/**
 * The sections a viewer of audience `viewer` may see, in order. A page that
 * holds a whole home calls this before drawing it; a server that answers a
 * home calls it before sending one, so a viewer never receives a section
 * meant for others.
 *
 * @category audiences
 * @since 0.1.0
 */
export declare const visible: (sections: ReadonlyArray<Section>, viewer: Audience) => ReadonlyArray<Section>;
/**
 * The audience a viewer has on a home that says who counts as a contributor:
 * with `anyone`, everyone is at least a contributor; otherwise the audience
 * stands.
 *
 * @example
 * ```ts
 * import { Home } from "@smthrs/views"
 *
 * Home.widen("everyone", "anyone") // "contributor"
 * Home.widen("everyone", "role") // "everyone"
 * ```
 *
 * @category audiences
 * @since 0.1.0
 */
export declare const widen: (viewer: Audience, contributors: Contributors) => Audience;
