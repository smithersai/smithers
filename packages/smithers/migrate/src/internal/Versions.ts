/**
 * The two release pins every migrated project ends on.
 *
 * Scan-side, so the detector can judge a manifest against the exact version
 * without loading the flow lane, and re-exported by `flow/Archive`, which
 * writes them into manifests.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/**
 * The Effect version every migrated project ends on. One pin, repository wide.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const effectVersion = "4.0.0-rc.115"

/**
 * The version every `@smthrs/*` package a migrated project depends on ends on.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const smithersVersion = "1.0.0-rc.0"
