/**
 * One file's entry in a parsed `git diff`, before any review filter runs.
 *
 * A rename carries both paths, and a deletion spells the missing side
 * `/dev/null`, so `effectivePath` is what decides which name a finding uses.
 *
 * @since 1.0.0
 * @category models
 */
export type DiffRecord = {
  oldPath: string
  newPath: string
  diff: string
  insertions: number
  deletions: number
  isNew: boolean
  isDeleted: boolean
  isBinary: boolean
  /**
   * The source showed no patch for a text change: GitHub leaves out a diff it
   * finds too large to show. Git always prints one, so a record read from a
   * checkout never sets this.
   */
  patchWithheld?: boolean
}
