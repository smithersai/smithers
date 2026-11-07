import { GitHub } from "@smthrs/integrations";
import { Effect, Redacted } from "effect";
import type { HttpClient } from "effect/http";
/**
 * What a failed GitHub call means to a step:
 * - `retry`: nothing was done, or a read failed; the step's retry policy tries again, after `retryAfterMillis`;
 * - `unknown`: a write's answer was lost, so GitHub may have applied it; the next attempt looks for its marker first;
 * - `refused`: GitHub answered no, with `status` (401, 403, 404, 410, 422 ...); trying again changes nothing.
 */
export type Classified = {
    readonly kind: "retry";
    readonly retryAfterMillis?: number;
} | {
    readonly kind: "unknown";
} | {
    readonly kind: "refused";
    readonly status: number;
};
/**
 * The longest wait a failure's own instant asks for that this honors, in milliseconds: the GitHub proxy's
 * `x-smithers-retry-at` is capped as `@smthrs/integrations` caps `Retry-After` (`CredentialHttp.MAX_RETRY_AFTER_MS`),
 * so a far-future instant can't hold a role read, or a step, for hours.
 */
export declare const MAX_WAIT_MILLIS = 60000;
/** Reads a failure from `@smthrs/integrations`: its classification and status, never its message. */
export declare const classify: (error: unknown) => Classified;
/** Whether GitHub refused a call for its rate limit, primary or secondary (`@smthrs/integrations`' `rateLimited`). */
export declare const isRateLimited: (error: unknown) => boolean;
/** GitHub's status for a failed call, when it answered one: for log lines. */
export declare const statusOf: (error: unknown) => number | undefined;
/**
 * Runs `effect` with a GitHub client for `token` on `apiBaseUrl`, over the `HttpClient` in context. The client never
 * reads the ambient environment, so no other token decides who calls.
 */
export declare const withToken: (token: Redacted.Redacted<string>, apiBaseUrl: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, GitHub.GitHubClient.GitHubClient> | HttpClient.HttpClient>;
