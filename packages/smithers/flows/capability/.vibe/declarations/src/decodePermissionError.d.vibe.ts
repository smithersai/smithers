/**
 * Constructed permission failures from structural boundary values.
 *
 * @since 1.0.0-rc.0
 */
import { Option } from "effect";
import { type PermissionError } from "../../../src/Permission.ts";
/**
 * Validates data before constructing a yieldable permission error. Invalid
 * payloads, inspection failures, or metadata exceeding the constructor's
 * limits return None.
 * Construction also accepts instances from another copy of the package,
 * without relying on JavaScript instanceof identity.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const decodePermissionError: (input: unknown) => Option.Option<PermissionError>;
