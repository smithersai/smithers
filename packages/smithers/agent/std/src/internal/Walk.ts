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

import type * as Path from "@smthrs/kernel/Path"
import { Effect } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as StdError from "../StdError.ts"
import * as Ignore from "./Ignore.ts"
import { notFound } from "./SearchContract.ts"

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

/**
 * How many filesystem questions one directory level asks at a time.
 *
 * A metadata call through the layer costs far more in fiber scheduling than in
 * kernel time, so asking one entry at a time is what makes a walk slow: the
 * same probe measured 28.8 µs sequentially and 6.0 µs at this width on the
 * SWE-bench pytest tree. The bound keeps the file-descriptor and thread-pool
 * pressure of a wide directory predictable.
 */
const concurrency = 16

/**
 * Answers whether each path is a symbolic link, which neither peer follows.
 *
 * `FileSystem.stat` resolves links, so the only probe available is `readLink`,
 * and every probe is one more call in a loop that already makes one per entry.
 * The walk therefore probes directories, where following a link would duplicate
 * a subtree or loop forever, and the callers probe the far smaller set of files
 * they are about to report — batched, never one at a time.
 */
export const symbolicLinks = (
  fileSystem: FileSystem.FileSystem,
  candidates: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<boolean>> =>
  Effect.forEach(
    candidates,
    (candidate) => fileSystem.readLink(candidate).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    { concurrency }
  )

/**
 * One walk: the files under the root, and whether the root was one file.
 */
export interface Walked {
  readonly ignored: boolean
  readonly explicitFile: boolean
  readonly files: ReadonlyArray<string>
}

/**
 * Lists the files a search under `root` reaches.
 *
 * Only the root the caller named is allowed to fail the walk. Every entry
 * below it that the process cannot inspect — a dangling symlink, a symlink
 * loop, a directory it may not list — is skipped and the walk continues, which
 * is what `rg --no-messages` does with the same tree. Turning one of those into
 * a typed failure would make a whole repository unsearchable because of one
 * link, and would answer differently from the native peer.
 */
export const files = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  hidden: boolean,
  noIgnore = false
): Effect.Effect<Walked, StdError.StdError> =>
  Effect.gen(function*() {
    const info = yield* fileSystem.stat(root).pipe(Effect.mapError(() => notFound(root)))
    if (info.type === "File") return { explicitFile: true, files: [path.normalize(root)], ignored: false }
    const files: Array<string> = []
    let excluded = false
    const directories: Array<{ directory: string; scopes: ReadonlyArray<Ignore.Scope> }> = [{ directory: root, scopes: [] }]
    while (directories.length > 0) {
      const next = directories.pop()
      if (next === undefined) continue
      const { directory } = next
      let scopes = next.scopes
      const children: ReadonlyArray<string> = yield* fileSystem.readDirectory(directory).pipe(
        Effect.catch(() =>
          directory === root
            ? Effect.fail(notFound(directory))
            : Effect.succeed<ReadonlyArray<string>>([])
        )
      )
      if (!noIgnore && children.includes(".gitignore")) {
        const content = yield* fileSystem.readFileString(path.join(directory, ".gitignore")).pipe(
          Effect.orElseSucceed(() => "")
        )
        const scope = Ignore.parse(directory, content)
        if (scope.rules.length > 0) scopes = [...scopes, scope]
      }
      const candidates = children
        .filter((child) => !skippedDirectories.has(child) && (hidden || !child.startsWith(".")))
        .map((child) => path.join(directory, child))
      const entries = yield* Effect.forEach(candidates, (candidate) =>
        fileSystem.stat(candidate).pipe(
          Effect.map((candidateInfo): { readonly candidate: string; readonly type: string | undefined } => ({
            candidate,
            type: candidateInfo.type
          })),
          Effect.orElseSucceed(() => ({ candidate, type: undefined }))
        ), { concurrency })
      const nested: Array<string> = []
      for (const entry of entries) {
        if (entry.type !== undefined && Ignore.ignored(scopes, entry.candidate, path.basename(entry.candidate), entry.type === "Directory", path.relative)) {
          excluded = true
          continue
        }
        if (entry.type === "Directory") nested.push(entry.candidate)
        else if (entry.type === "File") files.push(path.normalize(entry.candidate))
      }
      const links = yield* symbolicLinks(fileSystem, nested)
      for (let index = 0; index < nested.length; index++) {
        const candidate = nested[index]
        if (candidate !== undefined && links[index] !== true) directories.push({ directory: candidate, scopes })
      }
    }
    return { explicitFile: false, files: files.sort(), ignored: excluded }
  })

