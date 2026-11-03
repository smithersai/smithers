import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { RELATIONS_STALE_MS, RELATIONS_STREAM, TREE_SCOPE_MAX_REPOSITORIES, TREE_SCOPE_SEGMENT, ISSUES_SEGMENT, type TreeScope } from "../../src/features/issues/contract.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"

// A tree's scope (decision 0153 rule 9, docs/features/issues.md#the-tree): the connected components of the authorized
// relation graph that contain an issue of the tree's repository. Which repositories may be read is decided first, from
// the deployment and the reader alone (`candidates`, then worker/github/Access.ts), and never from a relation row. Only
// then does one traversal follow edges whose two ends are readable, so `public A -> private B -> public C` gives C nothing
// through B, and a change among hidden relations changes no read, no call and no answer.

/** `GET /api/repos/<owner>/<name>/issues/tree-scope` as its owner and name, or `undefined` for any other path. */
export const parseTreeScopePath = (path: string): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 4 || segments[2] !== ISSUES_SEGMENT || segments[3] !== TREE_SCOPE_SEGMENT) return undefined
  try {
    const owner = decodeURIComponent(segments[0]!)
    const name = decodeURIComponent(segments[1]!)
    return isRepository(owner, name) ? { owner, name } : undefined
  } catch {
    return undefined
  }
}

/**
 * The repositories a tree of `owner`'s could reach: those the deployment has recorded, and the `allowed` list's. GitHub
 * keeps a sub-issue under its parent's owner, so another owner's can't be reached, and asking about them would only cost
 * a role read each. A repository nobody has opened on this deployment isn't a candidate until someone does.
 */
export const candidates = (owner: string, allowed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly repoId: string }>`
      SELECT repo_id AS "repoId" FROM github_repositories WHERE split_part(repo_id, '/', 2) = ${owner.toLowerCase()}`
    const listed = allowed.filter((id) => id.split("/")[1] === owner.toLowerCase())
    return [...new Set([...rows.map((row) => row.repoId), ...listed])].sort()
  })

/**
 * Which readable repositories each edge joins, within the components that hold an issue of `repoId`. `UNION` is the
 * visited set, so a cycle in stale rows ends; there is no hop limit, since leaves of an eight-level tree are up to 14
 * edges apart. The work is bounded by the issues of repositories the reader may read.
 */
export const reachedPairs = (repoId: string, readable: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ readonly child: string; readonly parent: string }>`
      WITH RECURSIVE reach(id) AS (
        SELECT child_id FROM issue_relations WHERE child_repo_id = ${repoId} AND parent_repo_id = ANY(${readable}::text[])
        UNION
        SELECT parent_id FROM issue_relations WHERE parent_repo_id = ${repoId} AND child_repo_id = ANY(${readable}::text[])
        UNION
        SELECT n.id FROM reach
        JOIN issue_relations e ON e.child_id = reach.id OR e.parent_id = reach.id
        CROSS JOIN LATERAL (VALUES (e.child_id), (e.parent_id)) AS n(id)
        WHERE e.child_repo_id = ANY(${readable}::text[]) AND e.parent_repo_id = ANY(${readable}::text[])
      )
      SELECT DISTINCT e.child_repo_id AS child, e.parent_repo_id AS parent FROM issue_relations e
      WHERE e.child_id IN (SELECT id FROM reach)
        AND e.child_repo_id = ANY(${readable}::text[]) AND e.parent_repo_id = ANY(${readable}::text[])`
  })

/** The repositories from `repoId` outward over `pairs`: nearest first, then by id, the tree's own always first. */
export const byDistance = (repoId: string, pairs: ReadonlyArray<{ readonly child: string; readonly parent: string }>) => {
  const neighbours = new Map<string, Set<string>>()
  const link = (from: string, to: string) => void (neighbours.get(from) ?? neighbours.set(from, new Set()).get(from)!).add(to)
  for (const { child, parent } of pairs) {
    link(child, parent)
    link(parent, child)
  }
  const ordered = [repoId]
  const seen = new Set(ordered)
  let ring = [repoId]
  while (ring.length > 0) {
    const next = [...new Set(ring.flatMap((id) => [...(neighbours.get(id) ?? [])]))].filter((id) => !seen.has(id)).sort()
    for (const id of next) seen.add(id)
    ordered.push(...next)
    ring = next
  }
  return ordered
}

/** `owner/name` of a repository id, `github/<owner>/<name>`. */
export const nameOf = (id: string) => id.replace(/^github\//, "")

/** The repositories of `ids` whose relations walk is complete and current. */
export const currentRelations = (ids: ReadonlyArray<string>, nowMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly repoId: string }>`
      SELECT repo_id AS "repoId" FROM github_sync
      WHERE repo_id = ANY(${ids}::text[]) AND stream = ${RELATIONS_STREAM} AND complete
        AND synced_at > ${new Date(nowMs - RELATIONS_STALE_MS).toISOString()}::timestamptz`
    return new Set(rows.map((row) => row.repoId))
  })

/** The answer: the first `TREE_SCOPE_MAX_REPOSITORIES` of `ordered` with whether each is `synced`, and the rest named. */
export const answer = (ordered: ReadonlyArray<string>, synced: ReadonlySet<string>): TreeScope => ({
  repos: ordered.slice(0, TREE_SCOPE_MAX_REPOSITORIES).map((id) => ({ repo: nameOf(id), synced: synced.has(id) })),
  truncated: ordered.length > TREE_SCOPE_MAX_REPOSITORIES,
  omitted: ordered.slice(TREE_SCOPE_MAX_REPOSITORIES).map(nameOf),
})
