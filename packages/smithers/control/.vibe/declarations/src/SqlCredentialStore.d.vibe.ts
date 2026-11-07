/**
 * Durable credential persistence over `@smthrs/database`.
 *
 * This is the host adapter behind {@link CredentialStore} on any runtime with
 * a SQL database — the Node composition uses `@smthrs/database/node`, and
 * tests use its in-memory SQLite driver. The module itself imports no `node:*`
 * API: it speaks the driver-neutral SQL contract, so it stays bundleable and a
 * browser host that ships a SQL driver can use it unchanged.
 *
 * Only ciphertext is stored. The row carries no key material, and the
 * compare-and-set on `version` is what makes two concurrent rotations
 * serializable: the loser is refused with `CredentialConflict` instead of
 * clobbering the winner.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { Unavailable } from "./ControlError.vibe";
import * as CredentialStore from "./CredentialStore.vibe";
/**
 * Creates the credential table if it does not exist.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const migrate: Effect.Effect<void, Unavailable, SqlClient.SqlClient>;
/**
 * Constructs a durable credential store over the ambient database.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: Effect.Effect<CredentialStore.Service, Unavailable, DurableWriter | SqlClient.SqlClient>;
/**
 * Provides durable credential persistence over the ambient database.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<CredentialStore.CredentialStore, Unavailable, DurableWriter | SqlClient.SqlClient>;
