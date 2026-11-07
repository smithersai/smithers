import { Effect, Layer } from "effect";
import { ShareClient, type ShareRefused } from "../../../../../src/features/sharing/api.ts";
import { BranchShareRefused, BranchShareUnavailable, RequestShare, type ShareFailure } from "../../../../../src/features/sharing/flows";
import type { Change } from "../../../../../src/features/sharing/schema";
/** What ChatApi's refusal means to the flow. */
export declare const shareFailure: (refused: ShareRefused) => ShareFailure;
/** The kind of change, for the records: never the login or the grantee. */
export declare const kindOf: (change: Change) => string;
/**
 * What `branch/share/request` does: one `POST /api/branches/<id>/shares`. Records a span `branch.share`, a log line
 * with the change's kind, the outcome and ChatApi's status, and a count of `shares` by kind and outcome.
 */
export declare const requestShare: ({ branchId, change }: typeof RequestShare.payloadSchema.Type) => Effect.Effect<{
    readonly txid: number | null;
}, BranchShareRefused | BranchShareUnavailable, ShareClient>;
/** Registers `branch/share` with its step, asking through the host's `ShareClient`. */
export declare const registration: Layer.Layer<import("@smthrs/flow/Action").Requirement<"branch/share/request">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | ShareClient>;
/** `branch/share`, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export declare const registrationAt: (origin: string) => Layer.Layer<import("@smthrs/flow/Action").Requirement<"branch/share/request">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/http/HttpClient").HttpClient>;
