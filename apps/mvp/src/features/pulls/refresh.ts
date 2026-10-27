import { type ShapeSource } from "@smthrs/effect-electric"
import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Schema } from "effect"
import { PULL_RECEIPT_HEADER } from "./contract"
import { type PullsView, VIEW } from "./schema"

const Receipt = Schema.fromJsonString(Schema.Struct({ number: Schema.Number, checkedAt: Schema.Number, missing: Schema.Boolean }))
const decode = Schema.decodeUnknownOption(Receipt)

/** Detail shapes carry their routed subject; only a matching, newer server receipt can certify its absence. */
export const refreshingSource = (source: ShapeSource.Source, view: Collection.Collection<PullsView, string>, id: string): ShapeSource.Source => ({
  ...source,
  request: (url, init) => Effect.gen(function* () {
    const current = (yield* view.toArray)[0]!
    const number = current.repoId === id ? current.number : null
    const target = new URL(url)
    if (number !== null) target.searchParams.set("refresh", String(number))
    const response = yield* source.request(target.href, init)
    const receipt = decode(response.headers.get(PULL_RECEIPT_HEADER))
    if (response.ok && receipt._tag === "Some" && receipt.value.number === number) {
      const read = receipt.value
      yield* view.update(VIEW, (row) => {
        if (row.repoId !== id || row.number !== number || read.checkedAt < (row.pullCheckedAt ?? 0)) return
        row.pullAbsent = read.missing
        row.pullCheckedAt = read.checkedAt
      }).pipe(Effect.orDie)
    }
    return response
  }),
})
