/**
 * What the GitHub proxy refuses to forward: the actions only a person takes.
 *
 * People approve and merge; agents never do. A sandboxed agent reaches GitHub
 * through the proxy with the operator's credential, so the proxy is where that
 * boundary holds. It refuses, before any credential is fetched:
 *
 * - merging a pull request or a branch (`PUT …/pulls/{n}/merge`, `POST …/merges`);
 * - a pull request review that is anything but a comment: creating or
 *   submitting one with an `event` other than `COMMENT`, and dismissing one;
 * - the GraphQL mutations that do the same.
 *
 * The path is judged in the form GitHub routes it: percent-decoded, lower
 * case, with empty segments dropped, so `/REPOS/o/r/pulls/7/%6Derge/` is the
 * merge endpoint here too. A repository is `/repos/{owner}/{name}` or
 * `/repositories/{id}`, each also under GitHub's `/api/v3` prefix; the same
 * rules apply to what follows either.
 *
 * A GraphQL document is judged as GitHub's lexer reads it: comments and string
 * literals are taken out in source order, so a quote inside a comment opens no
 * string and a mutation between two such comments is still seen.
 *
 * @since 1.0.0
 * @private
 */

// GraphQL mutations that merge, or queue a merge, whatever their arguments.
const MERGE_MUTATIONS = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/
// A dismissal removes a person's review.
const DISMISS_MUTATIONS = /\bdismissPullRequestReview\b/
// Review mutations that take an event; only COMMENT is an agent's to send.
const REVIEW_MUTATIONS = /\b(?:addPullRequestReview|submitPullRequestReview)\b/
const PEOPLE_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "DISMISS"])
const PEOPLE_EVENT = /\b(?:APPROVE|REQUEST_CHANGES|DISMISS)\b/

const MERGE = "merging is a person's action; the Smithers GitHub proxy does not forward it"
const REVIEW = "approving, requesting changes, and dismissing a review are a person's actions; "
  + "the Smithers GitHub proxy forwards only COMMENT reviews"
const UNREADABLE = "the Smithers GitHub proxy could not read this request to check it merges or approves nothing"

// The path's segments as GitHub routes them, or undefined when one is not valid percent-encoding.
const segmentsOf = (pathname: string): ReadonlyArray<string> | undefined => {
  try {
    return pathname.split("/").filter((segment) => segment !== "").map((segment) =>
      decodeURIComponent(segment).toLowerCase()
    )
  } catch {
    return undefined
  }
}

const jsonObject = (body: Uint8Array): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

// Whether any string anywhere in `value` is exactly a person's review event.
const namesPeopleEvent = (value: unknown): boolean => {
  const pending: Array<unknown> = [value]
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next === "string") {
      if (PEOPLE_EVENTS.has(next)) return true
    } else if (typeof next === "object" && next !== null) {
      for (const child of Object.values(next)) pending.push(child)
    }
  }
  return false
}

// Where the block string opened before `from` ends, or undefined when it never does. Only `\"""` escapes.
const blockStringEnd = (query: string, from: number): number | undefined => {
  let index = from
  while (index < query.length) {
    if (query.startsWith("\\\"\"\"", index)) index += 4
    else if (query.startsWith("\"\"\"", index)) return index + 3
    else index++
  }
  return undefined
}

// Where the string opened before `from` ends, or undefined when its line or the document ends first.
const stringEnd = (query: string, from: number): number | undefined => {
  let index = from
  while (index < query.length) {
    const char = query[index]
    if (char === "\"") return index + 1
    if (char === "\n" || char === "\r") return undefined
    const next = query[index + 1]
    index += char === "\\" && (next === "\"" || next === "\\") ? 2 : 1
  }
  return undefined
}

/**
 * A GraphQL document's code: one pass in source order that drops each `#`
 * comment up to its line's end and puts a space where each string literal
 * stood, block strings included. Undefined for a string that never closes,
 * which GitHub does not execute and the proxy does not guess at.
 */
