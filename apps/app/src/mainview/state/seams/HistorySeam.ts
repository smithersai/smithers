import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The history seam: the mythical history of a repository (Factory design
 * session 2026-09-07 §3, mock 13), read through the Worker's public read seam
 * to the Smithers Cloud mirror. Probed 2026-09-07 on smithersai/smithers:
 *
 *   GET /api/repos/{o}/{r}                    200, carries default_bookmark
 *   GET /api/repos/{o}/{r}/git/refs           200, refs/heads/* only
 *   GET /api/repos/{o}/{r}/changes?limit=100  200, newest first, 100 per page,
 *                                             parent_change_ids in git parent order
 *   GET /api/repos/{o}/{r}/contents/{p}?ref=  200 for a bookmark name or a commit sha
 *   GET /api/repos/{o}/{r}/git/commits/{sha}  no such route (the 501 stub was removed 2026-09-24)
 *   GET /api/repos/{o}/{r}/git/trees/{sha}    no such route (the 501 stub was removed 2026-09-24)
 *   GET /api/repos/{o}/{r}/git/blobs/{sha}    no such route on the mirror
 *
 * So the commit graph comes from the change feed (the walk the activity route
 * already does), notes come from /contents against the notes commit (a
 * directory path lists the tree, a file path carries the blob), and the
 * tree-equality badge is a typed "unsupported" until /git/commits answers.
 * Nothing here invents a row or presents a partial read as the whole: a
 * history whose chains the feed did not reach is the typed unsupported state,
 * notes are read for exactly the commits the notes tree names (never a capped
 * prefix), and a notes tree the mirror would not list is `notes: "unread"`
 * rather than forty nulls that look like absence. The mirror exposes no commit
 * count, so `mainCommits` is null and the empty state never estimates one from
 * a capped change-feed page (design session ruling 2026-09-07, spec 03 §6):
 * the honest empty state is one sentence with one door.
 */
import type { HistoryEpic, HistoryNote } from "@smthrs/rpc/Cards"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"

export const MYTHICAL_REF = "refs/heads/mythical"
export const MYTHICAL_NOTES_REF = "refs/notes/mythical"

/** The mirror's page ceiling for the change feed. */
const PAGE_SIZE = 100
/** Bounds the change-feed walk, the same bound the activity route uses; a walk that outruns it is the typed unsupported state, never a partial history. */
export const MAX_CHANGE_PAGES = 20
/** Bounds the notes tree listing: git fans notes out two hex characters per directory, so 40 hex is at most 20 levels. */
const MAX_NOTES_TREE_DEPTH = 20
/** Maximum outstanding notes directory listings. */
export const NOTES_TREE_CONCURRENCY = 8
/** Bounds one epic's second-parent chain, so a malformed history cannot spin. */
const MAX_EPIC_COMMITS = 500

export type HistoryPayload = Extract<Card, { kind: "history" }>["payload"]
type Mythical = HistoryPayload["mythical"]

export interface HistorySeam {
  readonly showHistory: ViewAction<[repo?: string]>
  /** Bootstrap delegates to the run host; amend/fold remain unsupported. */
  readonly retellHistory: (door: "bootstrap" | "amend" | "fold", repo?: string) => Promise<string | void>
}

/**
 * The empty state's one sentence. The clause "main has N commits." renders
 * only when a seam actually exposes a commit count; with none the sentence
 * stops after the first clause and never estimates from a capped read.
 */
export const emptyHistorySentence = (bookmark: string | null, mainCommits: number | null): string => {
  if (mainCommits === null) return "No mythical history yet."
  const name = bookmark ?? "the default bookmark"
  return `No mythical history yet. ${name} has ${mainCommits} commit${mainCommits === 1 ? "" : "s"}.`
}

