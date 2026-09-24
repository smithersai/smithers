/**
 * The one list of directory names a repository walk leaves out.
 *
 * `grep`, `glob` and `ls` walks, the tree fingerprint, and workspace
 * observation all read this list, so a directory one of them skips is never
 * counted, matched, or fingerprinted by another. Every entry is derived state:
 * version-control internals, dependency trees, caches, and the scratch
 * checkouts the checkpoint and test-baseline flows create inside the
 * workspace. A scratch checkout is a full copy of the repository at an older
 * commit, so walking it duplicates every match from a stale tree.
 *
 * @since 1.0.0
 */

/**
 * Workspace-relative directory holding checkpoint checkouts.
 *
 * @private
 * @since 1.0.0
 */
export const checkpointScratch = ".flows-checkpoints"

/**
 * Workspace-relative directory holding test-baseline checkouts.
 *
 * @private
 * @since 1.0.0
 */
export const testBaseScratch = ".flows-test-base"

/**
 * Directory basenames no repository walk descends into.
 *
 * @private
 * @since 1.0.0
 */
export const repositoryDirectories: ReadonlyArray<string> = [
  ".git",
  ".hg",
  ".jj",
  ".svn",
  ".flows",
  ".artifacts",
  ".backend-go-modcache",
  ".pnpm-store",
  ".worktrees",
  "worktrees",
  checkpointScratch,
  testBaseScratch,
  "node_modules",
  "__pycache__",
  ".venv",
  ".tox",
  ".nox",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".turbo",
  ".next"
]
