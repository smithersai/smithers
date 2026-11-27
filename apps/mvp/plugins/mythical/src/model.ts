// Pure, framework-free Mythical History view-model over repository `core/feeds` documents.

export interface FeedDocument {
  readonly id: string
  readonly repo: string
  readonly name: string
  readonly body: unknown
  readonly updatedAt: string
}

export interface MythicalNote {
  readonly kind: "decision" | "evidence" | "abandoned" | "folded"
  readonly summary: string
  readonly ref?: string | undefined
}

export interface MythicalCommit {
  readonly position: number
  readonly epic: string
  readonly title: string
  readonly summary: string
  readonly commitSha: string | null
  readonly mainFoldedSha: string | null
  readonly treeEqualToMain: boolean
  readonly prNumber: number | null
  readonly authorLogin: string
  readonly notes: ReadonlyArray<MythicalNote>
}

export interface EpicGroup {
  readonly epic: string
  readonly commits: ReadonlyArray<MythicalCommit>
}

export interface ExtractedMythical {
  readonly hasFeed: boolean
  readonly commits: ReadonlyArray<MythicalCommit>
  readonly epics: ReadonlyArray<EpicGroup>
  readonly treeEqualToMain: boolean
  readonly updatedAt: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const parseNote = (raw: unknown): MythicalNote | undefined => {
  if (!isRecord(raw)) return undefined
  const kind = raw.kind
  const summary = raw.summary
  if (
    (kind !== "decision" && kind !== "evidence" && kind !== "abandoned" && kind !== "folded")
    || typeof summary !== "string"
    || summary.trim() === ""
  ) {
    return undefined
  }
  const ref = typeof raw.ref === "string" && raw.ref.trim() !== "" ? raw.ref.trim() : undefined
  return ref === undefined ? { kind, summary: summary.trim() } : { kind, summary: summary.trim(), ref }
}

const parseCommit = (raw: unknown, fallbackPos: number): MythicalCommit | undefined => {
  if (!isRecord(raw)) return undefined
  const title = typeof raw.title === "string" ? raw.title.trim() : ""
  if (title === "") return undefined
  const position = typeof raw.position === "number" && Number.isFinite(raw.position) ? Math.floor(raw.position) : fallbackPos
  const epic = typeof raw.epic === "string" && raw.epic.trim() !== "" ? raw.epic.trim() : "core"
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : ""
  const commitSha = typeof raw.commitSha === "string" && raw.commitSha.trim() !== "" ? raw.commitSha.trim() : null
  const mainFoldedSha = typeof raw.mainFoldedSha === "string" && raw.mainFoldedSha.trim() !== "" ? raw.mainFoldedSha.trim() : null
  const prNumber = typeof raw.prNumber === "number" && Number.isFinite(raw.prNumber) ? Math.floor(raw.prNumber) : null
  const authorLogin = typeof raw.authorLogin === "string" && raw.authorLogin.trim() !== "" ? raw.authorLogin.trim() : "maintainer"
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map(parseNote).filter((n): n is MythicalNote => n !== undefined)
    : []
  return {
    position,
    epic,
    title,
    summary,
    commitSha,
    mainFoldedSha,
    treeEqualToMain: raw.treeEqualToMain === true,
    prNumber,
    authorLogin,
    notes,
  }
}

export const groupByEpic = (commits: ReadonlyArray<MythicalCommit>): ReadonlyArray<EpicGroup> => {
  const map = new Map<string, Array<MythicalCommit>>()
  for (const commit of commits) {
    const list = map.get(commit.epic)
    if (list === undefined) map.set(commit.epic, [commit])
    else list.push(commit)
  }
  return Array.from(map.entries()).map(([epic, items]) => ({ epic, commits: items }))
}

export const extractMythical = (docs: ReadonlyArray<FeedDocument>): ExtractedMythical => {
  const doc = docs.find((d) => d.name === "mythical" || d.name === "mythical/stack")
  if (doc === undefined || !isRecord(doc.body)) {
    return { hasFeed: false, commits: [], epics: [], treeEqualToMain: false, updatedAt: null }
  }
  const rawList = Array.isArray(doc.body.commits) ? doc.body.commits : []
  const commits = rawList
    .map((entry, idx) => parseCommit(entry, rawList.length - idx))
    .filter((c): c is MythicalCommit => c !== undefined)
    .sort((a, b) => b.position - a.position)
  const treeEqualToMain = commits.length > 0 && commits[0]!.treeEqualToMain
  const updatedAt = typeof doc.body.updatedAt === "string" ? doc.body.updatedAt : doc.updatedAt
  return {
    hasFeed: commits.length > 0,
    commits,
    epics: groupByEpic(commits),
    treeEqualToMain,
    updatedAt,
  }
}
