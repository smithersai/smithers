import { Context, type Duration, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
/** A question for `POST /api/questions` (docs/features/chat.md#post-apiquestions). */
export type Question = {
    readonly id: string;
    readonly answerId: string;
    readonly text: string;
    /** The view it was sent from, and the values sent with it (docs/features/views.md). */
    readonly source?: {
        readonly viewId: string;
        readonly event: string;
    };
    readonly data?: Readonly<Record<string, string | number | boolean>>;
};
/**
 * What ChatApi did with a question:
 * - `inserted`: 202, both rows inserted in one Postgres transaction;
 * - `existing`: 200, the question was already there, so this was a retry that changed nothing.
 */
export type Taken = {
    readonly _tag: "inserted";
} | {
    readonly _tag: "existing";
};
declare const QuestionNotTaken_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "QuestionNotTaken";
} & Readonly<A>;
/**
 * ChatApi didn't take the question:
 * - `unreachable`: no whole answer within the deadline, its body included, for example offline;
 * - `refused`: an answer other than 200 or 202, such as 409 for a retry that doesn't match the stored question;
 * - `invalid_response`: 200 or 202 with a body outside the contract, or one that broke off.
 */
export declare class QuestionNotTaken extends QuestionNotTaken_base<{
    readonly reason: "unreachable" | "refused" | "invalid_response";
    readonly status?: number;
}> {
}
/**
 * Asks ChatApi to store a question and its empty answer. One deadline, `within`, covers the whole request: sending it,
 * the status and reading the body. Past it, the request is aborted and the question counts as `unreachable`.
 */
export declare const postQuestion: (url: string, question: Question, within: Duration.Input) => Effect.Effect<{
    _tag: "existing";
} | {
    _tag: "inserted";
}, QuestionNotTaken, HttpClient.HttpClient>;
declare const ChatClient_base: Context.ServiceClass<ChatClient, "@smthrs/mvp/chat/ChatClient", {
    readonly ask: (question: Question) => Effect.Effect<Taken, QuestionNotTaken>;
}>;
/**
 * ChatApi's client, as a service: the one way the browser asks a question. The real one posts `POST /api/questions`
 * (`postQuestion`). Tests of what happens when ChatApi refuses or times out provide a faulty one
 * (src/test/faults.ts); every other test uses the real one.
 */
export declare class ChatClient extends ChatClient_base {
    /** The real client: ChatApi at `url`, with `within` for each whole request. */
    static readonly layer: (options: {
        readonly url: string;
        readonly within: Duration.Input;
    }) => Layer.Layer<ChatClient, never, HttpClient.HttpClient>;
}
export {};