const codeOf = (query: string): string | undefined => {
  const code: Array<string> = []
  let index = 0
  let kept = 0
  while (index < query.length) {
    const char = query[index]
    if (char !== "#" && char !== "\"") {
      index++
      continue
    }
    code.push(query.slice(kept, index), " ")
    if (char === "#") {
      while (index < query.length && query[index] !== "\n" && query[index] !== "\r") index++
    } else {
      const end = query.startsWith("\"\"\"", index) ? blockStringEnd(query, index + 3) : stringEnd(query, index + 1)
      if (end === undefined) return undefined
      index = end
    }
    kept = index
  }
  code.push(query.slice(kept))
  return code.join("")
}

const graphql = (body: Uint8Array): string | undefined => {
  const document = jsonObject(body)
  const query = document?.["query"]
  if (document === undefined || typeof query !== "string") return UNREADABLE
  const code = codeOf(query)
  if (code === undefined) return UNREADABLE
  if (MERGE_MUTATIONS.test(code)) return MERGE
  if (DISMISS_MUTATIONS.test(code)) return REVIEW
  if (!REVIEW_MUTATIONS.test(code)) return undefined
  // GitHub reads variables as a JSON object; any other form could carry an event this check cannot see.
  const variables = document["variables"]
  if (variables !== undefined && variables !== null && (typeof variables !== "object" || Array.isArray(variables))) {
    return UNREADABLE
  }
  return PEOPLE_EVENT.test(code) || namesPeopleEvent(variables) ? REVIEW : undefined
}

// `event` absent leaves a review pending, which approves nothing.
const review = (body: Uint8Array, pendingAllowed: boolean): string | undefined => {
  const document = jsonObject(body)
  if (document === undefined) return UNREADABLE
  const event = document["event"]
  return event === "COMMENT" || (event === undefined && pendingAllowed) ? undefined : REVIEW
}

// The segments after the repository a path names, or undefined when it names none. GitHub routes
// `/repositories/{id}` as it does `/repos/{owner}/{name}`, and both under `/api/v3` as well.
const repositoryTail = (segments: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const routed = segments[0] === "api" && segments[1] === "v3" ? segments.slice(2) : segments
  if (routed[0] === "repos") return routed.slice(3)
  if (routed[0] === "repositories") return routed.slice(2)
  return undefined
}

const byPath = (tail: ReadonlyArray<string>): string | undefined => {
  if (tail.length === 1 && tail[0] === "merges") return MERGE
  if (tail[0] !== "pulls") return undefined
  if (tail.length === 3 && tail[2] === "merge") return MERGE
  if (tail.length === 5 && tail[2] === "reviews" && tail[4] === "dismissals") return REVIEW
  return undefined
}

const hasQueryParam = (
  searchParams: URLSearchParams | undefined,
  names: ReadonlyArray<string>
): boolean => {
  if (searchParams === undefined) return false
  for (const key of searchParams.keys()) {
    if (names.includes(key.toLowerCase())) return true
  }
  return false
}

/**
 * Why the proxy refuses this request, or undefined when it forwards it.
 * `body` is the request body; a request with none passes an empty array.
 *
 * @since 1.0.0
 * @private
 */
export const refusal = (
  method: string,
  pathname: string,
  body: Uint8Array,
  searchParams?: URLSearchParams
): string | undefined => {
  if (method === "GET" || method === "HEAD") return undefined
  const segments = segmentsOf(pathname)
  if (segments === undefined) return UNREADABLE
  const tail = repositoryTail(segments)
  const path = tail === undefined ? undefined : byPath(tail)
  if (path !== undefined) return path
  if (segments[segments.length - 1] === "graphql") {
    if (hasQueryParam(searchParams, ["query", "variables", "operationname"])) return UNREADABLE
    return graphql(body)
  }
  if (tail === undefined || tail[0] !== "pulls" || tail[2] !== "reviews") return undefined
  if (tail.length === 3) {
    if (hasQueryParam(searchParams, ["event"])) return UNREADABLE
    return review(body, true)
  }
  if (tail.length === 5 && tail[4] === "events") {
    if (hasQueryParam(searchParams, ["event"])) return UNREADABLE
    return review(body, false)
  }
  return undefined
}
