/**
 * The bounded, deep-frozen JSON snapshot `PermissionRequired` takes of caller
 * metadata.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * @since 0.1.0
 * @private
 */
export declare const permissionMetaSnapshot: (meta: Readonly<Record<string, unknown>>) => Readonly<Record<string, Schema.Json>>;
