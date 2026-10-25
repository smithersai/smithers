import { ImmutableCache } from "@smthrs/artifacts"
import { Docs, Home } from "@smthrs/views"
import { Cause, Clock, Config, Context, Data, Duration, Effect, Layer, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { type DocsRefusal, MAX_PAGE_BYTES } from "../../src/features/docs/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Curated from "../home/Curated.ts"
import type * as RepoAbout from "../RepoAbout.ts"

// A repository's docs as ChatApi reads them (ruling AGENT-6, docs/features/docs.md#where-docs-come-from): the docs index
// a repository names in its own home (`"docs"` in `.smithers/home.json`, read from what GitHub says of it through the
// about read RepoApi answers with, worker/RepoAbout.ts), else the one Smithers' curated home names; then the index and
// its pages from the docs site, through `@smthrs/views`' `Docs.fetchText` and its guard. Nothing here knows a docs
// site: any repository that names an `llms.txt` index gets the same.
//
// A page is read only when the repository's own index lists its path (`Docs.find`), and the index keeps only links on
// its own origin, so a request never names a URL: ChatApi fetches only from the host the repository named (SSRF).
// The index and each page are kept in the immutable cache for `DOCS_KEPT` (5 minutes), by URL, in windows of that
// length; a refusal is never kept. Nothing here records a URL, a path or a page's text.

/** How long an index or a page is kept, unless `DOCS_KEPT` says otherwise. */
export const KEPT = Duration.minutes(5)

/** Why there are no docs to answer, as the routes say it, with the docs site's own reason when it didn't answer. */
export interface Refused {
  readonly _tag: "Refused"
  readonly code: DocsRefusal
  readonly reason?: string
}

/** The repository's docs index, where it was named (its own home or Smithers' curated one), and whether it was kept. */
export type IndexRead =
  | {
    readonly _tag: "Index"
    readonly index: Docs.Index
    readonly source: "declared" | "curated"
    readonly cached: boolean
  }
  | Refused

/** One page of the repository's docs index, with its Markdown, and whether it was kept. */
export type PageRead = { readonly _tag: "Page"; readonly page: Docs.Page; readonly text: string; readonly cached: boolean } | Refused

/** The docs of any repository, read on the host's `HttpClient` and kept in its immutable cache. */
export class DocsSource extends Context.Service<
  DocsSource,
  {
    readonly index: (owner: string, name: string) => Effect.Effect<IndexRead>
    readonly page: (owner: string, name: string, path: string) => Effect.Effect<PageRead>
  }
>()("@smthrs/mvp/docs/DocsSource") {}

/**
 * How the source reads: what GitHub says of a repository (RepoApi's about read), the curated homes
 * (worker/home/curated/ unless a test gives its own) and hosts the guard lets through.
 */
export interface Options<R = never> {
  readonly about: RepoAbout.Source<R>
  readonly homes?: ReadonlyArray<Curated.CuratedFile>
  /** Hosts `Docs.fetchText` may request though they are private, such as a test's `127.0.0.1`: none unless set. */
  readonly privateHosts?: ReadonlyArray<string>
}

class Unreachable extends Data.TaggedError("Unreachable")<{ readonly reason: string }> {}

const refused = (code: DocsRefusal, reason?: string): Refused =>
  reason === undefined ? { _tag: "Refused", code } : { _tag: "Refused", code, reason }

const AboutHome = Schema.Struct({ home: Schema.NullOr(Schema.String) })
// The about read answers an `About`, which always has `home`: anything else is a defect, answered `unavailable`.
const decodeAbout = Schema.decodeUnknownSync(Schema.fromJsonString(AboutHome))

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The docs index a home's text names, if it is a home that names one. */
const docsOfHome = (text: string): string | undefined => {
  const read = Home.read(text)
  return read._tag === "Declared" ? read.docs : undefined
}

/** Captures `DOCS_KEPT` at program build, without acquiring a runtime cache. */
export const settings = Effect.gen(function* () {
  return { kept: Duration.toMillis(yield* Config.Duration("DOCS_KEPT").pipe(Config.withDefault(KEPT))) }
})

/** Captured deployment settings over the runtime's HTTP client and cache; never reads Config. */
export const make = <R = never>({ kept }: { readonly kept: number }, options: Options<R>) =>
  Effect.gen(function* () {
    const privateHosts = options.privateHosts ?? []
    const context = yield* Effect.context<HttpClient.HttpClient | ImmutableCache.ImmutableCache | R>()

    /**
     * The index `owner/name` names: its own home's `docs` at the newest commit, else its curated home's. When GitHub
     * can't answer, a curated home's still serves; with none, the read is `unavailable`, or `not_found` for a
     * repository GitHub doesn't have.
     */
    const named = (owner: string, name: string) =>
      Effect.gen(function* () {
        const curated = Curated.find(owner, name, options.homes)
        const fallback = typeof curated === "object" ? curated.docs : undefined
        // A docs read spends no deployment token: anyone may name any repository. The App's still reads a repository
        // it is installed on.
        const read = yield* options.about.answer(owner, name, Effect.succeed(false))
        if (read._tag === "Refused") {
          if (fallback !== undefined) return { url: fallback, source: "curated" as const }
          return refused(read.code === "not_found" ? "not_found" : "unavailable")
        }
        const { home } = decodeAbout(read.text)
        const own = home === null ? undefined : docsOfHome(home)
        if (own !== undefined) return { url: own, source: "declared" as const }
        if (fallback !== undefined) return { url: fallback, source: "curated" as const }
        return refused("no_docs")
      })

    /**
     * `url`'s text, kept for the window: `Unreachable` with the docs site's reason when it didn't answer, `busy` for a
     * 429 or 5xx it may not answer next time, and `redirects` when it answered from another site, whose text is never
     * kept as this one's.
     */
    const text = (namespace: string, url: string, maxBytes?: number) =>
      Effect.gen(function* () {
        const window = Math.floor((yield* Clock.currentTimeMillis) / kept)
        let fresh = false
        const entry = yield* ImmutableCache.readThrough(
          ImmutableCache.key(namespace, url, String(window)),
          Effect.gen(function* () {
            const fetched = yield* Docs.fetchText(url, {
              privateHosts,
              ...(maxBytes === undefined ? {} : { maxBytes }),
            })
            if (fetched._tag === "Refused") {
              const busy = fetched.reason === "status" && (fetched.status === 429 || (fetched.status ?? 0) >= 500)
              return yield* new Unreachable({ reason: busy ? "busy" : fetched.reason })
            }
            if (new URL(fetched.url).origin !== new URL(url).origin) return yield* new Unreachable({ reason: "redirects" })
            fresh = true
            return { bytes: encoder.encode(fetched.text), metadata: {} }
          }),
        )
        return { text: decoder.decode(entry.bytes), cached: !fresh }
      })

    /** Anything that isn't an answer (a defect, a cache that broke) is `unavailable`, logged by its code only. */
    const orUnavailable = <A, E, R>(effect: Effect.Effect<A | Refused, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("docs.source").pipe(Effect.annotateLogs({ errorCode: codeOf(Cause.squash(cause)) })),
            refused("unavailable"),
          )
        ),
      )

    /** The index of `owner/name`; a name GitHub couldn't have is `not_found`, as GitHub would answer. */
    const index = (owner: string, name: string): Effect.Effect<IndexRead> =>
      orUnavailable(Effect.gen(function* () {
        const found = yield* named(owner, name)
        if ("_tag" in found) return found
        const read = yield* text("docs.index", found.url).pipe(Effect.result)
        if (read._tag === "Failure") return refused("docs_unreachable", read.failure.reason)
        // Against the URL the repository named, so a page is kept only on the host it named, whatever the redirects.
        return {
          _tag: "Index" as const,
          index: Docs.parse(read.success.text, found.url),
          source: found.source,
          cached: read.success.cached,
        }
      })).pipe(Effect.provideContext(context))

    const page = (owner: string, name: string, path: string): Effect.Effect<PageRead> =>
      orUnavailable(Effect.gen(function* () {
        const read = yield* index(owner, name)
        if (read._tag === "Refused") return read
        const listed = Docs.find(read.index, path)
        if (listed === undefined) return refused("page_not_found")
        const fetched = yield* text("docs.page", listed.url, MAX_PAGE_BYTES).pipe(Effect.result)
        if (fetched._tag === "Failure") return refused("docs_unreachable", fetched.failure.reason)
        return { _tag: "Page" as const, page: listed, text: fetched.success.text, cached: fetched.success.cached }
      })).pipe(Effect.provideContext(context))

    return DocsSource.of({ index, page })
  })

/** The source as a layer, over the `HttpClient` and `ImmutableCache` it is built with, and what its about read needs. */
export const layer = <R = never>(captured: { readonly kept: number }, options: Options<R>) =>
  Layer.effect(DocsSource, make(captured, options))
