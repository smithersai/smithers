import { Catalog } from "@smthrs/chain"
import { JEV_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import type { AppStore } from "../state/AppStore"
import { clampLimit, searchDocuments } from "../wiki/search"
import type { WikiHit } from "../wiki/search"

/*
 * The worldview door (DESIGN.md §14, decision D2): remember and recall bound
 * to the worldDocuments wiki — the store that already matches the System
 * Prompt's worldview description (markdown, wikilinks, provenance,
 * confidence). remember upserts a note with actor smithers and chain
 * provenance. The entry names and payload shapes are the stable contract —
 * when @smthrs/memory gains a browser store, it slots in underneath without
 * scripts changing. Free tier (app:act): writing its own memory is the
 * agent's core loop; the propose-only belief discipline arrives with the
 * belief lanes, not here.
 *
 * recall is two stages. The keyword scorer (wiki/search.ts: title ×3, tags
 * ×2, body ×1) is the SHORTLIST — cheap, local, and the same ranking the
 * wiki flows use — and Jev, through the Worker's relay, decides the order.
 * One request carries a choice over the shortlist's paths and a boolean
 * asking whether any of them answers the query at all, so a wiki that does
 * not cover the question says so instead of handing back its closest
 * keyword match. Jev is the decision; there is no fallback. A relay that
 * refuses fails the call with the reason, because a keyword order the model
 * never blessed is exactly the answer this door stopped giving.
 */

/** The most documents the keyword shortlist hands Jev to order. */
export const RECALL_SHORTLIST_MAX = 30
/** Below this, Jev says none of the shortlist answers the query. */
export const RECALL_COVERED_THRESHOLD = 0.5
/** The two questions of the one relayed evaluation. */
export const RECALL_ORDER_KEY = "order"
export const RECALL_COVERED_KEY = "covered"
export const RECALL_ORDER_INSTRUCTIONS = "Which document best answers the query?"
export const RECALL_COVERED_INSTRUCTIONS = "Does any of these documents answer the query?"

/** Where the relay lives and what reaches it; ChainRuntime's own options satisfy it. */
export interface WorldviewRelay {
  /** Absolute origin of the product Worker; empty is the page's own origin. */
  readonly baseUrl?: string | undefined
  /** Injectable like every seam, so tests bind fixtures, not a network. */
  readonly fetchImpl?: FetchLike | undefined
}

/** What one recall answered: the wiki's verdict, then the documents in Jev's order. */
export interface RecallAnswer {
  /** Jev said at least one of these documents answers the query. */
  readonly covered: boolean
  readonly results: ReadonlyArray<WikiHit>
}

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

const sanitizePath = (title: string): string =>
  `${title.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, " ") || "Untitled"}.md`

const recallFailed = (message: string, cause: string): Catalog.CallError =>
  new Catalog.CallError({ name: "recall", message, cause })

/** One option line: the title, and the snippet the keyword pass already cut to 200 characters. */
const optionOf = (hit: WikiHit): string => hit.snippet === "" ? hit.title : `${hit.title}: ${hit.snippet}`

/** The paths Jev weighted, best first, zero-probability dropped. No probabilities means the one chosen path. */
const orderOf = (answer: { readonly choice?: unknown; readonly probabilities?: unknown }): ReadonlyArray<string> => {
  const probabilities = answer.probabilities
  if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities)) {
    return typeof answer.choice === "string" ? [answer.choice] : []
  }
  return Object.entries(probabilities as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([path]) => path)
}

