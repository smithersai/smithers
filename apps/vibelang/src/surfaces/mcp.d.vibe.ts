import { Cause, Effect, Layer } from "effect";
import { McpServer, Toolkit } from "effect/ai";
import { Factory } from "../core/Factory.vibe";
import { type CommandError } from "./commands.vibe";
export declare const toolkit: Toolkit.Toolkit<{
    readonly ask: import("effect/ai/Tool").Tool<"ask", {
        readonly parameters: import("effect/Schema").Struct<{
            readonly text: import("effect/Schema").String;
            readonly conversation: import("effect/Schema").withDecodingDefaultKey<import("effect/Schema").String, never>;
        }>;
        readonly success: import("effect/Schema").Struct<{
            readonly conversation: import("effect/Schema").String;
            readonly text: import("effect/Schema").String;
            readonly events: import("effect/Schema").$Array<import("effect/Schema").Int>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
    readonly read: import("effect/ai/Tool").Tool<"read", {
        readonly parameters: import("effect/Schema").Struct<{
            readonly conversation: import("effect/Schema").withDecodingDefaultKey<import("effect/Schema").String, never>;
            readonly after: import("effect/Schema").withDecodingDefaultKey<import("effect/Schema").Int, never>;
        }>;
        readonly success: import("effect/Schema").Struct<{
            readonly conversation: import("effect/Schema").String;
            readonly seq: import("effect/Schema").Int;
            readonly entries: import("effect/Schema").$Array<import("effect/Schema").Struct<{
                readonly id: import("effect/Schema").String;
                readonly seq: import("effect/Schema").Int;
                readonly clientId: import("effect/Schema").String;
                readonly author: import("effect/Schema").Literals<readonly ["person", "agent"]>;
                readonly name: import("effect/Schema").String;
                readonly text: import("effect/Schema").String;
                readonly done: import("effect/Schema").Boolean;
                readonly error: import("effect/Schema").String;
            }>>;
        }>;
        readonly failure: typeof CommandError;
        readonly failureMode: "error";
    }, never>;
}>;
export declare const registrations: Layer.Layer<never, never, Factory | McpServer.McpServer>;
/** Stdio owns stdout; all failure reporting stays on stderr, including runtime defects. */
export declare function mcp(mock: boolean, environment: string | undefined): Effect.Effect<void, Cause.IllegalArgumentError | import("./backend.vibe").LiveBackendNotDeployed, import("effect/Stdio").Stdio>;
