import { Context, type Duration, Effect, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { type Refusal } from "../../../../../src/features/secrets/contract";
declare const SecretNotSaved_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "SecretNotSaved";
} & Readonly<A>;
/** ChatApi didn't take the write: its refusal's `code`, or none for no whole answer within the deadline or no network. */
export declare class SecretNotSaved extends SecretNotSaved_base<{
    readonly code?: Refusal;
}> {
}
/** What `PUT` sets: the value, and the hosts and methods it binds to (every method when absent). */
export interface SecretPut {
    readonly value: Redacted.Redacted<string>;
    readonly hosts: ReadonlyArray<string>;
    readonly methods?: ReadonlyArray<string>;
}
declare const SecretsClient_base: Context.ServiceClass<SecretsClient, "@smthrs/mvp/secrets/SecretsClient", {
    /** `PUT /api/repos/<owner>/<name>/secrets/<NAME>`: `202` took it. */
    readonly put: (owner: string, name: string, secret: string, put: SecretPut) => Effect.Effect<void, SecretNotSaved>;
    /** `DELETE` the same path: `202` took it. */
    readonly remove: (owner: string, name: string, secret: string) => Effect.Effect<void, SecretNotSaved>;
}>;
/** ChatApi's secrets routes, as a service. Tests of a route that fails provide a faulty one. */
export declare class SecretsClient extends SecretsClient_base {
    /** The real client: ChatApi at `origin`, with `within` for each whole request. */
    static readonly layer: (options: {
        readonly origin: string;
        readonly within: Duration.Input;
    }) => Layer.Layer<SecretsClient, never, HttpClient.HttpClient>;
}
export {};
