// Repository Wiki model (plugins/wiki): pure, framework-free extraction of markdown notes, frontmatter,
// Obsidian-style `[[wikilinks]]`, backlinks, folders and search over `core/feeds` documents.

/** A feed document row as `core/feeds` delivers it. */
export interface FeedDocument {
  readonly id: string
  readonly repo: string
  readonly name: string
  readonly body: unknown
  readonly updatedAt: string
}

/** One wiki note with extracted links and backlinks. */
export interface WikiNote {
  readonly path: string
  readonly title: string
  readonly folder: string
  readonly markdown: string
  readonly tags: ReadonlyArray<string>
  readonly linksOut: ReadonlyArray<string>
  readonly backlinks: ReadonlyArray<string>
  readonly updatedAt: string
}

/** A folder group of notes for the sidebar tree. */
export interface WikiGroup {
  readonly folder: string
  readonly notes: ReadonlyArray<WikiNote>
}

interface RawNote {
  readonly path: string
  readonly title?: string | undefined
  readonly markdown: string
  readonly tags?: ReadonlyArray<string> | undefined
  readonly updatedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stemOf = (path: string): string => {
  const base = path.split("/").at(-1)!
  return base.replace(/\.md$/i, "")
}

const folderOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "Root" : path.slice(0, slash)
}

/** Extracts title and tags from optional YAML frontmatter and returns the body markdown. */
export const parseFrontmatter = (source: string): {
  readonly title?: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly body: string
} => {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { tags: [], body: source }
  }
  const end = source.indexOf("\n---", 3)
  if (end === -1) return { tags: [], body: source }
  const header = source.slice(4, end)
  const body = source.slice(end + 4).replace(/^\r?\n/, "")
  let title: string | undefined
  const tags: Array<string> = []
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("title:")) {
      const value = line.slice("title:".length).trim().replace(/^["']|["']$/g, "")
      if (value !== "") title = value
    } else if (line.startsWith("tags:")) {
      const value = line.slice("tags:".length).trim().replace(/^\[|\]$/g, "")
      for (const tag of value.split(",")) {
        const clean = tag.trim().replace(/^["']|["']$/g, "")
        if (clean !== "") tags.push(clean)
      }
    }
  }
  return { title, tags, body }
}

/** Extracts Obsidian `[[target]]` / `[[target|alias]]` / `[[target#heading]]` targets outside fenced code blocks. */
export const extractWikilinks = (markdown: string): ReadonlyArray<string> => {
  const targets: Array<string> = []
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) {
      const target = match[1]!.trim()
      if (target !== "" && !targets.includes(target)) targets.push(target)
    }
  }
  return targets
}

const normalizeNotePath = (rawPath: string): string => {
  const clean = rawPath.trim().replace(/^\/+/, "")
  return clean.endsWith(".md") ? clean : `${clean}.md`
}

/** Extracts raw notes from one feed document's body (either a `{ notes: [...] }` wiki index or a markdown document). */
const extractRawNotes = (doc: FeedDocument): ReadonlyArray<RawNote> => {
  if (typeof doc.body === "string" && doc.body.trim() !== "") {
    return [{ path: normalizeNotePath(doc.name), markdown: doc.body, updatedAt: doc.updatedAt }]
  }
  if (!isRecord(doc.body)) return []
  if (Array.isArray(doc.body.notes)) {
    const result: Array<RawNote> = []
    for (const item of doc.body.notes) {
      if (!isRecord(item)) continue
      const path = typeof item.path === "string" && item.path.trim() !== "" ? normalizeNotePath(item.path) : undefined
      const markdown = typeof item.markdown === "string"
        ? item.markdown
        : typeof item.content === "string"
        ? item.content
        : typeof item.body === "string"
        ? item.body
        : undefined
      if (path === undefined || markdown === undefined) continue
      const title = typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : undefined
      const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : undefined
      const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : doc.updatedAt
      result.push({ path, title, markdown, tags, updatedAt })
    }
    return result
  }
  const single = typeof doc.body.markdown === "string"
    ? doc.body.markdown
    : typeof doc.body.content === "string"
    ? doc.body.content
    : undefined
  if (single !== undefined) {
    const title = typeof doc.body.title === "string" && doc.body.title.trim() !== "" ? doc.body.title.trim() : undefined
    return [{ path: normalizeNotePath(doc.name), title, markdown: single, updatedAt: doc.updatedAt }]
  }
  return []
}