/** The badge line: the invariant tree(mythical) == tree(main), or why it cannot be checked. */
export const treeEqualLabel = (
  mythical: Extract<Mythical, { state: "present" }>,
  bookmark: string | null
): string => {
  const name = bookmark ?? "the default bookmark"
  const at = mythical.mainHead === null ? "" : ` @ ${mythical.mainHead.slice(0, 7)}`
  if (mythical.treeEqual === "equal") return `tree-equal to ${name}${at}`
  if (mythical.treeEqual === "different") return `tree differs from ${name}${at}`
  return "tree-equal: not available (the mirror does not serve git commits yet)"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/* ---- the change graph ---- */

interface ChangeRow {
  readonly changeId: string
  readonly commitId: string
  readonly title: string
  /** Parent change ids in git parent order (verified against git rev-list --parents on the live mirror). */
  readonly parents: ReadonlyArray<string>
}

const parseChange = (value: unknown): ChangeRow | null => {
  if (!isRecord(value) || typeof value.change_id !== "string" || typeof value.commit_id !== "string") return null
  const description = typeof value.description === "string" ? value.description : ""
  const parents = Array.isArray(value.parent_change_ids)
    ? value.parent_change_ids.filter((id): id is string => typeof id === "string")
    : []
  return { changeId: value.change_id, commitId: value.commit_id, title: description.split("\n")[0] ?? "", parents }
}

export class ChangeGraph {
  readonly byChange = new Map<string, ChangeRow>()
  readonly byCommit = new Map<string, ChangeRow>()

  add(row: ChangeRow): void {
    this.byChange.set(row.changeId, row)
    this.byCommit.set(row.commitId, row)
  }

  /** The first-parent line from a commit to the root, or null while a link is unresolved. */
  firstParentLine(commitId: string): ReadonlyArray<ChangeRow> | null {
    const out: Array<ChangeRow> = []
    let row = this.byCommit.get(commitId)
    const seen = new Set<string>()
    while (row !== undefined) {
      if (seen.has(row.changeId)) return out
      seen.add(row.changeId)
      out.push(row)
      const first = row.parents[0]
      if (first === undefined) return out
      row = this.byChange.get(first)
      if (row === undefined) return null
    }
    return null
  }

  /**
   * An epic's atomic commits: the second parent's first-parent chain down to
   * (not including) a commit on the epic's own first-parent line. Null while
   * a link is unresolved.
   */
  secondParentChain(merge: ChangeRow, line: ReadonlySet<string>): ReadonlyArray<ChangeRow> | null {
    const second = merge.parents[1]
    if (second === undefined) return []
    const out: Array<ChangeRow> = []
    let row = this.byChange.get(second)
    while (out.length < MAX_EPIC_COMMITS) {
      if (row === undefined) return null
      if (line.has(row.changeId)) return out
      out.push(row)
      const first = row.parents[0]
      if (first === undefined) return out
      row = this.byChange.get(first)
    }
    return out
  }
}

/* ---- the mirror reads ---- */

const repoBase = (ctx: SeamContext, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** One mirror document as JSON, or null with the status when the mirror could not answer it. */
const readJson = async (ctx: SeamContext, url: string): Promise<{ status: number; body: unknown }> => {
  try {
    const response = await ctx.http(url)
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch {
    return { status: 0, body: undefined }
  }
}

interface Refs {
  readonly heads: ReadonlyMap<string, string>
  readonly notes: string | null
}

const readRefs = async (ctx: SeamContext, base: string): Promise<Refs | null> => {
  const answer = await readJson(ctx, `${base}/git/refs`)
  if (answer.status !== 200 || !Array.isArray(answer.body)) return null
  const heads = new Map<string, string>()
  let notes: string | null = null
  for (const ref of answer.body) {
    if (!isRecord(ref) || typeof ref.ref !== "string" || !isRecord(ref.object) || typeof ref.object.sha !== "string") continue
    if (ref.ref === MYTHICAL_NOTES_REF) notes = ref.object.sha
    else if (ref.ref.startsWith("refs/heads/")) heads.set(ref.ref.slice("refs/heads/".length), ref.object.sha)
  }
  return { heads, notes }
}

const readDefaultBookmark = async (ctx: SeamContext, base: string): Promise<string | null> => {
  const answer = await readJson(ctx, base)
  if (answer.status !== 200 || !isRecord(answer.body)) return null
  const bookmark = answer.body.default_bookmark
  return typeof bookmark === "string" && bookmark !== "" ? bookmark : null
}

/**
 * Reads change-feed pages, newest first, until `settled` is true, the feed
 * ends, or the page bound trips. The feed lists children before parents, so
 * every walk resolves a page at a time; the caller re-asks the graph what it
 * reached, so a walk the bound stopped shows as unresolved links, never as a
 * partial answer.
 */
export const loadChanges = async (
  ctx: SeamContext,
  base: string,
  settled: (graph: ChangeGraph) => boolean,
  maxPages: number = MAX_CHANGE_PAGES
): Promise<ChangeGraph> => {
  const graph = new ChangeGraph()
  let cursor = ""
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor !== "") query.set("cursor", cursor)
    const answer = await readJson(ctx, `${base}/changes?${query.toString()}`)
    if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.items)) {
      return graph
    }
    for (const item of answer.body.items) {
      const row = parseChange(item)
      if (row !== null) graph.add(row)
    }
    if (settled(graph)) return graph
    const next = answer.body.next_cursor
    if (typeof next !== "string" || next === "" || next === cursor || answer.body.items.length === 0) {
      return graph
    }
    cursor = next
  }
  return graph
}

