/**
 * The identity of the review task the running host asks the reviewer to
 * perform, independently of target-repo copies and of the rest of the host
 * build. Plain TypeScript: it refuses by throwing, and the deployment bundler
 * (build.mjs) runs it at bundle time.
 */
import * as Digest from "@smthrs/core/Digest"
import { policySources } from "../wiki/reuse.vibe"

/** The most bytes one policy source may hold. */
export const maximumBytes = 2 * 1024 * 1024

/**
 * The identity of the review task: exactly the wiki review policy sources,
 * keyed by repository path. Nothing else in the host build is covered, so a
 * host deploy that leaves the review task alone keeps prior reviews reusable;
 * the reviewer seat and model are part of the reviewer identity beside it.
 *
 * @throws {Error} when a policy source is missing or exceeds 2 MiB
 */
export const wikiPolicyIdentity = (texts: ReadonlyMap<string, string>): string => {
  const captured = policySources.map((source) => {
    const text = texts.get(source)
    if (text === undefined) throw new Error(`Missing wiki review policy source ${source}`)
    if (new TextEncoder().encode(text).length > maximumBytes) {
      throw new Error("Coding reviewer policy source exceeds 2 MiB")
    }
    return { source, digest: Digest.digest(text) }
  })
  return `policy:${Digest.digest(Digest.canonical(captured))}`
}
