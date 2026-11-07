import { Effect, Option, Schema } from "effect";
import { Command, Subscription, type Runtime, type Update } from "foldkit";
import { Factory } from "../core/Factory.vibe";
/** What the page knows when it starts: a random id for this tab's posts, the backend, and the name posts carry. */
export declare const Flags: Schema.Struct<{
    readonly session: Schema.String;
    readonly mode: Schema.Literals<readonly ["mock", "live"]>;
    readonly name: Schema.String;
}>;
export type Flags = typeof Flags.Type;
export declare const Model: Schema.Struct<{
    /** `splash`: the home page fills the window. `chat`: the conversation, with the home page as its first pane. */
    readonly surface: Schema.Literals<readonly ["splash", "chat"]>;
    /** Whether the ⌘K prompt is open. */
    readonly palette: Schema.Boolean;
    readonly draft: Schema.String;
    readonly session: Schema.String;
    readonly name: Schema.String;
    /** How many posts this tab has sent; the next one's client id is `<session>-<sent + 1>`. */
    readonly sent: Schema.Number;
    readonly conversation: Schema.String;
    readonly client: Schema.Struct<{
        readonly conversation: Schema.Struct<{
            readonly seq: Schema.Number;
            readonly entries: Schema.$Array<Schema.Struct<{
                readonly id: Schema.String;
                readonly seq: Schema.Number;
                readonly clientId: Schema.String;
                readonly author: Schema.Literals<readonly ["person", "agent"]>;
                readonly name: Schema.String;
                readonly text: Schema.String;
                readonly done: Schema.Boolean;
                readonly error: Schema.String;
            }>>;
            readonly agent: Schema.Literals<readonly ["idle", "working", "failed"]>;
            readonly replying: Schema.String;
        }>;
        readonly pending: Schema.$Array<Schema.Struct<{
            readonly clientId: Schema.String;
            readonly text: Schema.String;
            readonly error: Schema.String;
        }>>;
        readonly gap: Schema.Boolean;
    }>;
    readonly mode: Schema.Literals<readonly ["mock", "live"]>;
    /** The event stream: `closed` before the first post, `open` while it follows, `failed` after it broke. */
    readonly stream: Schema.Literals<readonly ["closed", "open", "failed"]>;
    /** Bumped to start the event stream again from `from`. */
    readonly epoch: Schema.Number;
    readonly from: Schema.Number;
}>;
export type Model = typeof Model.Type;
/** The conversation every visitor of the home page joins until conversations have their own pages. */
export declare const HOME_CONVERSATION = "home";
export declare const Message: import("foldkit/message").MessageUnion<{
    readonly PressedCommandK: {};
    readonly PressedEscape: {};
    readonly ClickedAsk: {};
    readonly ClickedSplash: {};
    readonly ClickedChat: {};
    readonly UpdatedDraft: {
        value: Schema.String;
    };
    readonly SubmittedDraft: {};
    readonly SucceededPost: {
        clientId: Schema.String;
    };
    readonly FailedPost: {
        clientId: Schema.String;
        reason: Schema.String;
    };
    readonly ReceivedEvent: {
        event: Schema.Union<readonly [Schema.Struct<{
            readonly type: Schema.Literal<"Posted">;
            readonly seq: Schema.Number;
            readonly id: Schema.String;
            readonly clientId: Schema.String;
            readonly name: Schema.String;
            readonly text: Schema.String;
        }>, Schema.Struct<{
            readonly type: Schema.Literal<"ReplyStarted">;
            readonly seq: Schema.Number;
            readonly id: Schema.String;
        }>, Schema.Struct<{
            readonly type: Schema.Literal<"ReplyDelta">;
            readonly seq: Schema.Number;
            readonly id: Schema.String;
            readonly text: Schema.String;
        }>, Schema.Struct<{
            readonly type: Schema.Literal<"ReplyFinished">;
            readonly seq: Schema.Number;
            readonly id: Schema.String;
        }>, Schema.Struct<{
            readonly type: Schema.Literal<"ReplyFailed">;
            readonly seq: Schema.Number;
            readonly id: Schema.String;
            readonly reason: Schema.String;
        }>]>;
    };
    readonly FailedEvents: {
        reason: Schema.String;
    };
    readonly ClickedReconnect: {};
    readonly FocusedPrompt: {};
}>;
export type Message = typeof Message.Type;
/** @throws {never} */
export declare function init(flags: Flags): Update.Return<Model, Message, Factory>;
/** @throws {never} */
export declare function update(model: Model, message: Message): Update.Return<Model, Message, Factory>;
/**
 * Whether there is a conversation to go back to.
 * @throws {never}
 */
export declare function hasConversation(model: Model): boolean;
/** The id of the prompt's input, in the ⌘K palette and in the docked composer alike. */
export declare const PROMPT_ID = "vl-prompt";
export declare const FocusPrompt: Command.CommandDefinitionWithArgs<"FocusPrompt", {}, Effect.Effect<{
    readonly _tag: "FocusedPrompt";
}, never, never>>;
export declare const PostMessage: Command.CommandDefinitionWithArgs<"PostMessage", {
    conversation: Schema.String;
    clientId: Schema.String;
    name: Schema.String;
    text: Schema.String;
}, Effect.Effect<{
    readonly _tag: "FailedPost";
    readonly clientId: string;
    readonly reason: string;
} | {
    readonly _tag: "SucceededPost";
    readonly clientId: string;
}, never, Factory>>;
/**
 * The key a keydown means to the app, if any: ⌘K or Ctrl+K toggles the prompt, Escape closes it.
 * @throws {never}
 */
