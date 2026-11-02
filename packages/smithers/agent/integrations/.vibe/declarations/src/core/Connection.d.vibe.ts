/**
 * A configured provider connection, as journal-safe data.
 *
 * A connection names a provider account the host holds a credential for, the
 * scopes the provider actually granted, and the containers (channels,
 * repositories, calendars) it may be used with. It never carries the secret:
 * `credential` is a control-plane `CredentialRef`, resolved through the
 * credential broker only at dispatch, so the value can appear in a flow
 * payload, a plan, or a journal entry.
 *
 * `personal` marks a connection to a person's own account. Which principals
 * may resolve its credential is a host authorization decision: `resolveSecret`
 * asks the host's `authorize` hook for the principal and the connection before
 * it touches the credential broker, and `personalPolicy` is the fail-closed
 * shape of that hook, under which only the named principals resolve personal
 * connections.
 *
 * @since 1.0.0
 */
import type { Credential } from "@smthrs/control/Credential";
import { Effect, type Redacted, Schema } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
/**
 * The shape a connection id must have: lowercase, digits, and single hyphens.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ConnectionId: Schema.String;
/**
 * A journal-safe reference to a stored credential.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const CredentialReference: Schema.Struct<{
    readonly id: Schema.NonEmptyString;
    readonly name: Schema.NonEmptyString;
}>;
/**
 * One configured provider connection.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Connection: Schema.Struct<{
    readonly id: Schema.String;
    /** The provider: `github`. */
    readonly provider: Schema.NonEmptyString;
    /** A human label for operators. */
    readonly label: Schema.String;
    readonly credential: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
        readonly name: Schema.NonEmptyString;
    }>;
    /** The provider scopes the credential actually holds. */
    readonly scopes: Schema.$Array<Schema.NonEmptyString>;
    /** Whether this is a person's own account rather than an organization identity. */
    readonly personal: Schema.Boolean;
    /** The containers the connection may be used with. Empty means none: allowlists fail closed. */
    readonly containers: Schema.$Array<Schema.NonEmptyString>;
    /** A provider API origin override, for enterprise hosts and fixture servers. */
    readonly apiBaseUrl: Schema.optionalKey<Schema.String>;
}>;
/**
 * One configured provider connection.
 *
 * @category models
 * @since 1.0.0
 */
export type Connection = typeof Connection.Type;
/**
 * Decodes an unknown value as a {@link Connection}.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const decode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => Effect.Effect<{
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly credential: {
        readonly id: string;
        readonly name: string;
    };
    readonly scopes: readonly string[];
    readonly personal: boolean;
    readonly containers: readonly string[];
    readonly apiBaseUrl?: string;
}, Schema.SchemaError, never>;
/**
 * The container id that allows every container of a connection.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const ANY_CONTAINER = "*";
/**
 * Whether `connection` may be used with `container`: the connection lists it,
 * or lists {@link ANY_CONTAINER}. An empty list allows nothing.
 *
 * @category authorization
 * @since 1.0.0
 */
export declare const containersAllowed: (connection: Pick<Connection, "containers">, container: string) => boolean;
/**
 * The host's decision whether `principal` may use `connection`'s credential.
 *
 * Answers `true` to allow. `false` is refused as `permission-denied`; a
 * failure is passed through.
 *
 * @category models
 * @since 1.0.0
 */
export type Authorize = (principal: string, connection: Connection) => Effect.Effect<boolean, IntegrationError>;
/**
 * A fail-closed host policy.
 *
 * A personal connection is resolvable only by a principal in
 * `personalPrincipals`, whatever `shared` says. Any other connection is decided
 * by `shared`, which defaults to allowing every principal.
 *
 * @category authorization
 * @since 1.0.0
 */
export declare const personalPolicy: (options: {
    readonly personalPrincipals: ReadonlyArray<string>;
    readonly shared?: Authorize | undefined;
}) => Authorize;
/**
 * Resolves `connection`'s secret for `principal`, at the transport boundary.
 *
 * `authorize` runs first, so a refused principal never reaches the broker. The
 * broker then authenticates the credential reference itself. A refusal by
 * either is `permission-denied`; a broker with no storage, or a stored value it
 * cannot open, is `credentials-missing`. Neither carries the secret, and the
 * resolved value stays `Redacted`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const resolveSecret: (options: {
    readonly credentials: Credential;
    readonly connection: Connection;
    readonly principal: string;
    readonly authorize: Authorize;
}) => Effect.Effect<Redacted.Redacted<string>, IntegrationError>;
