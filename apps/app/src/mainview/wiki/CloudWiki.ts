import { Context, Data, Effect, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import * as Y from "yjs"
import { z } from "zod"
import { cloudFailure, createCloudClient } from "../state/seams/CloudClient"
import type { SeamFetch } from "../state/seams/SeamContext"

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const CloudWikiPage = z.object({
  id: positiveId,
  slug: z.string().min(1),
  title: z.string(),
  body: z.string().refine((value) => new TextEncoder().encode(value).length <= 1024 * 1024),
  revision: positiveId,
  author: z.object({ id: positiveId, login: z.string() }),
  created_at: z.string(),
  updated_at: z.string()
})
export const CloudWikiDocument = z.object({
  page: CloudWikiPage,
  state: z.string().max(Math.ceil(8 * 1024 * 1024 / 3) * 4),
  state_vector: z.string().max(Math.ceil(8 * 1024 * 1024 / 3) * 4)
})
export type CloudWikiDocument = z.infer<typeof CloudWikiDocument>
export const CloudWikiPageIndex = CloudWikiPage.omit({ body: true })
export const CloudWikiAck = z.object({
  document: CloudWikiDocument,
  update_id: z.string().uuid(),
  accepted_revision: positiveId
})
export const CloudWikiRevision = z.object({
  id: positiveId,
  page_id: positiveId,
  revision: positiveId,
  update_id: z.string().uuid().nullish(),
  deleted: z.boolean(),
  slug: z.string().min(1)
})
export type CloudWikiRevision = z.infer<typeof CloudWikiRevision>

export class CloudWikiError extends Data.TaggedError("CloudWikiError")<{
  readonly message: string
  readonly status?: number
}> {}

export const wikiPagePath = (repo: string, slug: string): string => {
  const parts = repo.split("/")
  if (parts.length !== 2 || parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    throw new CloudWikiError({ message: "Choose a repository as owner/repo." })
  }
  if (!slug || slug === "." || slug === ".." || /[\s/\\]/.test(slug)) {
    throw new CloudWikiError({ message: "Choose a Wiki page slug without spaces or slashes." })
  }
  return `/repos/${parts.map(encodeURIComponent).join("/")}/wiki/${encodeURIComponent(slug)}`
}

export const wikiDocumentId = (repo: string, pageId: number): string => `wiki:${repo}:${pageId}`
export const wikiDocumentPath = (repo: string, slug: string): string => `${repo}/wiki/${slug}.md`

export const decodeWikiState = (state: string): Uint8Array => {
  const text = atob(state)
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}
export const encodeWikiState = (bytes: Uint8Array): string => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Always reconstruct from causal state; seeding a second independent text duplicates it. */
const withDocument = <A>(states: ReadonlyArray<string>, use: (document: Y.Doc) => A): A => {
  const document = new Y.Doc()
  try {
    for (const state of states) Y.applyUpdate(document, decodeWikiState(state))
    return use(document)
  } finally {
    document.destroy()
  }
}

export const mergeWikiState = (...states: ReadonlyArray<string>): { state: string; body: string } =>
  withDocument(states, (document) => ({
    state: encodeWikiState(Y.encodeStateAsUpdate(document)),
    body: document.getText("markdown").toString()
  }))

/** An acknowledgement must contain the submitted causal update, including deletions. */
export const wikiStateContains = (state: string, update: string): boolean =>
  mergeWikiState(state).state === mergeWikiState(state, update).state

/** The editor supplies Markdown; splice only its changed range into the existing Y.Text. */
export const editWikiState = (state: string, body: string, clientId?: number): { state: string; update: string } =>
  withDocument([state], (document) => {
    if (new TextEncoder().encode(body).length > 1024 * 1024) {
      throw new CloudWikiError({ message: "A Wiki page cannot exceed 1 MiB of Markdown." })
    }
    if (clientId !== undefined) document.clientID = clientId
    const text = document.getText("markdown")
    const previous = text.toString()
    const vector = Y.encodeStateVector(document)
    let start = 0
    while (start < previous.length && start < body.length && previous[start] === body[start]) start++
    // Y.Text and JavaScript both index UTF-16. Never split a surrogate pair.
    if (start > 0 && /[\uD800-\uDBFF]/.test(previous[start - 1]!)) start--
    let tail = 0
    while (
      tail < previous.length - start && tail < body.length - start &&
      previous[previous.length - 1 - tail] === body[body.length - 1 - tail]
    ) tail++
    if (tail > 0 && /[\uDC00-\uDFFF]/.test(previous[previous.length - tail]!)) tail--
    document.transact(() => {
      text.delete(start, previous.length - start - tail)
      text.insert(start, body.slice(start, body.length - tail))
    })
    const update = Y.encodeStateAsUpdate(document, vector)
    if (update.length > 1024 * 1024) {
      throw new CloudWikiError({ message: "This Wiki edit exceeds the 1 MiB update limit." })
    }
    const encoded = Y.encodeStateAsUpdate(document)
    if (encoded.length > 8 * 1024 * 1024) {
      throw new CloudWikiError({ message: "This Wiki page exceeds the 8 MiB collaborative state limit." })
    }
    return { state: encodeWikiState(encoded), update: encodeWikiState(update) }
  })

/** Internal app seam: the existing cloud proxy supplies authentication and fetch. */
export class CloudWikiTransport extends Context.Service<CloudWikiTransport, {
  readonly list: (
    repo: string,
    page: number
  ) => Effect.Effect<ReadonlyArray<z.infer<typeof CloudWikiPageIndex>>, CloudWikiError>
  readonly read: (repo: string, slug: string) => Effect.Effect<CloudWikiDocument, CloudWikiError>
  readonly update: (
    repo: string,
    slug: string,
    pageId: number,
    updateId: string,
    update: string
  ) => Effect.Effect<z.infer<typeof CloudWikiAck>, CloudWikiError>
  readonly revisions: (
    repo: string,
    slug: string,
    pageId: number,
    after: number
  ) => Stream.Stream<CloudWikiRevision, CloudWikiError>
}>()("smithers-ui/CloudWikiTransport") {}

export const makeCloudWikiTransport = (
  config: { readonly http: SeamFetch; readonly baseUrl: string }
): typeof CloudWikiTransport.Service => {
  const { url } = createCloudClient(config)
  const response = (path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: async (signal) => {
        const value = await config.http(url(path), { ...init, signal })
        if (!value.ok) {
          const failure = await cloudFailure(value, `Reading or saving this Wiki page failed (${value.status}).`)
          throw new CloudWikiError({ message: failure.error, status: value.status })
        }
        return value
      },
      catch: (error) =>
        error instanceof CloudWikiError ?
          error :
          new CloudWikiError({ message: "Could not reach the Wiki. Your pending edits are saved locally." })
    }).pipe(Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new CloudWikiError({ message: "The Wiki request timed out. Pending edits are still saved locally." })
        )
    }))
  const json = <A>(path: string, schema: z.ZodType<A>, init?: RequestInit) =>
    Effect.flatMap(response(path, init), (value) =>
      Effect.tryPromise({
        try: async () => schema.parse(await value.json()),
        catch: () =>
          new CloudWikiError({ message: "The Wiki returned an invalid document. Local edits were retained." })
      }))
  return {
    list: (repo, page) =>
      Effect.suspend(() =>
        json(
          `${wikiPagePath(repo, "home").replace(/\/home$/, "")}?page=${page}&per_page=50`,
          z.array(CloudWikiPageIndex).max(50)
        )
      ),
    read: (repo, slug) => Effect.suspend(() => json(`${wikiPagePath(repo, slug)}/document`, CloudWikiDocument)),
    update: (repo, slug, pageId, updateId, update) =>
      Effect.suspend(() =>
        json(
          `${wikiPagePath(repo, slug)}/updates`,
          CloudWikiAck,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page_id: pageId, update_id: updateId, update })
          }
        )
      ),
    revisions: (repo, slug, pageId, after) =>
      Stream.unwrap(Effect.map(
        response(`${wikiPagePath(repo, slug)}/stream?page_id=${pageId}&after=${after}`, {
          headers: { accept: "text/event-stream" }
        }),
        (value) =>
          value.body === null || !value.headers.get("content-type")?.includes("text/event-stream")
            ? Stream.fail(new CloudWikiError({ message: "The Wiki revision stream could not be opened." }))
            : Stream.fromReadableStream({
              evaluate: () => value.body!,
              onError: () => new CloudWikiError({ message: "The Wiki revision stream disconnected." })
            }).pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 16 * 1024 })),
              Stream.filter((event) => event.event === "wiki.update" || event.event === "revoked"),
              Stream.mapEffect((event) =>
                event.event === "revoked"
                  ? Effect.fail(new CloudWikiError({ message: "Access to this Wiki was revoked.", status: 403 }))
                  : Effect.try({
                    try: () => {
                      const revision = CloudWikiRevision.parse(JSON.parse(event.data))
                      if (
                        revision.page_id !== pageId || String(revision.revision) !== event.id ||
                        revision.id !== revision.revision
                      ) {
                        throw new Error("Mismatched Wiki revision")
                      }
                      return revision
                    },
                    catch: () => new CloudWikiError({ message: "The Wiki returned an invalid revision event." })
                  })
              ),
              Stream.mapError((error) =>
                error instanceof CloudWikiError ?
                  error :
                  new CloudWikiError({ message: "The Wiki revision stream disconnected." })
              )
            )
      ))
  }
}
