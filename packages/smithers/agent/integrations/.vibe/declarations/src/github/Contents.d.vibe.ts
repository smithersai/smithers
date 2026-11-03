/**
 * Repository file contents over the {@link GitHubClient} in context.
 *
 * A plain operation, not a durable action: the flow step that calls it
 * chooses the token by providing the client. The path and ref are validated
 * before they become a request, so a hostile path cannot walk the
 * token-bearing request to another endpoint, and the base64 GitHub answers is
 * decoded with `atob` and `TextDecoder`, which every platform the package
 * runs on provides.
 *
 * @since 1.0.0
 */
import { Effect, Option } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import { GitHubClient } from "../../../../src/github/GitHubClient.ts";
/**
 * A text file's contents and its blob SHA.
 *
 * @category models
 * @since 1.0.0
 */
export interface TextFile {
    readonly sha: string;
    readonly text: string;
}
/**
 * The longest ref {@link getText} accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_REF_LENGTH = 255;
/**
 * The text of file `path` at `options.ref` (the default branch when absent):
 * `GET /repos/{owner}/{repo}/contents/{path}?ref=…`. Answers `Option.none()`
 * when GitHub answers 404.
 *
 * `path` is relative, with non-empty segments, no `.` or `..` segment, no
 * backslash and no control character; each segment is encoded. `ref` is 1 to
 * {@link MAX_REF_LENGTH} characters without spaces or control characters.
 *
 * Fails `decode-failed` when the path names a directory, a symlink or a
 * submodule, a file over GitHub's 1 MB contents limit, or bytes that are not
 * UTF-8.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const getText: (owner: string, repo: string, path: string, options?: {
    readonly ref?: string | undefined;
}) => Effect.Effect<Option.Option<TextFile>, IntegrationError, GitHubClient>;
