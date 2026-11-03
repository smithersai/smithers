/**
 * Route construction for OpenAI's ChatGPT-subscription Responses backend, the
 * deployment the codex CLI speaks. The wire protocol is
 * {@link OpenAIResponses.chatgptProtocol}: the same SSE stream as
 * api.openai.com with the request narrowed to the subscription surface.
 *
 * The credential is an OAuth access token plus a `chatgpt-account-id` header,
 * both rotating, so the route takes a composed {@link Auth.Auth} rather than a
 * redacted key: the host owns the token store and its refresh, and this module
 * owns everything deterministic — endpoint, protocol, and the static header
 * set the backend was confirmed against (2026-08-25).
 *
 * @since 0.1.0
 */
import * as Result from "effect/Result";
import type * as Auth from "../../../src/Auth.ts";
import * as OpenAIResponses from "../../../src/OpenAIResponses.ts";
import * as Route from "../../../src/Route.ts";
/**
 * The ChatGPT backend origin plus base path. The Responses call is served at
 * `{baseUrl}/codex/responses` — no `/v1` prefix, unlike api.openai.com.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export declare const defaultBaseUrl = "https://chatgpt.com/backend-api";
/**
 * The client identity headers the backend was confirmed against. They are
 * deterministic route identity, safe in the sealed-step view; the bearer and
 * account id are not, and arrive through `Auth.sign` alone.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export declare const clientHeaders: Readonly<Record<string, string>>;
/**
 * Builds the ChatGPT-subscription Responses route.
 *
 * ```ts
 * const chatgpt = OpenAIChatGPT.make({ auth: codexStore.auth({ modelId }) })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export declare const make: (input: {
    readonly auth: Auth.Auth;
    readonly baseUrl?: string | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
}) => Result.Result<Route.Route<{
    readonly model: string;
    readonly instructions?: string | undefined;
    readonly input: readonly ({
        readonly role: "user";
        readonly content: readonly {
            readonly type: "input_text";
            readonly text: string;
        }[];
    } | {
        readonly role: "assistant";
        readonly content: readonly {
            readonly type: "output_text";
            readonly text: string;
        }[];
    } | {
        readonly type: "item_reference";
        readonly id: string;
    } | {
        readonly type: "function_call";
        readonly call_id: string;
        readonly name: string;
        readonly arguments: string;
    } | {
        readonly type: "function_call_output";
        readonly call_id: string;
        readonly output: string;
    } | {
        readonly type: "tool_search_call";
        readonly call_id: string;
        readonly execution: "client";
        readonly status: "completed";
        readonly arguments: {
            readonly query: string;
            readonly limit: number;
        };
    } | {
        readonly type: "tool_search_output";
        readonly call_id: string;
        readonly execution: "client";
        readonly status: "completed";
        readonly tools: readonly {
            readonly type: "function";
            readonly name: string;
            readonly description: string;
            readonly parameters: import("effect/Schema").JsonObject;
            readonly defer_loading?: boolean | undefined;
        }[];
    } | {
        readonly type: "reasoning";
        readonly id?: string | undefined;
        readonly summary?: readonly import("effect/Schema").Json[] | undefined;
        readonly encrypted_content?: string | undefined;
    })[];
    readonly tools?: readonly ({
        readonly type: "function";
        readonly name: string;
        readonly description: string;
        readonly parameters: import("effect/Schema").JsonObject;
        readonly defer_loading?: boolean | undefined;
    } | {
        readonly type: "web_search";
        readonly filters?: {
            readonly allowed_domains: readonly string[];
        } | undefined;
    })[] | undefined;
    readonly reasoning?: {
        readonly effort: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh";
        readonly summary?: "auto" | "concise" | "detailed" | undefined;
    } | undefined;
    readonly temperature?: number | undefined;
    readonly top_p?: number | undefined;
    readonly stream: true;
    readonly prompt_cache_key?: string | undefined;
    readonly store: false;
    readonly include: readonly "reasoning.encrypted_content"[];
}, string, {
    readonly type: string;
    readonly code?: string | undefined;
    readonly message?: string | undefined;
    readonly param?: string | null | undefined;
    readonly item_id?: string | undefined;
    readonly delta?: string | undefined;
    readonly arguments?: string | undefined;
    readonly item?: import("effect/Schema").JsonObject | undefined;
    readonly response?: import("effect/Schema").JsonObject | undefined;
    readonly error?: import("effect/Schema").JsonObject | undefined;
}, OpenAIResponses.State>, import("./ModelError.vibe").ModelError>;
