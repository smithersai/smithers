/**
 * The directory names a repository walk never descends into.
 *
 * `grep` and `glob` walk with the kernel filesystem, and every entry costs a
 * guarded stat. A walk rooted at "." that descends into `.git` visits tens of
 * thousands of object files no search wants: one such `grep` held a benchmark
 * frame for its entire fifteen-minute ceiling. The skip set is the same
 * convention ripgrep ships — version control, dependency trees, and caches —
 * and an explicit root inside a skipped directory still walks, because
 * skipping applies to descent, never to what the caller named.
 *
 * @since 1.0.0
 */

/**
 * Directory basenames excluded from recursive descent.
 *
 * @category constants
 * @since 1.0.0
 */
export const skippedDirectories: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".jj",
  ".svn",
  ".flows",
  "node_modules",
  "__pycache__",
  ".venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache"
])