export declare function keyMessage(key: string, meta: boolean, control: boolean): Option.Option<Message>;
/**
 * The app's subscriptions: the keyboard on `keys` (the document, in a browser) and the conversation's events.
 * @throws {never}
 */
export declare function subscriptions(keys: EventTarget): {
    readonly keyboard: Subscription.EntryWithoutKeepAlive<unknown, {
        readonly _tag: "ClickedAsk";
    } | {
        readonly _tag: "ClickedChat";
    } | {
        readonly _tag: "ClickedReconnect";
    } | {
        readonly _tag: "ClickedSplash";
    } | {
        readonly _tag: "FocusedPrompt";
    } | {
        readonly _tag: "PressedCommandK";
    } | {
        readonly _tag: "PressedEscape";
    } | {
        readonly _tag: "SubmittedDraft";
    } | {
        readonly _tag: "FailedEvents";
        readonly reason: string;
    } | {
        readonly _tag: "FailedPost";
        readonly clientId: string;
        readonly reason: string;
    } | {
        readonly _tag: "ReceivedEvent";
        readonly event: {
            readonly type: "Posted";
            readonly seq: number;
            readonly id: string;
            readonly clientId: string;
            readonly name: string;
            readonly text: string;
        } | {
            readonly type: "ReplyStarted";
            readonly seq: number;
            readonly id: string;
        } | {
            readonly type: "ReplyDelta";
            readonly seq: number;
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "ReplyFinished";
            readonly seq: number;
            readonly id: string;
        } | {
            readonly type: "ReplyFailed";
            readonly seq: number;
            readonly id: string;
            readonly reason: string;
        };
    } | {
        readonly _tag: "SucceededPost";
        readonly clientId: string;
    } | {
        readonly _tag: "UpdatedDraft";
        readonly value: string;
    }, Record<string, never>, never> & {
        readonly __subscription: never;
    };
    readonly events: Subscription.EntryWithoutKeepAlive<{
        readonly surface: "chat" | "splash";
        readonly palette: boolean;
        readonly draft: string;
        readonly session: string;
        readonly name: string;
        readonly sent: number;
        readonly conversation: string;
        readonly client: {
            readonly conversation: {
                readonly seq: number;
                readonly entries: readonly {
                    readonly id: string;
                    readonly seq: number;
                    readonly clientId: string;
                    readonly author: "agent" | "person";
                    readonly name: string;
                    readonly text: string;
                    readonly done: boolean;
                    readonly error: string;
                }[];
                readonly agent: "failed" | "idle" | "working";
                readonly replying: string;
            };
            readonly pending: readonly {
                readonly clientId: string;
                readonly text: string;
                readonly error: string;
            }[];
            readonly gap: boolean;
        };
        readonly mode: "live" | "mock";
        readonly stream: "closed" | "failed" | "open";
        readonly epoch: number;
        readonly from: number;
    }, {
        readonly _tag: "ClickedAsk";
    } | {
        readonly _tag: "ClickedChat";
    } | {
        readonly _tag: "ClickedReconnect";
    } | {
        readonly _tag: "ClickedSplash";
    } | {
        readonly _tag: "FocusedPrompt";
    } | {
        readonly _tag: "PressedCommandK";
    } | {
        readonly _tag: "PressedEscape";
    } | {
        readonly _tag: "SubmittedDraft";
    } | {
        readonly _tag: "FailedEvents";
        readonly reason: string;
    } | {
        readonly _tag: "FailedPost";
        readonly clientId: string;
        readonly reason: string;
    } | {
        readonly _tag: "ReceivedEvent";
        readonly event: {
            readonly type: "Posted";
            readonly seq: number;
            readonly id: string;
            readonly clientId: string;
            readonly name: string;
            readonly text: string;
        } | {
            readonly type: "ReplyStarted";
            readonly seq: number;
            readonly id: string;
        } | {
            readonly type: "ReplyDelta";
            readonly seq: number;
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "ReplyFinished";
            readonly seq: number;
            readonly id: string;
        } | {
            readonly type: "ReplyFailed";
            readonly seq: number;
            readonly id: string;
            readonly reason: string;
        };
    } | {
        readonly _tag: "SucceededPost";
        readonly clientId: string;
    } | {
        readonly _tag: "UpdatedDraft";
        readonly value: string;
    }, {
        readonly conversation: string;
        readonly epoch: number;
        readonly from: number;
        readonly open: boolean;
    }, Factory> & {
        readonly __subscription: never;
    };
};
/**
 * Moving between the splash and the chat morphs the splash into its pane and the prompt into the composer. Nothing
 * else animates: the ⌘K prompt opens at once, and a view transition would swallow clicks while it runs.
 * @throws {never}
 */
export declare const viewTransition: Runtime.ViewTransitionConfig<Model, Message>;
