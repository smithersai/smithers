/**
 * Name-based UUIDs (RFC 9562 §5.5, version 5): the same namespace and name
 * always give the same UUID, on every host, with no coordination.
 *
 * A host that must know an identifier before it can ask anyone, such as a
 * device offline that names the conversation of a branch it already knows,
 * derives it from names both sides share. The digest is SHA-1 through the
 * injected `effect/Crypto` service, as the RFC defines version 5; SHA-1's
 * weakness doesn't matter here, because a name-based UUID is an identifier,
 * never a secret or a proof.
 *
 * @since 1.0.0-rc.17
 */
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Crypto from "../../../src/Crypto.ts";
/**
 * Whether `value` is a UUID in its canonical hyphenated form, in either case.
 *
 * @category validation
 * @since 1.0.0-rc.17
 */
export declare const isUuid: (value: string) => boolean;
/**
 * The version 5 UUID of `name` in `namespace`, in lowercase: SHA-1 of the
 * namespace's 16 bytes followed by the name's UTF-8 bytes, cut to 16 bytes,
 * with the version and variant bits set. A `namespace` that isn't a UUID is a
 * defect: it is a constant the caller wrote.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export declare const v5: (namespace: string, name: string) => Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto>;
