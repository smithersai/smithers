import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Option, type Scope } from "effect"
import { codeOf } from "../../errorCode"
import { PullsClient } from "./api"
import { RepoStore } from "../repo/store"
import { comparisonKey, SHA } from "./contract"
import type { FilesRow } from "./schema"

// Reading two commits' comparison into a tab (docs/features/pulls.md#the-browser): a pull request's Files tab and a
// branch's Compare (docs/features/branch-publish.md#the-branch-page) each keep their own rows, read the same way.

/**
 * Reads the files and commits `base` and `head` differ by into `rows` under `<repository>@<base>...<head>`, once: a comparison of two
 * SHAs never changes, so a row held is kept and only a failed one is read again. The read runs in `scope`; two refs
 * that aren't both SHAs read nothing.
 */
export const readComparison = (
  rows: Collection.Collection<FilesRow, string>,
  scope: Scope.Scope,
  owner: string,
  name: string,
  base: string,
  head: string,
  /** Told each comparison it reads, with its repository: what a refusal of that repository drops. */
  read?: (repository: string, id: string) => void,
) =>
  Effect.gen(function* () {
    if (!SHA.test(base) || !SHA.test(head)) return
    const repoId = `github/${owner}/${name}`.toLowerCase()
    const id = comparisonKey(repoId, base, head)
    const repos = yield* Effect.serviceOption(RepoStore)
    if (Option.isSome(repos) && repos.value.isRefused(repoId)) return
    const fence = Option.isSome(repos) ? repos.value.fenceOf(repoId) : 0
    const requestId = crypto.randomUUID()
    read?.(repoId, id)
    // Independent repository keys, and independent request identities after a wipe or retry.
    const held = yield* rows.get(id)
    if (Option.isSome(held) && held.value.status !== "failed" && held.value.repoId === repoId) return
    if (Option.isSome(held)) yield* rows.delete(id)
    yield* rows.insert({ id, repoId, requestId, status: "loading", files: [], truncated: false, commits: [], commitsTruncated: false })
    const current = (write: Effect.Effect<unknown>) => {
      const owned = Effect.flatMap(rows.get(id), (held) =>
        Option.isSome(held) && held.value.repoId === repoId && held.value.requestId === requestId
          ? Effect.asVoid(write) : Effect.void).pipe(Effect.orDie)
      return Option.isSome(repos) ? repos.value.fenced(repoId, fence, owned) : owned
    }
    yield* (yield* PullsClient).compare(owner, name, base, head).pipe(
      Effect.matchEffect({
        // A refusal that dropped the row meanwhile wins: the answer writes nothing back.
        onSuccess: (compared) => current(rows.update(id, (row) => {
            row.status = "ready"
            row.files = [...compared.files]
            row.truncated = compared.truncated
            row.commits = [...compared.commits]
            row.commitsTruncated = compared.commitsTruncated
          }).pipe(Effect.orDie)),
        // The comparison couldn't be read: the Files tab shows it failed, logged by its code and ChatApi's status.
        onFailure: (failure) =>
          Effect.andThen(
            Effect.logWarning("pulls.files.load").pipe(Effect.annotateLogs({
              feature: "pulls",
              outcome: "failed",
              errorCode: codeOf(failure),
              ...(failure.status === undefined ? {} : { status: failure.status }),
            })),
            current(rows.update(id, (row) => void (row.status = "failed")).pipe(Effect.orDie)),
          ),
      }),
      Effect.forkIn(scope),
    )
  }).pipe(Effect.orDie)
