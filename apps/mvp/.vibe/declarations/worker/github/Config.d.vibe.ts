import { Config, Effect, Option, Redacted } from "effect";
/** The repository G0 syncs: `owner/name` as `GITHUB_REPOSITORY` names it, and its row id (`github/<owner>/<name>`). */
export interface Repository {
    readonly owner: string;
    readonly name: string;
    readonly id: string;
}
/** The GitHub App, configured. */
export interface GitHubApp {
    readonly appId: string;
    readonly privateKey: Redacted.Redacted<string>;
    /** `GITHUB_WEBHOOK_SECRET`; none, and the webhook route answers `503 not_configured`. */
    readonly webhookSecret: Option.Option<Redacted.Redacted<string>>;
    readonly repository: Repository;
    /** GitHub's REST API: `GITHUB_API_URL`, `https://api.github.com` unless set. */
    readonly apiBaseUrl: string;
}
/** GitHub's REST API when `GITHUB_API_URL` is unset. */
export declare const DEFAULT_API_URL = "https://api.github.com";
/** `owner/name` as a `Repository`; `repositoryName` has checked its shape. */
export declare const repositoryOf: (full: string) => Repository;
/** `GITHUB_REPOSITORY`: the repository G0 syncs, the one sign-in reads roles on. */
export declare const repository: Config.Config<Repository>;
/** The same API origin for metadata reads, including when the App is no longer configured. */
export declare const apiUrl: Config.Config<string>;
/**
 * Reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPOSITORY` and `GITHUB_API_URL`.
 * `None` without the ID or the key: the git loop is off. The key's text is never read into a log line.
 */
export declare const configured: Effect.Effect<Option.Option<GitHubApp>, Config.ConfigError, never>;
