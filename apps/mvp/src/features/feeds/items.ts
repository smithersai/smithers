import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Effect } from "effect"
import { FEED_ANSWER_NAMESPACE } from "./contract"
import type { FeedItem } from "./schema"

// A document's items (docs/features/feeds.md#plugins): the elements of its body array that carry a string `id`, one
// `core/feed-items` row each, so the host's strip can select one and answer it through `feed/answer`. Nothing here
// knows what an item means: a decision, a release to approve, an alert to acknowledge.

/** An element's string `options`, in order; none when it has no array of them. */
const optionsOf = (element: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
  Array.isArray(element.options) ? element.options.filter((option): option is string => typeof option === "string") : []

/**
 * The items of document `document` of repository `repo` (`owner/name`, lowercased), whose body is `body`: every
 * element of a body array that is an object with a non-empty string `id`, in order, the first of an id only. Each
 * answer id is the UUID v5 of the repository, the document and the element itself: the same element always has the same
 * id, so a second press, or a press retried after a lost reply, records one answer; a changed element is a new item.
 */
export const itemsOf = (repo: string, document: string, body: unknown): Effect.Effect<ReadonlyArray<FeedItem>> =>
  Effect.gen(function* () {
    if (!Array.isArray(body)) return []
    const [owner = "", name = ""] = repo.split("/")
    const seen = new Set<string>()
    const items: Array<FeedItem> = []
    for (const element of body as ReadonlyArray<unknown>) {
      if (typeof element !== "object" || element === null || Array.isArray(element)) continue
      const fields = element as Readonly<Record<string, unknown>>
      const item = fields.id
      if (typeof item !== "string" || item === "" || seen.has(item)) continue
      seen.add(item)
      const answer = yield* Uuid.v5(FEED_ANSWER_NAMESPACE, JSON.stringify([repo, document, element]))
      const options = optionsOf(fields)
      items.push({
        key: `${repo}:${document}:${item}`,
        repo,
        owner,
        name,
        document,
        index: items.length,
        item,
        options,
        chooses: options.length > 0,
        body: element,
        answer,
      })
    }
    return items
  }).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
