import { Schema } from "effect";
/** Where a repository's manifest lives. */
export declare const MANIFEST_PATH = ".smithers/factory.json";
/**
 * The events this slice starts flows on, and `manual`: a person runs the flow by hand (docs/features/actions.md). A row
 * for another event (`cron`, `run.settled`, ...) is skipped.
 */
export declare const EVENTS: readonly ["github.push", "github.pull_request", "manual"];
/** The pull request actions a trigger matches when it names none: GitHub's `pull_request` defaults. */
export declare const DEFAULT_ACTIONS: readonly ["opened", "synchronize", "reopened"];
/** The most trigger rows read from one manifest. */
export declare const MAX_TRIGGERS = 64;
/** One trigger row: decision 0017's `Trigger` (`on`, `flow`, `title`) with the filters this slice reads. */
export declare const Trigger: Schema.Struct<{
    readonly on: Schema.Literals<readonly ["github.push", "github.pull_request", "manual"]>;
    readonly flow: Schema.String;
    readonly title: Schema.optional<Schema.String>;
    /** Push: the branches pushed to; pull request: its base branch. Every branch when absent, unless `tags` is set. */
    readonly branches: Schema.optional<Schema.$Array<Schema.String>>;
    /** Push only: the tags pushed. A tag push matches only a trigger that names tags. */
    readonly tags: Schema.optional<Schema.$Array<Schema.String>>;
    /** Pull request only: its actions, `DEFAULT_ACTIONS` when absent. */
    readonly actions: Schema.optional<Schema.$Array<Schema.String>>;
}>;
export type Trigger = typeof Trigger.Type;
/**
 * The trigger rows of manifest `text`: none when it isn't a `Plugin.Manifest` (`apiVersion: 1`), as `.smithers/factory.json`
 * written by `S.Factory` isn't. A row this slice can't read (another event, a bad flow name) is skipped; the rest stand.
 */
export declare const triggersOf: (text: string) => ReadonlyArray<Trigger>;
/** What a trigger is matched against: one GitHub event, as the webhook names it. */
export interface Event {
    readonly event: "push" | "pull_request";
    /** Push: the branch pushed to, or `null` for a tag; pull request: its base branch. */
    readonly branch: string | null;
    /** Push: the tag pushed, or `null`. */
    readonly tag: string | null;
    /** Pull request: its action. */
    readonly action: string | null;
}
/**
 * Whether ref name `name` matches glob `pattern`: `*` is any run of characters but `/`, `**` any run at all, and every
 * other character is itself. A table over the pattern's tokens and the name's characters, never a regular expression,
 * so a pattern can't make matching backtrack: at most 255 by 255 steps.
 */
export declare const globMatches: (pattern: string, name: string) => boolean;
/** Whether `trigger` starts its flow on `event`. */
export declare const matches: (trigger: Trigger, event: Event) => boolean;
/** The flows `triggers` start on `event`, each once, in the manifest's order. */
export declare const flowsFor: (triggers: ReadonlyArray<Trigger>, event: Event) => ReadonlyArray<string>;
/** The flows a person may run by hand: those with a `manual` trigger, each once, in the manifest's order, and its title. */
export declare const manualFlows: (triggers: ReadonlyArray<Trigger>) => ReadonlyArray<{
    readonly name: string;
    readonly title?: string;
}>;
