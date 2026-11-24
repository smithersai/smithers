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
 * merge endpoint here too.
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
// GraphQL string literals, block strings first; a review body may say "APPROVE".
const GRAPHQL_STRINGS = /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g

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

const graphql = (body: Uint8Array): string | undefined => {
  const document = jsonObject(body)
  const query = document?.["query"]
  if (document === undefined || typeof query !== "string") return UNREADABLE
  const code = query.replace(GRAPHQL_STRINGS, "\"\"")
  if (MERGE_MUTATIONS.test(code)) return MERGE
  if (DISMISS_MUTATIONS.test(code)) return REVIEW
  if (!REVIEW_MUTATIONS.test(code)) return undefined
  return PEOPLE_EVENT.test(code) || namesPeopleEvent(document["variables"]) ? REVIEW : undefined
}

// `event` absent leaves a review pending, which approves nothing.
const review = (body: Uint8Array, pendingAllowed: boolean): string | undefined => {
  const document = jsonObject(body)
  if (document === undefined) return UNREADABLE
  const event = document["event"]
  return event === "COMMENT" || (event === undefined && pendingAllowed) ? undefined : REVIEW
}

const byPath = (segments: ReadonlyArray<string>): string | undefined => {
  if (segments[0] !== "repos") return undefined
  if (segments.length === 4 && segments[3] === "merges") return MERGE
  if (segments[3] !== "pulls") return undefined
  if (segments.length === 6 && segments[5] === "merge") return MERGE
  if (segments.length === 8 && segments[5] === "reviews" && segments[7] === "dismissals") return REVIEW
  return undefined
}

/**
 * Why the proxy refuses this request, or undefined when it forwards it.
 * `body` is the request body; a request with none passes an empty array.
 *
 * @since 1.0.0
 * @private
 */
export const refusal = (method: string, pathname: string, body: Uint8Array): string | undefined => {
  if (method === "GET" || method === "HEAD") return undefined
  const segments = segmentsOf(pathname)
  if (segments === undefined) return UNREADABLE
  const path = byPath(segments)
  if (path !== undefined) return path
  if (segments[segments.length - 1] === "graphql") return graphql(body)
  if (segments[0] !== "repos" || segments[3] !== "pulls" || segments[5] !== "reviews") return undefined
  if (segments.length === 6) return review(body, true)
  if (segments.length === 8 && segments[7] === "events") return review(body, false)
  return undefined
}
