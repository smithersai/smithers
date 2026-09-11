/*
 * The Wiki's keyword scorer, lifted out of chain/Worldview.ts (Librarian L5)
 * so the chain's `recall` entry and the wiki flows rank notes the same way.
 * A hit carries the note's confidence and freshness beside its score: the
 * caller answers "how sure and how old", never a bare number.
 */

/** What a document must carry to be scored; AppState's WorldDocument satisfies it. */
export interface SearchableDocument {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly tags: ReadonlyArray<string>
  readonly confidence: number
  readonly updatedAt: number
}

/** One ranked note: where it is, the line the query hit, and how sure and how fresh it is. */
export interface WikiHit {
  readonly path: string
  readonly title: string
  readonly snippet: string
  readonly confidence: number
  readonly updatedAt: number
  readonly score: number
}

/** The default and ceiling of hits one search answers. */
export const SEARCH_DEFAULT_LIMIT = 5
export const SEARCH_MAX_LIMIT = 10

/**
 * The query and the documents as lowercase word tokens. Discriminating tokens
 * (three letters and more) win when any exist; a query of only short tokens
 * ("jj", "ci") searches with what it has rather than going blind.
 */
export const tokensOf = (text: string): ReadonlyArray<string> => {
  const all = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
  const long = all.filter((token) => token.length > 2)
  return long.length > 0 ? long : all
}

/** Title hits count three, tag hits two, body hits one. */
export const scoreDocument = (document: SearchableDocument, needles: ReadonlyArray<string>): number => {
  const title = tokensOf(document.title)
  const tags = tokensOf(document.tags.join(" "))
  const body = tokensOf(document.body)
  let score = 0
  for (const needle of needles) {
    score += title.filter((token) => token === needle).length * 3
    score += tags.filter((token) => token === needle).length * 2
    score += body.filter((token) => token === needle).length
  }
  return score
}

/** The first body line that mentions a needle, else the first line, cut to 200 characters. */
const snippetOf = (body: string, needles: ReadonlyArray<string>): string => {
  const line = body
    .split("\n")
    .find((candidate) => needles.some((needle) => candidate.toLowerCase().includes(needle)))
  return (line ?? body.split("\n")[0] ?? "").trim().slice(0, 200)
}

/** A caller's limit clamped to [1, SEARCH_MAX_LIMIT]; anything else is the default. */
export const clampLimit = (limit: unknown): number =>
  typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT

/**
 * The documents that mention the query, best first, at most `limit` of them.
 * A blank query answers nothing: the chain entry refuses it before calling,
 * and the flow door renders the form.
 */
export const searchDocuments = (
  documents: Iterable<SearchableDocument>,
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT
): ReadonlyArray<WikiHit> => {
  const needles = tokensOf(query)
  if (needles.length === 0) return []
  return [...documents]
    .map((document) => ({ document, score: scoreDocument(document, needles) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || right.document.updatedAt - left.document.updatedAt)
    .slice(0, limit)
    .map(({ document, score }) => ({
      path: document.path,
      title: document.title,
      snippet: snippetOf(document.body, needles),
      confidence: document.confidence,
      updatedAt: document.updatedAt,
      score
    }))
}
