/**
 * The `Stats` slice of a ZenFS promises API.
 *
 * @since 1.0.0-rc.0
 */

/**
 * The subset of a ZenFS/Node `Stats` object `stat` needs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ZenFsStatsLike {
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
}
