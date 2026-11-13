/**
 * Lexical workspace confinement for declared generator output paths.
 * @since 1.0.0
 */

/**
 * Native path resolution and the shared containment decision.
 * @since 1.0.0
 * @private
 */
export interface Host {
  readonly resolve: (root: string, path: string) => string
  readonly inside: (root: string, path: string) => boolean
}

/**
 * Refuses an escape before any output metadata or bytes can be accessed.
 * @since 1.0.0
 * @private
 */
export const resolve = (host: Host, root: string, path: string): string => {
  const absolute = host.resolve(root, path)
  if (!host.inside(root, absolute)) throw new Error(`declared output escapes the workspace: ${path}`)
  return absolute
}