export const worldviewEntries = (store: AppStore, relay: WorldviewRelay): ReadonlyArray<Catalog.Entry> => [
  {
    name: "recall",
    description:
      "Search the worldview wiki. Payload: { query: string, limit?: number }. A keyword pass shortlists, then Jev orders the hits and says whether the wiki covers the query at all. Answers { covered, results } with path, title, snippet, confidence, and freshness — never the whole worldview. Fails when Jev cannot decide.",
    capabilities: ["app:act"],
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as { readonly query?: unknown; readonly limit?: unknown })
        : {}
      if (typeof record.query !== "string" || record.query.trim() === "") {
        return Effect.fail(
          new Catalog.CallError({ name: "recall", message: `"recall" takes { query, limit? }` })
        )
      }
      const query = record.query
      const limit = clampLimit(record.limit)
      // The same scorer the wiki flows rank with (wiki/search.ts): one shortlist, two doors.
      const shortlist = searchDocuments(store.collections.worldDocuments.values(), query, RECALL_SHORTLIST_MAX)
      // Nothing to order is not a decision: an empty wiki spends no request.
      if (shortlist.length === 0) return Effect.succeed<RecallAnswer>({ covered: false, results: [] })
      const send = relay.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
      return Effect.tryPromise({
        try: async (): Promise<RecallAnswer> => {
          const response = await send(`${relay.baseUrl ?? ""}${JEV_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              state: {
                query,
                // Ids, titles and the keyword snippet only: a document body
                // never leaves the browser for a ranking decision.
                documents: shortlist.map((hit) => ({ id: hit.path, title: hit.title, snippet: hit.snippet }))
              },
              questions: {
                [RECALL_ORDER_KEY]: {
                  type: "choice",
                  instructions: RECALL_ORDER_INSTRUCTIONS,
                  criteria: Object.fromEntries(shortlist.map((hit) => [hit.path, optionOf(hit)]))
                },
                [RECALL_COVERED_KEY]: { type: "boolean", instructions: RECALL_COVERED_INSTRUCTIONS }
              }
            })
          })
          if (!response.ok) {
            const refusal = (await response.json().catch(() => undefined)) as { readonly code?: unknown; readonly message?: unknown } | undefined
            const code = typeof refusal?.code === "string" ? refusal.code : `http_${response.status}`
            const said = typeof refusal?.message === "string" ? refusal.message : `HTTP ${response.status}`
            throw new Catalog.CallError({ name: "recall", message: `The wiki could not be ranked: ${said}`, cause: code })
          }
          const body = (await response.json()) as { readonly answers?: Record<string, unknown> } | undefined
          const answers = body?.answers
          const order = typeof answers === "object" && answers !== null ? answers[RECALL_ORDER_KEY] : undefined
          const covered = typeof answers === "object" && answers !== null ? answers[RECALL_COVERED_KEY] : undefined
          if (
            typeof order !== "object" || order === null || (order as { type?: unknown }).type !== "choice" ||
            typeof covered !== "object" || covered === null || (covered as { type?: unknown }).type !== "boolean" ||
            typeof (covered as { probability?: unknown }).probability !== "number"
          ) {
            throw new Catalog.CallError({
              name: "recall",
              message: "The wiki could not be ranked: Jev did not answer with a decision.",
              cause: "jev_undecided"
            })
          }
          const byPath = new Map(shortlist.map((hit) => [hit.path, hit]))
          const results = orderOf(order as { choice?: unknown; probabilities?: unknown })
            .map((path) => byPath.get(path))
            .filter((hit): hit is WikiHit => hit !== undefined)
            .slice(0, limit)
          return { covered: (covered as { probability: number }).probability >= RECALL_COVERED_THRESHOLD, results }
        },
        catch: (cause) =>
          cause instanceof Catalog.CallError
            ? cause
            : recallFailed(
              `The wiki could not be ranked: ${cause instanceof Error ? cause.message : String(cause)}`,
              "jev_unreachable"
            )
      })
    }
  },
  {
    name: "remember",
    description:
      "Write a worldview note. Payload: { title: string, text: string, path?: string, tags?: string[], confidence?: number }. Upserts by path; wikilinks in the text become links.",
    capabilities: ["app:act"],
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as {
          readonly title?: unknown
          readonly text?: unknown
          readonly path?: unknown
          readonly tags?: unknown
          readonly confidence?: unknown
        })
        : {}
      if (
        typeof record.title !== "string" ||
        record.title.trim() === "" ||
        typeof record.text !== "string" ||
        record.text.trim() === ""
      ) {
        return Effect.fail(
          new Catalog.CallError({
            name: "remember",
            message: `"remember" takes { title, text, path?, tags?, confidence? }`
          })
        )
      }
      const title = record.title.trim()
      const text = record.text
      const path = typeof record.path === "string" && record.path.trim() !== ""
        ? record.path.trim()
        : sanitizePath(title)
      return Effect.tryPromise({
        try: async () => {
          const existing = [...store.collections.worldDocuments.values()].find(
            (document) => document.path === path
          )
          // Omitted optional fields preserve the existing note's values; an
          // upsert only changes what the caller actually stated.
          const tags = Array.isArray(record.tags)
            ? record.tags.map((tag) => String(tag))
            : [...(existing?.tags ?? [])]
          const confidence = typeof record.confidence === "number" && record.confidence >= 0 && record.confidence <= 1
            ? record.confidence
            : (existing?.confidence ?? 0.6)
          const links = [...text.matchAll(WIKILINK)].map((match) => match[1] as string)
          // Nondeterministic id for a new note is fine: the settled call
          // journals the returned path/id, so replay never re-mints.
          const id = existing?.id ?? `world-${crypto.randomUUID()}`
          const sources = existing === undefined ? ["chain-remember"] : [...existing.sources]
          if (existing !== undefined && !sources.includes("chain-remember")) {
            sources.push("chain-remember")
          }
          await store.dispatch({
            type: "world.document.upserted",
            actor: "smithers",
            select: false,
            document: {
              id,
              path,
              title,
              body: text,
              links,
              tags,
              sources,
              confidence
            }
          }).isPersisted.promise
          return { id, path }
        },
        catch: (cause) =>
          new Catalog.CallError({
            name: "remember",
            message: `remember could not persist: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      })
    }
  }
]
