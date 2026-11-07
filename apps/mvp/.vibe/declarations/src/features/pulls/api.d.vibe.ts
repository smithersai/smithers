import { Context, type Duration, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { WriteTaken } from "../../../../../src/features/issues/schema.ts";
import { type MergeMethod } from "../../../../../src/features/pulls/contract";
import { type ReviewRequest, ReviewTaken } from "../../../../../src/features/pulls/flows.ts";
import { Compared } from "../../../../../src/features/pulls/schema.ts";
declare const PullsRequestFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "PullsRequestFailed";
} & Readonly<A>;
/**
 * ChatApi didn't answer the request: no whole answer within the deadline, no network (`status` absent), or any other
 * status, with ChatApi's `code` when its body had one.
 */
export declare class PullsRequestFailed extends PullsRequestFailed_base<{
    readonly status?: number;
    readonly code?: string;
}> {
}
/** A merge as the writes route takes it: the pull request, bound to the head and base the person saw. */
export interface MergeRequest {
    readonly writeId: string;
    readonly number: number;
    readonly headSha: string;
    readonly baseSha: string;
    readonly method: MergeMethod;
}
declare const PullsClient_base: Context.ServiceClass<PullsClient, "@smthrs/mvp/pulls/PullsClient", {
    /** `POST .../writes` with `op: "pr/merge"`, in the person's session: `202` took it, `200` had it already. */
    readonly merge: (owner: string, name: string, merge: MergeRequest) => Effect.Effect<WriteTaken, PullsRequestFailed>;
    /** `GET .../compare/<base>...<head>`: the files two commits differ by. */
    readonly compare: (owner: string, name: string, base: string, head: string) => Effect.Effect<Compared, PullsRequestFailed>;
    /** `POST .../pulls/<number>/review { headSha? }`: ask Smithers to review the head; `202` took it. */
    readonly review: (request: ReviewRequest) => Effect.Effect<ReviewTaken, PullsRequestFailed>;
}>;
/** ChatApi's pull request routes, as a service. Tests of a route that fails provide a faulty one. */
export declare class PullsClient extends PullsClient_base {
    /** The real client: ChatApi at `origin`, with `within` for each whole request. */
    static readonly layer: (options: {
        readonly origin: string;
        readonly within: Duration.Input;
    }) => Layer.Layer<PullsClient, never, HttpClient.HttpClient>;
}
export {};
