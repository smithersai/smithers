/**
 * `smthrs`: dependency installation expressed as flows.
 *
 * Three modules, mirroring the three questions the design answers: which
 * interpreter the host runs, which package manager does the work, and what the
 * work is made of.
 *
 * @since 0.1.0
 */

/**
 * The `install` flow, its action declarations, and their implementation layers.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Install from "./Install.vibe"

/**
 * The package-manager layer seam, its pnpm implementation, and the typed Bun
 * refusal.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageManager from "./PackageManager.ts"

/**
 * The runtime seam: the interpreter a workspace declares, the platform facts it
 * reports, and the host check that holds the machine to the declaration.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Runtime from "./Runtime.ts"
