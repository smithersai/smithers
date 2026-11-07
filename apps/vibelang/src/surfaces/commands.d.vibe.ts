import { Effect, Schema } from "effect";
import { Argument, Flag } from "effect/cli";
import { Tool } from "effect/ai";
import { Factory } from "../core/Factory.vibe";
declare const CommandError_base: Schema.Class<CommandError, Schema.TaggedStruct<"CommandError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class CommandError extends CommandError_base {
}
export declare const AskInput: Schema.Struct<{
    readonly text: Schema.String;
    readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
}>;
export type AskInput = typeof AskInput.Type;
export declare const ReadInput: Schema.Struct<{
    readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly after: Schema.withDecodingDefaultKey<Schema.Int, never>;
}>;
export type ReadInput = typeof ReadInput.Type;
export declare const AskOutput: Schema.Struct<{
    readonly conversation: Schema.String;
    readonly text: Schema.String;
    readonly events: Schema.$Array<Schema.Int>;
}>;
export type AskOutput = typeof AskOutput.Type;
export declare const ReadOutput: Schema.Struct<{
    readonly conversation: Schema.String;
    readonly seq: Schema.Int;
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly seq: Schema.Int;
        readonly clientId: Schema.String;
        readonly author: Schema.Literals<readonly ["person", "agent"]>;
        readonly name: Schema.String;
        readonly text: Schema.String;
        readonly done: Schema.Boolean;
        readonly error: Schema.String;
    }>>;
}>;
export type ReadOutput = typeof ReadOutput.Type;
export declare const Ask: {
    name: "ask";
    description: string;
    input: Schema.Struct<{
        readonly text: Schema.String;
        readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>;
    output: Schema.Struct<{
        readonly conversation: Schema.String;
        readonly text: Schema.String;
        readonly events: Schema.$Array<Schema.Int>;
    }>;
    parameters: {
        text: Argument.Argument<string>;
        conversation: Flag.Flag<string>;
    };
    run: (value: unknown) => Effect.Effect<{
        readonly conversation: string;
        readonly text: string;
        readonly events: readonly number[];
    }, CommandError, Factory>;
    render: (value: unknown, json: boolean) => Effect.Effect<string, CommandError, Factory>;
    tool: Tool.Tool<"ask", {
        readonly parameters: Schema.Struct<{
            readonly text: Schema.String;
            readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>;
        readonly success: Schema.Struct<{
            readonly conversation: Schema.String;
            readonly text: Schema.String;
            readonly events: Schema.$Array<Schema.Int>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
};
export declare const Read: {
    name: "read";
    description: string;
    input: Schema.Struct<{
        readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly after: Schema.withDecodingDefaultKey<Schema.Int, never>;
    }>;
    output: Schema.Struct<{
        readonly conversation: Schema.String;
        readonly seq: Schema.Int;
        readonly entries: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly seq: Schema.Int;
            readonly clientId: Schema.String;
            readonly author: Schema.Literals<readonly ["person", "agent"]>;
            readonly name: Schema.String;
            readonly text: Schema.String;
            readonly done: Schema.Boolean;
            readonly error: Schema.String;
        }>>;
    }>;
    parameters: {
        conversation: Flag.Flag<string>;
        after: Flag.Flag<number>;
    };
    run: (value: unknown) => Effect.Effect<{
        readonly conversation: string;
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
    }, CommandError, Factory>;
    render: (value: unknown, json: boolean) => Effect.Effect<string, CommandError, Factory>;
    tool: Tool.Tool<"read", {
        readonly parameters: Schema.Struct<{
            readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly after: Schema.withDecodingDefaultKey<Schema.Int, never>;
        }>;
        readonly success: Schema.Struct<{
            readonly conversation: Schema.String;
            readonly seq: Schema.Int;
            readonly entries: Schema.$Array<Schema.Struct<{
                readonly id: Schema.String;
                readonly seq: Schema.Int;
                readonly clientId: Schema.String;
                readonly author: Schema.Literals<readonly ["person", "agent"]>;
                readonly name: Schema.String;
                readonly text: Schema.String;
                readonly done: Schema.Boolean;
                readonly error: Schema.String;
            }>>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
};
export declare const commands: readonly [{
    name: "ask";
    description: string;
    input: Schema.Struct<{
        readonly text: Schema.String;
        readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>;
    output: Schema.Struct<{
        readonly conversation: Schema.String;
        readonly text: Schema.String;
        readonly events: Schema.$Array<Schema.Int>;
    }>;
    parameters: {
        text: Argument.Argument<string>;
        conversation: Flag.Flag<string>;
    };
    run: (value: unknown) => Effect.Effect<{
        readonly conversation: string;
        readonly text: string;
        readonly events: readonly number[];
    }, CommandError, Factory>;
    render: (value: unknown, json: boolean) => Effect.Effect<string, CommandError, Factory>;
    tool: Tool.Tool<"ask", {
        readonly parameters: Schema.Struct<{
            readonly text: Schema.String;
            readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>;
        readonly success: Schema.Struct<{
            readonly conversation: Schema.String;
            readonly text: Schema.String;
            readonly events: Schema.$Array<Schema.Int>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
}, {
    name: "read";
    description: string;
    input: Schema.Struct<{
        readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly after: Schema.withDecodingDefaultKey<Schema.Int, never>;
    }>;
    output: Schema.Struct<{
        readonly conversation: Schema.String;
        readonly seq: Schema.Int;
        readonly entries: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly seq: Schema.Int;
            readonly clientId: Schema.String;
            readonly author: Schema.Literals<readonly ["person", "agent"]>;
            readonly name: Schema.String;
            readonly text: Schema.String;
            readonly done: Schema.Boolean;
            readonly error: Schema.String;
        }>>;
    }>;
    parameters: {
        conversation: Flag.Flag<string>;
        after: Flag.Flag<number>;
    };
    run: (value: unknown) => Effect.Effect<{
        readonly conversation: string;
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
    }, CommandError, Factory>;
    render: (value: unknown, json: boolean) => Effect.Effect<string, CommandError, Factory>;
    tool: Tool.Tool<"read", {
        readonly parameters: Schema.Struct<{
            readonly conversation: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly after: Schema.withDecodingDefaultKey<Schema.Int, never>;
        }>;
        readonly success: Schema.Struct<{
            readonly conversation: Schema.String;
            readonly seq: Schema.Int;
            readonly entries: Schema.$Array<Schema.Struct<{
                readonly id: Schema.String;
                readonly seq: Schema.Int;
                readonly clientId: Schema.String;
                readonly author: Schema.Literals<readonly ["person", "agent"]>;
                readonly name: Schema.String;
                readonly text: Schema.String;
                readonly done: Schema.Boolean;
                readonly error: Schema.String;
            }>>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
}];
export {};
