import { Effect } from "effect";
import { Core, GitHub } from "@smthrs/integrations";
/**
 * Lists the titles of a repository's open issues, following GitHub's
 * `Link: rel="next"` pages up to a page budget.
 *
 * @param client - A client from `GitHub.GitHubClient.make`.
 * @param owner - The account that owns the repository.
 * @param repo - The repository name.
 * @returns The titles in page order, and whether the page budget cut the
 *   listing short. Fails with an `IntegrationError`: `invalid-config` for an
 *   owner or repository GitHub could not have issued, `delivery-failed` for a
 *   refused request, and `decode-failed` for an item that is not an issue.
 * @since 1.0.0
 */
export declare const listOpenIssueTitles: (client: GitHub.GitHubClient.GitHubClient, owner: string, repo: string) => Effect.Effect<{
    titles: string[];
    truncated: boolean;
}, Core.IntegrationError.IntegrationError, never>;
