/**
 * Package metadata used by the command-line entrypoint.
 *
 * @since 0.1.0
 */

import metadata from "@smthrs/cli/package.json" with { type: "json" }

/**
 * Extracts and validates the version string from `@smthrs/cli` package metadata.
 *
 * @category configuration
 * @since 1.0.0
 */
export const readVersion = (manifest: { readonly version?: unknown }): string => {
  if (typeof manifest.version !== "string") {
    throw new TypeError("@smthrs/cli package metadata does not declare a version")
  }
  return manifest.version
}

/**
 * The version published in `@smthrs/cli` package metadata.
 *
 * This is what `smthrs --version` prints and what `smthrs update` compares
 * against the registry, so it is read from the shipped manifest rather than
 * from a constant a release could forget to bump.
 *
 * The module throws at import when the manifest declares no version string.
 * `--version` is the one answer a packaging mistake can silently corrupt, and
 * printing `undefined` to an operator is worse than refusing to start.
 *
 * @category configuration
 * @since 0.1.0
 */
export const packageVersion = readVersion(metadata)
