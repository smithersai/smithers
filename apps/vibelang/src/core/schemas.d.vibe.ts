import { Schema } from "effect";
export declare const Entry: Schema.Struct<{
    readonly id: Schema.String;
    readonly seq: Schema.Number;
    readonly clientId: Schema.String;
    readonly author: Schema.Literals<readonly ["person", "agent"]>;
    readonly name: Schema.String;
    readonly text: Schema.String;
    readonly done: Schema.Boolean;
    readonly error: Schema.String;
}>;
export type Entry = typeof Entry.Type;
export declare const Conversation: Schema.Struct<{
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
export type Conversation = typeof Conversation.Type;
export declare const Pending: Schema.Struct<{
    readonly clientId: Schema.String;
    readonly text: Schema.String;
    readonly error: Schema.String;
}>;
export type Pending = typeof Pending.Type;
export declare const Client: Schema.Struct<{
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
export type Client = typeof Client.Type;
