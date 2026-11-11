/**
 * Keyword recall with no host dependencies.
 *
 * Scores every authoritative row in each selected bank by the number of
 * normalized query terms occurring in its key and text, breaks ties by newest
 * update, then applies the shared Smithers-compatible byte cap. There is no
 * recency window: an old match ranks the same as a new one. Each bank is read
 * in pages of {@link pageSize} rows per kind, and only the rows the cap can
 * still select are kept between pages.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import { resolveBanks } from "./internal/ResolveNamespace.ts"
import type * as MemoryError from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Namespace from "./Namespace.ts"
import * as Recall from "./Recall.ts"

/**
 * Rows one store read returns while recall pages through a bank.
 *
 * @category models
 * @since 1.0.0
 */
export const pageSize = 512

/**
 * A row accepted from the store retrieval seam.
 *
 * @category models
 * @since 0.1.0
 */
export type Row = Pick<MemoryStore.SearchRow, "key" | "text" | "tags" | "status" | "updatedAtMs">

/**
 * Splits a query into the normalized terms scoring compares against.
 *
 * @category models
 * @since 0.1.0
 */
export const normalizeQueryTerms = (value: string): ReadonlyArray<string> =>
  value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)

/**
 * Scores one row by the number of normalized query terms occurring in its key
 * and text.
 *
 * @category models
 * @since 0.1.0
 */
export const scoreRow = (query: ReadonlyArray<string>, row: Row): number => {
  const haystack = `${row.key} ${row.text}`.normalize("NFKC").toLowerCase()
  return query.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
}

const matches = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  groups === undefined || groups.every((group) => Namespace.matches(group, row.tags))

const authoritative = (row: Row, groups: ReadonlyArray<Recall.TagGroup> | undefined): boolean =>
  matches(row, groups) && (row.status === undefined || row.status === "accepted")

// The cap selects a greedy prefix of the ranked rows, and adding rows only
// pushes a row further down, so a row past the selected prefix of any subset
// is never selected from the whole bank.
const retained = (rows: Array<Recall.Result>, maxTokens: number | undefined): Array<Recall.Result> => {
  rows.sort(Recall.compareResults)
  return rows.slice(0, Recall.capRecallResults(rows, maxTokens).length)
}

/**
 * Runs keyword recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recall = (
  input: Recall.Input
): Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const banks = yield* resolveBanks(input.banks)
    const terms = normalizeQueryTerms(input.query)
    if (banks.length === 0 || terms.length === 0) return []
    const scan = (bank: string, namespace: Namespace.Namespace, kind: MemoryStore.SearchRow["kind"]) =>
      Effect.gen(function*() {
        let kept: Array<Recall.Result> = []
        let after: MemoryStore.SearchRow | undefined
        let page: ReadonlyArray<MemoryStore.SearchRow>
        do {
          page = yield* store.searchRows({
            namespace,
            status: "accepted",
            tagGroups: input.tagGroups,
            kinds: [kind],
            limit: pageSize,
            ...(after === undefined ? {} : { after })
          })
          for (const row of page) {
            const score = authoritative(row, input.tagGroups) && row.text !== "" ? scoreRow(terms, row) : 0
            if (score > 0) kept.push({ bank, key: row.key, text: row.text, score, updatedAtMs: row.updatedAtMs })
          }
          kept = retained(kept, input.maxTokens)
          after = page.at(-1)
        } while (page.length === pageSize)
        return kept
      })
    const kept = yield* Effect.all(
      banks.flatMap(({ bank, namespace }) => [scan(bank, namespace, "fact"), scan(bank, namespace, "note")]),
      { concurrency: 4 }
    )
    return Recall.capRecallResults(kept.flat().sort(Recall.compareResults), input.maxTokens)
  })

/**
 * Provides keyword recall as the default replaceable recall slot.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore> = Recall.layerFrom(recall)
