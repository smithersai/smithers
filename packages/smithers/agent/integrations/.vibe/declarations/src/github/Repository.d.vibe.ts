/**
 * Repository coordinates, validated before they become a request path.
 *
 * This module exists because encoding is not enough. `encodeURIComponent("..")`
 * is `".."`, since dots are unreserved, and a hand-written `%2E%2E` is decoded
 * before the WHATWG URL parser removes dot segments, so
 * `new URL("https://api.github.com/repos/%2E%2E/%2E%2E/user/hooks").pathname`
 * is `/user/hooks`. An owner or repository interpolated straight into a path
 * therefore walks a token-bearing request to another GitHub endpoint, and the
 * client's origin pin does not help: the traversal stays on the configured
 * origin, so the bearer token goes with it.
 *
 * Every path this package builds from an owner and a repository goes through
 * {@link repositoryPath}, which validates each segment against GitHub's own
 * naming rules and only then encodes it.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
/**
 * GitHub's rule for an account name: 1 to 39 characters, alphanumerics and
 * hyphens, not starting with a hyphen.
 *
 * One underscore is allowed as a separator, because a GitHub Enterprise
 * Managed User's login is `<name>_<enterprise shortcode>` and such an account
 * owns repositories in its own namespace. Refusing it locked every
 * enterprise-managed account out of this package and bought nothing: only `.`
 * and `/` can walk a request off its endpoint, and neither is in this class.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const OWNER_PATTERN: RegExp;
/**
 * GitHub's rule for a repository name: 1 to 100 characters of alphanumerics,
 * dots, underscores, and hyphens. The leading guard excludes `.` and `..`,
 * which match the character class and are exactly the path traversal this
 * module exists to stop.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const REPO_PATTERN: RegExp;
/**
 * Whether `value` is a usable account name.
 *
 * @category refinements
 * @since 1.0.0
 */
export declare const isOwner: (value: unknown) => value is string;
/**
 * Whether `value` is a usable repository name.
 *
 * @category refinements
 * @since 1.0.0
 */
export declare const isRepo: (value: unknown) => value is string;
/**
 * An account name, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Owner: Schema.String;
/**
 * A repository name, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Repo: Schema.String;
/**
 * An issue or pull-request number, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssueNumber: Schema.Int;
/**
 * The `owner/repo` path segment pair, validated and then encoded.
 *
 * Throws an `IntegrationError` with reason `invalid-config` when either half
 * is not a name GitHub could have issued. Nothing in this package builds a
 * repository path any other way.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const repositoryPath: (owner: string, repo: string) => string;
/**
 * The same, for the `owner/repository` spelling a listener declaration uses.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const fullNamePath: (fullName: string) => string;
/**
 * {@link fullNamePath} in the Effect channel, for a caller inside `Effect.gen`
 * that needs a typed failure rather than a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const requireFullNamePath: (fullName: string) => Effect.Effect<string, IntegrationError>;
/**
 * {@link repositoryPath} in the Effect channel.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const requireRepositoryPath: (owner: string, repo: string) => Effect.Effect<string, IntegrationError>;