/** The commit's tree sha off GET /git/commits/{sha}, or null when the mirror does not answer it (no such route today). */
const readTreeSha = async (ctx: SeamContext, base: string, sha: string): Promise<string | null> => {
  const answer = await readJson(ctx, `${base}/git/commits/${encodeURIComponent(sha)}`)
  if (answer.status !== 200 || !isRecord(answer.body)) return null
  const tree = answer.body.tree
  return isRecord(tree) && typeof tree.sha === "string" && tree.sha !== "" ? tree.sha : null
}

/* ---- notes ---- */

const SECTION_NAMES = ["tried", "evidence", "folded", "superseded"] as const

/**
 * A note body: markdown with optional frontmatter and the four sections as
 * headings (any level, any case). A heading the note lacks is null; text
 * before the first heading belongs to no section.
 */
export const parseNote = (markdown: string): HistoryNote => {
  let text = markdown.replace(/\r\n/g, "\n")
  const frontmatter = /^---\n[\s\S]*?\n---\n?/.exec(text)
  if (frontmatter !== null) text = text.slice(frontmatter[0].length)
  const sections: Record<(typeof SECTION_NAMES)[number], string | null> = { tried: null, evidence: null, folded: null, superseded: null }
  let current: (typeof SECTION_NAMES)[number] | null = null
  const buffers = new Map<string, Array<string>>()
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+([A-Za-z]+)\s*$/.exec(line)
    if (heading !== null) {
      const name = heading[1]!.toLowerCase()
      current = (SECTION_NAMES as ReadonlyArray<string>).includes(name) ? (name as (typeof SECTION_NAMES)[number]) : null
      if (current !== null && !buffers.has(current)) buffers.set(current, [])
      continue
    }
    if (current !== null) buffers.get(current)!.push(line)
  }
  for (const name of SECTION_NAMES) {
    const lines = buffers.get(name)
    if (lines !== undefined) sections[name] = lines.join("\n").trim()
  }
  return sections
}

const decodeContent = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.content !== "string") return null
  if (body.encoding === "base64") {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (char) => char.charCodeAt(0)))
    } catch {
      return null
    }
  }
  return body.content
}

const HEX = /^[0-9a-f]+$/

/**
 * The commits the notes commit's tree names, each with the path its note
 * lives at: git stores a note at `<sha>` or fans it out as `<2>/<38>` (and
 * deeper, two characters per directory). The tree is listed through
 * /contents/<dir>?ref=<notes sha>, with bounded concurrent listings. Null when the
 * mirror would not list a directory, so the caller can say the notes were not
 * read instead of rendering absence.
 */
