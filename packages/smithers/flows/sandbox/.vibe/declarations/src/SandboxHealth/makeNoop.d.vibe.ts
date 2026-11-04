/**
 * Constructs a healthy no-op sandbox health service.
 *
 * @since 0.1.0
 */
import type { Service } from "./Service.vibe";
/**
 * A no-op service that always reports `Healthy` for hosts without a remote
 * sandbox.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: () => Service;