/** Starter notes shown when a repository has not yet pushed a `wiki` feed document. */
export const starterNotes = (repo: string): ReadonlyArray<RawNote> => [
  {
    path: "Overview.md",
    title: "Repository Wiki",
    markdown: [
      `# ${repo} Wiki`,
      "",
      "This knowledge base renders Markdown notes pushed to the repository's `wiki` feed with Obsidian-compatible `[[wikilinks]]`, heading outlines, and automatic backlinks.",
      "",
      "## Getting started",
      "- Publish a `wiki` feed document with `{ notes: [{ path, title, markdown }] }` via `POST /api/repos/<owner>/<name>/feeds`.",
      "- Link between notes using `[[Decisions]]` or `[[Architecture|System architecture]]`.",
      "- See [[Decisions]] and [[Architecture]] for how backlinks and outlines work.",
    ].join("\n"),
    tags: ["guide"],
    updatedAt: "",
  },
  {
    path: "Architecture.md",
    title: "Architecture",
    markdown: [
      "# Architecture",
      "",
      "Document subsystems, invariants, and boundaries here so both humans and agents share one source of truth.",
      "",
      "## Linked notes",
      "- Back to [[Overview]]",
      "- Track trade-offs in [[Decisions]]",
    ].join("\n"),
    tags: ["architecture"],
    updatedAt: "",
  },
  {
    path: "Decisions.md",
    title: "Decisions",
    markdown: [
      "# Decisions",
      "",
      "Record durable product and engineering decisions here. Every note that references `[[Decisions]]` automatically appears in the Backlinks panel.",
      "",
      "## Related",
      "- [[Overview]]",
    ].join("\n"),
    tags: ["decisions"],
    updatedAt: "",
  },
]

/** Resolves a wikilink target (`Decisions` or `guide/Decisions.md`) to a note path in `byKey`. */
const resolveTarget = (target: string, paths: ReadonlyArray<string>): string | undefined => {
  const lower = target.toLowerCase()
  const withExt = lower.endsWith(".md") ? lower : `${lower}.md`
  return paths.find((path) => path.toLowerCase() === withExt || path.toLowerCase() === lower) ??
    paths.find((path) => stemOf(path).toLowerCase() === lower)
}

/** Whether `documents` contain any repository-published wiki notes. */
export const hasWikiFeed = (documents: ReadonlyArray<FeedDocument>): boolean =>
  documents.some((doc) => extractRawNotes(doc).length > 0)

/** Builds the complete wiki note graph (linksOut + backlinks) from `documents`, falling back to starter notes if empty. */
export const wikiNotesOf = (repo: string, documents: ReadonlyArray<FeedDocument>): {
  readonly notes: ReadonlyArray<WikiNote>
  readonly fromFeed: boolean
} => {
  const rawFromFeed = documents.flatMap(extractRawNotes)
  const fromFeed = rawFromFeed.length > 0
  const raw = fromFeed ? rawFromFeed : starterNotes(repo)
  const deduped = new Map<string, RawNote>()
  for (const note of raw) deduped.set(note.path, note)
  const list = [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path))
  const allPaths = list.map((note) => note.path)

  const parsed = list.map((note) => {
    const fm = parseFrontmatter(note.markdown)
    const linksOut = extractWikilinks(fm.body)
      .map((target) => resolveTarget(target, allPaths))
      .filter((resolved): resolved is string => resolved !== undefined && resolved !== note.path)
    const uniqueOut = [...new Set(linksOut)]
    const mergedTags = [...new Set([...(note.tags ?? []), ...fm.tags])]
    return {
      path: note.path,
      title: note.title ?? fm.title ?? stemOf(note.path),
      folder: folderOf(note.path),
      markdown: fm.body,
      tags: mergedTags,
      linksOut: uniqueOut,
      updatedAt: note.updatedAt,
    }
  })

  const incoming = new Map<string, Array<string>>()
  for (const note of parsed) {
    for (const target of note.linksOut) {
      const listForTarget = incoming.get(target) ?? []
      listForTarget.push(note.path)
      incoming.set(target, listForTarget)
    }
  }

  return {
    fromFeed,
    notes: parsed.map((note) => ({
      ...note,
      backlinks: incoming.get(note.path) ?? [],
    })),
  }
}

/** Filters `notes` by `query` across title, path, tags, and markdown body. */
export const filterNotes = (notes: ReadonlyArray<WikiNote>, query: string): ReadonlyArray<WikiNote> => {
  const needle = query.trim().toLowerCase()
  if (needle === "") return notes
  return notes.filter((note) =>
    note.title.toLowerCase().includes(needle) ||
    note.path.toLowerCase().includes(needle) ||
    note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
    note.markdown.toLowerCase().includes(needle)
  )
}

/** Groups `notes` by folder in alphabetical order (`Root` first). */
export const groupNotes = (notes: ReadonlyArray<WikiNote>): ReadonlyArray<WikiGroup> => {
  const groups = new Map<string, Array<WikiNote>>()
  for (const note of notes) {
    const list = groups.get(note.folder) ?? []
    list.push(note)
    groups.set(note.folder, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Root" ? -1 : b === "Root" ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, notes: items }))
}

/** Clamps a cursor index inside `total` notes. */
export const clampIndex = (index: number, total: number): number =>
  total <= 0 ? 0 : Math.max(0, Math.min(index, total - 1))
