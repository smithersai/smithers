import * as Schema from "effect/Schema";
/** A world page: the wiki is read by slug. */
export interface Page {
    readonly slug: string;
    readonly title: string;
    readonly updated: string;
    readonly owner: string;
    readonly private: boolean;
    readonly text: string;
}
/** The loaded world: `data` is `world.yaml` after case patches. */
export interface World {
    readonly dir: string;
    readonly data: WorldData;
    readonly pages: Map<string, Page>;
    readonly repo: ReadonlyArray<{
        readonly path: string;
        readonly text: string;
    }>;
}
/** The parts of `world.yaml` the tools read. Everything else is carried through. */
export interface WorldData {
    readonly now: string;
    readonly owner: {
        readonly name: string;
        readonly timezone: string;
        readonly [key: string]: unknown;
    };
    readonly grants: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly team: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly owns: string;
    }>;
    readonly calendar: ReadonlyArray<CalendarEvent>;
    readonly inbox: ReadonlyArray<Email>;
    readonly chat: {
        readonly channels: ReadonlyArray<Channel>;
        readonly messages: ReadonlyArray<ChatMessage>;
    };
    readonly issues: ReadonlyArray<Issue>;
    /**
     * Scripted test results for `run_tests`, the most specific match wins: every `match`
     * term must appear in the filter the role passed (an empty `match` is the
     * default). A world without `tests` has no test runner.
     */
    readonly tests?: ReadonlyArray<TestResult> | undefined;
    /**
     * Scripted results for `ops_run` (deploy, roll back, restart, rotate...),
     * the most specific match wins: the entry's `action`, when set, must equal the action
     * the role asked for, and every `match` term must appear in its target (an
     * entry with neither is the default). A world without `ops` has no
     * operations workspace.
     */
    readonly ops?: ReadonlyArray<OpsResult> | undefined;
    readonly requests: ReadonlyArray<Request>;
    readonly answers: Readonly<Record<string, ReadonlyArray<{
        readonly match: ReadonlyArray<string>;
        readonly text: string;
    }>>>;
    readonly web: ReadonlyArray<{
        readonly url: string;
        readonly title: string;
        readonly text: string;
    }>;
    readonly notes: Readonly<Record<string, unknown>>;
    readonly private: {
        readonly markers: ReadonlyArray<string>;
    };
    readonly urls: Readonly<Record<string, string>>;
    readonly [key: string]: unknown;
}
export interface CalendarEvent {
    readonly id: string;
    readonly start: string;
    readonly end: string;
    readonly title: string;
    readonly private?: boolean;
    readonly focus?: boolean;
    readonly createdBy?: string;
    readonly [key: string]: unknown;
}
export interface Email {
    readonly id: string;
    readonly from: string;
    readonly date: string;
    readonly subject: string;
    readonly body: string;
    readonly private?: boolean;
}
export interface Channel {
    readonly id: string;
    readonly name: string;
}
export interface ChatMessage {
    readonly id: string;
    readonly channel: string;
    readonly ts: string;
    readonly from: string;
    readonly text: string;
    readonly thread?: string;
}
export interface Issue {
    readonly number: number;
    readonly kind: "issue" | "pr";
    readonly title: string;
    readonly state: string;
    readonly [key: string]: unknown;
}
export interface TestResult {
    readonly match: ReadonlyArray<string>;
    readonly status: "passed" | "failed";
    readonly passed?: number | undefined;
    readonly failed?: number | undefined;
    readonly output: string;
}
export interface OpsResult {
    readonly action?: string | undefined;
    readonly match?: ReadonlyArray<string> | undefined;
    readonly status: "succeeded" | "failed" | "started";
    readonly output: string;
}
export interface Request {
    readonly id: string;
    readonly from: string;
    readonly date: string;
    readonly title: string;
    readonly body: string;
}
/**
 * A case's changes to the world, applied in this order: `set` replaces
 * top-level keys; `remove` drops entries of top-level arrays by their `id` or
 * `number`; `add` appends to top-level arrays (or merges into top-level
 * objects); `pages` adds or replaces wiki pages by slug. Removing before
 * adding lets a case replace one entry (an issue in a new state) by removing
 * and re-adding it, without repeating the whole list.
 */
export interface Patch {
    readonly now?: string | undefined;
    readonly set?: Readonly<Record<string, unknown>> | undefined;
    readonly add?: Readonly<Record<string, unknown>> | undefined;
    readonly remove?: Readonly<Record<string, ReadonlyArray<string | number>>> | undefined;
    readonly pages?: ReadonlyArray<Partial<Page> & {
        readonly slug: string;
        readonly text: string;
    }> | undefined;
}
/** Loads a world directory and applies one case's patch. */
export declare const load: (dir: string, patch?: Patch) => World;
/** The URL a thing in this world is linked by. */
export declare const urlOf: {
    issue: (world: World, issue: Issue) => string;
    page: (world: World, slug: string) => string;
    event: (world: World, id: string) => string;
    email: (world: World, id: string) => string;
    message: (world: World, message: ChatMessage) => string;
    request: (world: World, id: string) => string;
    file: (world: World, path: string) => string;
};
export type Handler = (input: Record<string, unknown>) => unknown;
export interface ToolSpec {
    readonly name: string;
    readonly description: string;
    readonly input: Schema.Top;
    readonly writes: boolean;
    readonly handler: (world: World, role: string, state: State) => Handler;
}
/** What the tools changed during a run, beside the action log. */
export interface State {
    counter: number;
    readonly drafts: Map<string, Record<string, unknown>>;
    readonly events: Array<CalendarEvent>;
    /** The turn's copy of the issue list: created, commented and updated issues live here. */
    readonly issues: Array<Issue>;
}
/** Every simulated tool. A role sees the subset its grant names. */
export declare const tools: ReadonlyArray<ToolSpec>;
/** Runs one tool by name outside the agent loop, e.g. in a test. */
export declare const call: (world: World, role: string, state: State, tool: string, input: Record<string, unknown>) => unknown;
