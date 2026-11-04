/**
 * Structural validation of a permission-error payload at a trust boundary.
 *
 * @since 0.1.0
 */
import type { PermissionErrorPayload } from "../../../src/PermissionErrorPayload.ts";
/**
 * Refines an unknown value to data-only permission fields, not a yieldable
 * error instance. Own accessors and inherited fields are rejected; metadata
 * is checked through descriptors at every depth. This establishes structure,
 * not the producer or request identity. Use the package-root decodePermissionError to construct
 * an error instance after validation.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export declare const isPermissionError: (input: unknown) => input is PermissionErrorPayload;
