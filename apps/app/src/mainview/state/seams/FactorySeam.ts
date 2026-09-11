/*
 * The factory seam: factory.show, how a repository builds itself (Factory
 * design session 2026-09-07 §4 and §5, mock 3). The card has two sections
 * and every fact in it comes from a seam that exists today or states its
 * honest absence:
 *
 *  - Wiki. No catalog repository has a generated wiki yet, so `generated` is
 *    null and the card says so. The notes count is the Wiki documents the
 *    store holds. The Librarian answers on the Worker but keeps no
 *    answers/misses log, so `librarian` is null.
 *  - Infra. The box's infra-as-code files (`.smithers/WORKSPACE.ts`,
 *    `flake.nix`, `PACKAGE.ts`, plus a root `WORKSPACE.ts` when the tree has
 *    one) as read through the public contents seam (GET
 *    /api/repos/{owner}/{repo}/contents[/path], the same route FilesSeam
 *    reads). Two directory listings settle every row: the root, and
 *    `.smithers`. A file the tree lacks is listed as absent; a listing the
 *    backend refused marks its rows unreadable with the backend's reason.
 *
 * The card's Open buttons run files.read for the row's path, so the file
 * body is read by the one flow that already reads files.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface FactorySeam {
  readonly showFactory: (repo?: string) => Promise<string | void | { readonly value: string }>
}

type FactoryPayload = Extract<Card, { kind: "factory" }>["payload"]
export type InfraRow = FactoryPayload["infra"][number]

/** The infra-as-code files the design names, in the mock's order; the root WORKSPACE.ts joins only when present. */
export const INFRA_FILES: ReadonlyArray<string> = [".smithers/WORKSPACE.ts", "flake.nix", "PACKAGE.ts"]

type Listing =
  | { readonly names: ReadonlySet<string> }
  | { readonly absent: true }
  | { readonly error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The names in one directory answer ({name?, path?, type} rows, the FilesSeam wire shape); malformed rows drop. */
const namesOf = (body: unknown): ReadonlySet<string> => {
  const names = new Set<string>()
  if (!Array.isArray(body)) return names
  for (const row of body) {
    if (!isRecord(row)) continue
    if (typeof row.name === "string" && row.name !== "") names.add(row.name)
    else if (typeof row.path === "string" && row.path !== "") names.add(row.path.split("/").filter(Boolean).pop() ?? "")
  }
  return names
}

/** The model's copy of the card: the same facts, one line. */
export const factoryValue = (payload: FactoryPayload): string => {
  const wiki = payload.wiki.generated === null
    ? "no generated wiki yet"
    : `${payload.wiki.generated.pages} generated pages, fresh at ${payload.wiki.generated.sha}`
  const notes = `${payload.wiki.notes} note${payload.wiki.notes === 1 ? "" : "s"}`
  const librarian = payload.wiki.librarian === null
    ? "no Librarian answers recorded"
    : `Librarian ${payload.wiki.librarian.answers} answers, ${payload.wiki.librarian.misses} misses`
  const infra = payload.infra
    .map((row) => `${row.path} ${row.state === "unreadable" ? `unreadable (${row.reason ?? "no reason given"})` : row.state}`)
    .join(", ")
  return `Factory for ${payload.repo}: ${wiki}; ${notes}; ${librarian}. Infra files: ${infra}.`
}

export const createFactorySeam = (ctx: SeamContext): FactorySeam => {
  const contentsUrl = (repo: string, path: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    return path === "" ? base : `${base}/${path.split("/").map(encodeURIComponent).join("/")}`
  }

  const listDirectory = async (repo: string, path: string): Promise<Listing> => {
    const label = path === "" ? "the repository root" : path
    let response: Response
    try {
      response = await ctx.http(contentsUrl(repo, path))
    } catch (error) {
      return { error: `Could not reach the backend to list ${label} in ${repo}: ${errorText(error)}` }
    }
    if (response.status === 404) return { absent: true }
    if (!response.ok) return { error: await readErrorMessage(response, `Listing ${label} in ${repo} failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return { error: `${label} in ${repo} did not answer as a directory.` }
    return { names: namesOf(body) }
  }

  /**
   * One row per declared file: present in its directory listing, absent from
   * it, or unreadable when the listing was. A 404 says "absent" only once the
   * root listing proved the tree exists; a tree that was never read cannot
   * vouch for a missing file, so its rows carry the root's failure instead.
   */
  const infraRows = (root: Listing, smithers: Listing): ReadonlyArray<InfraRow> => {
    const rowFor = (path: string, listing: Listing, name: string): InfraRow => {
      if ("error" in listing) return { path, state: "unreadable", reason: listing.error }
      if ("absent" in listing) return { path, state: "absent" }
      return { path, state: listing.names.has(name) ? "present" : "absent" }
    }
    /*
     * A missing repository root is not a missing file: the tree itself could
     * not be read, so every root row says so instead of claiming absence.
     */
    const rootListing: Listing = "absent" in root
      ? { error: "The repository tree could not be found on Smithers Cloud." }
      : root
    /*
     * `.smithers` not found means "no such directory" only when the root was
     * listed. When the root failed, that 404 is the same unread tree, so the
     * row inherits the root's reason. A `.smithers` listing that was read, or
     * that failed with its own reason, stands on its own.
     */
    const smithersListing: Listing = "absent" in smithers && "error" in rootListing ? rootListing : smithers
    const rows = INFRA_FILES.map((path) =>
      path.startsWith(".smithers/")
        ? rowFor(path, smithersListing, path.slice(".smithers/".length))
        : rowFor(path, rootListing, path)
    )
    const rootWorkspace = "names" in rootListing && rootListing.names.has("WORKSPACE.ts")
      ? [{ path: "WORKSPACE.ts", state: "present" as const }]
      : []
    return [...rows, ...rootWorkspace]
  }

  const showFactory = async (repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const { repo } = target
    const [root, smithers] = await Promise.all([listDirectory(repo, ""), listDirectory(repo, ".smithers")])
    const payload: FactoryPayload = {
      repo,
      wiki: {
        generated: null,
        notes: ctx.store.collections.worldDocuments.size,
        librarian: null
      },
      infra: [...infraRows(root, smithers)]
    }
    const cardId = `factory-${repo}`
    const existing = ctx.store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "factory",
      title: `Factory · ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return { value: factoryValue(payload) }
  }

  return { showFactory }
}
