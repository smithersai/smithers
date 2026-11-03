/**
 * The no-op artifact store: the honest refusal a composition gets when it has
 * no artifact store at all, with per-method overrides.
 *
 * @since 1.0.0-rc.0
 */
import type { Service } from "../../../src/ArtifactStore.ts";
/**
 * Builds an artifact store whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
