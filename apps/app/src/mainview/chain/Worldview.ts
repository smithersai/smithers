import { Catalog } from "@smthrs/chain"
import { Effect } from "effect"
import type { AppStore } from "../state/AppStore"
import { clampLimit, searchDocuments } from "../wiki/search"

/*
 * The worldview door (DESIGN.md §14, decision D2): remember and recall bound
 * to the worldDocuments wiki — the store that already matches the System
 * Prompt's worldview description (markdown, wikilinks, provenance,
 * confidence). recall is a scored keyword search (title ×3, tags ×2, body
 * ×1) that answers with each hit's confidence and freshness, never the whole
 * worldview; remember upserts a note with actor smithers and chain
 * provenance. The entry names and payload shapes are the stable contract —
 * when @smthrs/memory gains a browser store, it slots in underneath without
 * scripts changing. Free tier (app:act): writing its own memory is the
 * agent's core loop; the propose-only belief discipline arrives with the
 * belief lanes, not here.
 */

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

const sanitizePath = (title: string): string =>
  `${title.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, " ") || "Untitled"}.md`

export const worldviewEntries = (store: AppStore): ReadonlyArray<Catalog.Entry> => [
  {
    name: "recall",
    description:
      "Search the worldview wiki. Payload: { query: string, limit?: number }. Answers scored hits with path, title, snippet, confidence, and freshness — never the whole worldview.",
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
      // The same scorer the wiki flows rank with (wiki/search.ts): one ranking, two doors.
      return Effect.sync(() => ({
        results: searchDocuments(store.collections.worldDocuments.values(), query, limit)
      }))
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