export const listNotedCommits = async (ctx: SeamContext, base: string, notesSha: string): Promise<ReadonlyMap<string, string> | null> => {
  const noted = new Map<string, string>()
  const queue = [{ dir: "", prefix: "", depth: 0 }]
  const active = new Set<Promise<void>>()
  let next = 0
  let failed = false
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const answer = await readJson(ctx, `${base}/contents/${dir}?ref=${encodeURIComponent(notesSha)}`)
    if (answer.status !== 200 || !Array.isArray(answer.body)) {
      failed = true
      return
    }
    for (const entry of answer.body) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.type !== "string") continue
      const name = entry.name.toLowerCase()
      if (!HEX.test(name)) continue
      const sha = prefix + name
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`
      if (entry.type === "file" && sha.length === 40) noted.set(sha, path)
      else if (entry.type === "dir" && sha.length < 40 && depth < MAX_NOTES_TREE_DEPTH) {
        queue.push({ dir: path, prefix: sha, depth: depth + 1 })
      }
    }
  }
  while (!failed && (next < queue.length || active.size > 0)) {
    while (next < queue.length && active.size < NOTES_TREE_CONCURRENCY) {
      const { dir, prefix, depth } = queue[next++]!
      const request = walk(dir, prefix, depth).finally(() => active.delete(request))
      active.add(request)
    }
    await Promise.race(active)
  }
  // Settle already-started reads before returning an unread tree.
  await Promise.all(active)
  return failed ? null : noted
}

/** The note at one path of the notes commit's tree, read through /contents; null when the mirror did not answer the blob. */
const readNoteAt = async (ctx: SeamContext, base: string, notesSha: string, path: string): Promise<HistoryNote | null> => {
  const answer = await readJson(ctx, `${base}/contents/${path}?ref=${encodeURIComponent(notesSha)}`)
  if (answer.status !== 200) return null
  const content = decodeContent(answer.body)
  return content === null ? null : parseNote(content)
}

/**
 * The notes for the commits of the history: exactly the notes the tree names
 * for those commits, or `unread` when the tree or one of those notes could not
 * be read. A note the tree does not name is null, and only then.
 */
export const readNotes = async (
  ctx: SeamContext,
  base: string,
  notesSha: string,
  shas: ReadonlyArray<string>
): Promise<{ readonly state: "read"; readonly notes: ReadonlyMap<string, HistoryNote> } | { readonly state: "unread" }> => {
  const noted = await listNotedCommits(ctx, base, notesSha)
  if (noted === null) return { state: "unread" }
  const wanted = shas.filter((sha) => noted.has(sha.toLowerCase()))
  const read = await Promise.all(wanted.map(async (sha) => [sha, await readNoteAt(ctx, base, notesSha, noted.get(sha.toLowerCase())!)] as const))
  const notes = new Map<string, HistoryNote>()
  for (const [sha, note] of read) {
    if (note === null) return { state: "unread" }
    notes.set(sha, note)
  }
  return { state: "read", notes }
}

/* ---- the read ---- */

const unsupported = (reason: string): Mythical => ({ state: "unsupported", reason })

export const readHistory = async (ctx: SeamContext, repo: string): Promise<HistoryPayload | { readonly error: string }> => {
  const base = repoBase(ctx, repo)
  const [refs, defaultBookmark] = await Promise.all([readRefs(ctx, base), readDefaultBookmark(ctx, base)])
  if (refs === null) return { error: `The history of ${repo} couldn't be read: the mirror did not list its refs.` }
  const mainHead = defaultBookmark === null ? null : refs.heads.get(defaultBookmark) ?? null
  const mythicalHead = refs.heads.get("mythical") ?? null

  /* No bookmark: one sentence and one door. The mirror exposes no commit count and the change feed is never read to estimate one. */
  if (mythicalHead === null) return { repo, defaultBookmark, mainCommits: null, mythical: { state: "absent" } }

  const settled = (graph: ChangeGraph): boolean => {
    const line = graph.firstParentLine(mythicalHead)
    if (line === null) return false
    const lineIds = new Set(line.map((row) => row.changeId))
    return !line.some((row) => row.parents.length > 1 && graph.secondParentChain(row, lineIds) === null)
  }
  const graph = await loadChanges(ctx, base, settled)
  const line = graph.firstParentLine(mythicalHead)
  if (line === null) {
    return {
      repo,
      defaultBookmark,
      mainCommits: null,
      mythical: unsupported(`The mirror's change feed did not reach every commit of mythical within ${MAX_CHANGE_PAGES} pages.`)
    }
  }
  const lineIds = new Set(line.map((row) => row.changeId))
  const epicsRaw: Array<{ readonly row: ChangeRow; readonly chain: ReadonlyArray<ChangeRow> }> = []
  for (const row of line) {
    const chain = row.parents.length > 1 ? graph.secondParentChain(row, lineIds) : []
    if (chain === null) {
      /* The first-parent line resolved but this epic's atomic commits did not: the same honest state, never an epic with zero commits. */
      return {
        repo,
        defaultBookmark,
        mainCommits: null,
        mythical: unsupported(
          `The mirror's change feed did not reach every atomic commit of epic ${row.commitId.slice(0, 7)} within ${MAX_CHANGE_PAGES} pages.`
        )
      }
    }
    epicsRaw.push({ row, chain })
  }
  const shas = epicsRaw.flatMap(({ row, chain }) => [row.commitId, ...chain.map((commit) => commit.commitId)])

  const [mythicalTree, mainTree] = await Promise.all([
    readTreeSha(ctx, base, mythicalHead),
    mainHead === null ? Promise.resolve(null) : readTreeSha(ctx, base, mainHead)
  ])
  const treeEqual = mythicalTree === null || mainTree === null ? "unsupported" : mythicalTree === mainTree ? "equal" : "different"

  const notesRead = refs.notes === null ? { state: "absent" as const } : await readNotes(ctx, base, refs.notes, shas)
  const noteFor: ReadonlyMap<string, HistoryNote> = notesRead.state === "read" ? notesRead.notes : new Map()
  const epics: Array<HistoryEpic> = epicsRaw.map(({ row, chain }) => ({
    sha: row.commitId,
    title: row.title,
    merge: row.parents.length > 1,
    note: noteFor.get(row.commitId) ?? null,
    commits: chain.map((commit) => ({ sha: commit.commitId, title: commit.title, note: noteFor.get(commit.commitId) ?? null }))
  }))
  return {
    repo,
    defaultBookmark,
    mainCommits: null,
    mythical: {
      state: "present",
      head: mythicalHead,
      mainHead,
      treeEqual,
      commitCount: shas.length,
      notes: notesRead.state,
      epics
    }
  }
}

