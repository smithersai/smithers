import { Effect } from "effect";
/**
 * One GitHub delivery as a receiver sees it: the exact body bytes and the
 * `X-Hub-Signature-256` header GitHub sent with them.
 *
 * @since 1.0.0
 */
export interface Delivery {
    readonly body: string;
    readonly signature: string | undefined;
}
/**
 * What {@link readIssueComment} found in a verified `issue_comment` delivery.
 *
 * @since 1.0.0
 */
export interface IssueComment {
    readonly repository: string;
    readonly issueNumber: number;
    readonly author: string;
    readonly body: string;
}
/**
 * Verifies a GitHub `issue_comment` delivery, then reads the comment from it.
 *
 * The signature is checked over the raw body before anything parses it, so a
 * forged delivery never reaches the decoder.
 *
 * @param delivery - The delivered bytes and their signature header.
 * @param secret - The webhook secret configured on the GitHub repository.
 * @returns An Effect that succeeds with the comment, or with `undefined` when
 *   the signature does not verify or the body is not an `issue_comment`
 *   payload.
 * @since 1.0.0
 */
export declare const readIssueComment: (delivery: Delivery, secret: string) => Effect.Effect<IssueComment | undefined>;
