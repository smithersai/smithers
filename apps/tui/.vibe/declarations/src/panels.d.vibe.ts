/** Runtime-authored, serializable UI. Cells construct these values; the host owns rendering and keys. */
import { Schema } from "effect";
export declare const Block: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"text">;
    readonly text: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"code">;
    readonly code: Schema.String;
    readonly language: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"diff">;
    readonly patch: Schema.String;
    readonly path: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"table">;
    readonly columns: Schema.$Array<Schema.String>;
    readonly rows: Schema.$Array<Schema.$Array<Schema.String>>;
}>]>;
export type Block = typeof Block.Type;
/** What choosing a key, a status item or a row does. Never a shell command. */
export declare const Action: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"prompt">;
    readonly prompt: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"flow">;
    readonly flow: Schema.String;
    readonly input: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"agent">;
    readonly agent: Schema.String;
    readonly prompt: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"open">;
    readonly surface: Schema.String;
}>]>;
export type Action = typeof Action.Type;
export declare const Row: Schema.Struct<{
    readonly id: Schema.String;
    readonly label: Schema.String;
    readonly status: Schema.optional<Schema.Literals<readonly ["running", "waiting", "queued", "parked", "done", "failed", "requested", "cancelled"]>>;
    readonly details: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"text">;
        readonly text: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"code">;
        readonly code: Schema.String;
        readonly language: Schema.optional<Schema.String>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"diff">;
        readonly patch: Schema.String;
        readonly path: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"table">;
        readonly columns: Schema.$Array<Schema.String>;
        readonly rows: Schema.$Array<Schema.$Array<Schema.String>>;
    }>]>>;
    readonly action: Schema.optional<Schema.Union<readonly [Schema.Struct<{
        readonly label: Schema.String;
        readonly prompt: Schema.String;
    }>, Schema.Struct<{
        readonly label: Schema.String;
        readonly action: Schema.Union<readonly [Schema.Struct<{
            readonly kind: Schema.Literal<"prompt">;
            readonly prompt: Schema.String;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"flow">;
            readonly flow: Schema.String;
            readonly input: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"agent">;
            readonly agent: Schema.String;
            readonly prompt: Schema.optional<Schema.String>;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"open">;
            readonly surface: Schema.String;
        }>]>;
    }>]>>;
}>;
export type Row = typeof Row.Type;
export declare const Panel: Schema.Struct<{
    readonly id: Schema.String;
    readonly title: Schema.String;
    readonly summary: Schema.String;
    readonly placement: Schema.optional<Schema.Literals<readonly ["tab", "main"]>>;
    readonly bind: Schema.optional<Schema.Struct<{
        readonly tree: Schema.String;
    }>>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.optional<Schema.Literals<readonly ["running", "waiting", "queued", "parked", "done", "failed", "requested", "cancelled"]>>;
        readonly details: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly kind: Schema.Literal<"text">;
            readonly text: Schema.String;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"code">;
            readonly code: Schema.String;
            readonly language: Schema.optional<Schema.String>;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"diff">;
            readonly patch: Schema.String;
            readonly path: Schema.String;
        }>, Schema.Struct<{
            readonly kind: Schema.Literal<"table">;
            readonly columns: Schema.$Array<Schema.String>;
            readonly rows: Schema.$Array<Schema.$Array<Schema.String>>;
        }>]>>;
        readonly action: Schema.optional<Schema.Union<readonly [Schema.Struct<{
            readonly label: Schema.String;
            readonly prompt: Schema.String;
        }>, Schema.Struct<{
            readonly label: Schema.String;
            readonly action: Schema.Union<readonly [Schema.Struct<{
                readonly kind: Schema.Literal<"prompt">;
                readonly prompt: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"flow">;
                readonly flow: Schema.String;
                readonly input: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"agent">;
                readonly agent: Schema.String;
                readonly prompt: Schema.optional<Schema.String>;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"open">;
                readonly surface: Schema.String;
            }>]>;
        }>]>>;
    }>>;
}>;
export type Panel = typeof Panel.Type;
/** Model status without a bound run has no host-owned source to settle it. */
export declare const unboundStatus: (panel: Panel) => boolean;
/** Custom views a session keeps. */
export declare const limit = 24;
/** Adds or refreshes `panel` as the newest view, dropping the oldest past `limit`. */
export declare const keep: (panels: Map<string, Panel>, panel: Panel) => void;
export declare const decode: (value: unknown) => Panel;
export interface Navigation {
    readonly selected: number;
    readonly expanded: ReadonlySet<string>;
    readonly diff: boolean;
    readonly split: boolean;
}
export declare const initial: () => Navigation;
/** Shared by the built-in summary and every agent-authored panel. */
export declare const navigate: (state: Navigation, key: string, rows: ReadonlyArray<Row>) => Navigation;
export declare const teaching = "Use ui.publish to build custom terminal UI whenever a view makes the answer easier to inspect: comparisons, plans, choices, or results. Write JavaScript cells that construct a panel and call the flow; do not print UI JSON. Panels have {id,title,summary,rows:[{id,label,status?,details:[blocks],action?}]}. Blocks are {kind:\"text\",text}, {kind:\"code\",code,language?}, {kind:\"diff\",path,patch} or {kind:\"table\",columns,rows}. A row action is {label,prompt} or {label,action}; an action is {kind:\"prompt\",prompt}, {kind:\"flow\",flow,input?}, {kind:\"agent\",agent,prompt?} or {kind:\"open\",surface}. A bare panel opens a tab; publish {kind:\"panel\",placement:\"card\",panel} for a live card in the chat, {kind:\"status\",status:{id,text,tone?,action?}} for a footer item (24 characters), or {kind:\"key\",key:{id,key:\"alt+z\",label,action}} for a key (ctrl or alt required). Reuse the panel id to update it. Keep summary to one sentence (e.g. \"Investigation requested.\", never \"running\" for a requested receipt) and row labels to concise human English. Details hold actual evidence and code. Actions run ONLY when the user chooses them. Publishing never changes keyboard focus. Prefer useful UI to long prose. Never invent actions the user did not request, nor keys or status items. placement:\"main\" opens a main view with chat beside it, and bind:{tree:rootId} adds live worker rows. The host owns run status; publish only useful results or controls, never status panels.";