export const createHistorySeam = (
  ctx: SeamContext,
  bootstrap?: (repo: string) => Promise<string | void>
): HistorySeam => {
  /* One history card per repository, re-surfaced at the end of the transcript on every show. */
  const showHistory = preparedView(ctx, (repoArg?: string) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    return { id: `history-${target.repo}`, title: `Mythical history · ${target.repo}`, read: async () => {
    const payload = await readHistory(ctx, target.repo)
    if ("error" in payload) return payload.error
    const card: Card = {
      id: `history-${target.repo}`,
      kind: "history",
      title: `Mythical history · ${target.repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    return { card }
    } }
  })

  // Generation is delegated to the durable run host, never performed by a read seam.
  const retellHistory = async (door: "bootstrap" | "amend" | "fold", repoArg?: string): Promise<string | void> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    if (door === "bootstrap") return bootstrap?.(target.repo) ?? "Create Mythical history is unavailable on this host."
    const payload = await readHistory(ctx, target.repo)
    if ("error" in payload) return payload.error
    if (payload.mythical.state === "absent") return emptyHistorySentence(payload.defaultBookmark, payload.mainCommits)
    return `The mythical history of ${target.repo} cannot be rewritten from here yet: this host does not support amend or fold.`
  }

  return { showHistory, retellHistory }
}
