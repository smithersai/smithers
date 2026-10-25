import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Option, type Scope } from "effect"
import { PullsClient } from "./api"
import { SHA } from "./contract"
import type { FilesRow } from "./schema"

// Reading two commits' comparison into a tab (docs/features/pulls.md#the-browser): a pull request's Files tab and a
// branch's Compare (docs/features/branch-publish.md#the-branch-page) each keep their own rows, read the same way.

/**
 * Reads the files and commits `base` and `head` differ by into `rows` under `<base>...<head>`, once: a comparison of two
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
) =>
  Effect.gen(function* () {
    if (!SHA.test(base) || !SHA.test(head)) return
    const id = `${base}...${head}`
    const held = yield* rows.get(id)
    if (Option.isSome(held) && held.value.status !== "failed") return
    if (Option.isSome(held)) yield* rows.delete(id)
    yield* rows.insert({ id, status: "loading", files: [], truncated: false, commits: [], commitsTruncated: false })
    yield* (yield* PullsClient).compare(owner, name, base, head).pipe(
      Effect.flatMap((compared) =>
        rows.update(id, (row) => {
          row.status = "ready"
          row.files = [...compared.files]
          row.truncated = compared.truncated
          row.commits = [...compared.commits]
          row.commitsTruncated = compared.commitsTruncated
        })
      ),
      Effect.catch(() => rows.update(id, (row) => void (row.status = "failed"))),
      Effect.forkIn(scope),
    )
  }).pipe(Effect.orDie)
