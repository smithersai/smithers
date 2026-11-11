// The platform code of security-review-check.vibe: the exported trees read with Node's filesystem and hashing.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import * as LlmLint from "@smthrs/targets/LlmLint"
import type * as TrustedReview from "../../../packages/smithers/build/build-cli/src/TrustedReview.ts"
import { privatePath } from "../repository/check-context.vibe"

/** A file's SHA-256, streamed so a large committed artifact is never held in memory. */
const sha256 = async (path: string, signal: AbortSignal | undefined) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path, signal === undefined ? {} : { signal })) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/**
 * One exported tree as a {@link TrustedReview.ReviewSource} revision: every
 * entry by its repository path, its identity its kind, executable bit and
 * content digest. A private repository-job path never enters a review.
 */
const listTree = async (
  root: string,
  signal: AbortSignal | undefined
): Promise<Map<string, TrustedReview.SourceEntry>> => {
  const entries = new Map<string, TrustedReview.SourceEntry>()
  const found = await NodeFs.readdir(root, { withFileTypes: true, recursive: true })
  for (
    const dirent of found.sort((left, right) =>
      left.parentPath === right.parentPath
        ? (left.name < right.name ? -1 : 1)
        : (left.parentPath < right.parentPath ? -1 : 1)
    )
  ) {
    signal?.throwIfAborted()
    if (dirent.isDirectory()) continue
    const absolute = NodePath.join(dirent.parentPath, dirent.name)
    const path = NodePath.relative(root, absolute).split(NodePath.sep).join("/")
    if (privatePath(path)) continue
    if (dirent.isFile()) {
      const executable = ((await NodeFs.stat(absolute)).mode & 0o111) !== 0
      entries.set(path, {
        id: `file:${executable ? 755 : 644}:${await sha256(absolute, signal)}`,
        regular: true
      })
    } else {
      entries.set(path, {
        id: dirent.isSymbolicLink() ? `link:${await NodeFs.readlink(absolute)}` : "other",
        regular: false
      })
    }
  }
  return entries
}

/** Reads the trees exported at `roots` (revision → export directory) as a review source; `signal` stops it. */
export const exportedSource = (
  roots: Readonly<Record<string, string>>,
  signal?: AbortSignal
): TrustedReview.ReviewSource => {
  const trees = new Map<string, Promise<Map<string, TrustedReview.SourceEntry>>>()
  const tree = (revision: string) => {
    const root = roots[revision]
    if (root === undefined) return Promise.reject(new Error("The review read a revision it did not export"))
    let listed = trees.get(revision)
    if (listed === undefined) trees.set(revision, listed = listTree(root, signal))
    return listed
  }
  const bytes = async (revision: string, path: string, limit: number) => {
    signal?.throwIfAborted()
    const absolute = NodePath.join(roots[revision]!, ...path.split("/"))
    if ((await NodeFs.stat(absolute)).size > limit) throw new Error("A review file exceeds its size limit")
    return NodeFs.readFile(absolute)
  }
  return {
    tree,
    read: async (revision, path, _entry, limit) =>
      new TextDecoder("utf-8", { fatal: true }).decode(await bytes(revision, path, limit)),
    grep: async (revision, patterns, candidate) => {
      const expressions = patterns.map((pattern) => new RegExp(pattern))
      const matched: Array<string> = []
      for (const [path, entry] of await tree(revision)) {
        if (!entry.regular || !candidate(path)) continue
        // A file past the review limit cannot be a reviewed caller.
        const contents = await bytes(revision, path, LlmLint.maximumReviewFileBytes).catch(() => undefined)
        if (contents === undefined) continue
        // Binary files never match, as `git grep -I` skips them.
        if (contents.includes(0)) continue
        const text = new TextDecoder().decode(contents)
        if (expressions.some((expression) => expression.test(text))) matched.push(path)
      }
      return matched
    }
  }
}
