import { MAX_VIEW_TEXT_BYTES } from "../src/features/docs/contract.ts"
import { cutText } from "../src/features/docs/text.ts"
import { isRepository } from "../src/features/repo/contract.ts"
import type { ViewProps } from "../src/features/views/schema.ts"
import { ShapeProxy } from "@smthrs/effect-electric"
import { type PresentationRealm, ViewCode } from "@smthrs/views"
import { Cause, Clock, Config, Data, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import {
  MAX_GENERATED_BODY_BYTES,
  MAX_VIEW_BODY_BYTES,
  MAX_VIEW_HTML_BYTES,
  MAX_VIEW_JSON_BYTES,
  SUBMIT_EVENT,
  VIEWS_ROUTE,
  VIEWS_TABLE,
} from "../src/features/views/contract.ts"
import { acceptedValues, formRefusal } from "../src/features/views/form.ts"
import {
  type FormValues,
  type FormWrite,
  type GeneratedWrite,
  type IssuesWrite,
  type PageWrite,
  type RepoWrite,
  StateWrite,
  ViewWrite,
} from "../src/features/views/schema.ts"
import { checkUrl } from "../src/features/web/url.ts"
import { canAsk, Sessions } from "./Actor.ts"
import { branchAccess, canEdit, canView } from "./branch/Access.ts"
import * as Conversations from "./branch/Conversations.ts"
import { readBounded } from "./Body.ts"
import { DocsSource } from "./docs/Source.ts"
import { codeOf } from "./ErrorCode.ts"
import * as Messages from "./Messages.ts"
import * as ShapeAccess from "./ShapeAccess.ts"
import * as ViewRealm from "./ViewRealm.ts"

// The conversation's views in ChatApi (docs/features/web-pages.md#the-views-table, decision 0004 §8): `POST /api/views`
// adds one, and `GET /api/shapes/views` is Electric's `views`, which every device syncs like the messages. Only a
// person who may ask (Member or above, decision 0007) adds a view, as only they may ask: a view is the browser's
// agent's or their own `/web`. A view is added once by the id its writer chose, so a step run again changes nothing.
//
// A view's props are the page's URL and what the flow's check read from its head: a title, a description and an
// `https:` icon, each bounded (src/features/views/schema.ts). The route checks the page again, as `app/web/open` does
// (src/features/web/url.ts), against the host the request came to: no row ever holds a `javascript:`, `data:`, `file:` or `blob:` URL, one with a name or password, a page of
// the app itself, or a `webpage` that isn't `https:` on another site. A `link` may be `http:` on `localhost` only where
// `WEB_PAGES_LOCAL_HTTP` says so: `alchemy dev` (worker/DevChatApi.ts), never a deployment unless it is set. Whatever
// a row holds, the browser checks it again before it renders (`@smthrs/ui`'s `WebPageView` and `WebLinkCard`).
//
// A `docs` view names a repository and a page's path (docs/features/docs.md#the-docs-view): ChatApi reads that page
// from the repository's own docs index (worker/docs/Source.ts) and keeps its URL, title and at most 64 KiB of its
// Markdown in the row, so a row never holds Markdown a client chose and every device shows it offline.
//
// A repository's view and its issues view (`repo`, `issues`; docs/features/views.md#a-repository-and-its-issues) keep
// only their props, which name the repository and where the view opens: every device reads what they show from the
// repository itself, under its own access rules.
//
// The agent's forms and generated views (docs/features/views.md) are added the same way. A form's schema must render
// at least one field and ask for no secret (src/features/views/form.ts). A generated view's module runs here and only
// here: the route checks it (`ViewCode.check`) and renders it in the presentation realm (worker/ViewRealm.ts), and keeps
// the HTML it rendered, never HTML a device sent. A module that fails either is `422 { code: "not_rendered", detail }`,
// the detail for the renderer that wrote it to correct; it may quote the module, so it is never logged. A move in a
// generated view is `POST /api/views/<id>/state`: the route runs the module's `reduce` from the state it keeps, renders
// the new state, and bumps the view's revision, so every device shows the same board.

/** `POST /api/views` requests, by `status`. */
export const requests = Metric.counter("smithers_view_requests", {
  description: "POST /api/views requests, by status",
  incremental: true,
})

/** `GET /api/shapes/views` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_view_shape_requests", {
  description: "GET /api/shapes/views requests, by status and live",
  incremental: true,
})

/** `POST /api/views/<id>/state` requests, by `status`. */
export const states = Metric.counter("smithers_view_state_requests", {
  description: "POST /api/views/<id>/state requests, by status",
  incremental: true,
})

/** Generated views rendered by ChatApi's realm, by `outcome` (`rendered`, `not_rendered`) and `door` (`add`, `state`). */
export const renders = Metric.counter("smithers_view_renders", {
  description: "Generated views rendered by ChatApi, by outcome and door",
  incremental: true,
})

const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(ViewWrite))
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(StateWrite))

/** The bytes of `value` as JSON. */
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** A module that failed its check or its render: what went wrong, for the renderer to correct. Never logged. */
class NotRendered extends Data.TaggedError("NotRendered")<{ readonly reason: string; readonly detail: string }> {}

/**
 * Checks `code` and renders it with `props` and `state` in `realm`: the checked module and its HTML. A failed check or
 * render is `NotRendered`, with the redacted detail unwrapped for the renderer, and a state over the bound is too.
 */
const render = (realm: PresentationRealm.Realm, code: string, props: unknown, state: unknown) =>
  Effect.gen(function* () {
    if (jsonBytes(state) > MAX_VIEW_JSON_BYTES) {
      return yield* new NotRendered({ reason: "state", detail: `The state is over ${MAX_VIEW_JSON_BYTES} bytes as JSON.` })
    }
    const module = yield* ViewCode.check(code, { components: realm.components }).pipe(
      Effect.mapError((error) => new NotRendered({ reason: error.reason, detail: Redacted.value(error.detail) })),
    )
    const html = yield* realm.render({ module, props, state }).pipe(
      Effect.mapError((error) => new NotRendered({ reason: error.limit ?? error.reason, detail: Redacted.value(error.detail) })),
    )
    if (new TextEncoder().encode(html).length > MAX_VIEW_HTML_BYTES) {
      return yield* new NotRendered({ reason: "html", detail: `The view renders more than ${MAX_VIEW_HTML_BYTES} bytes of HTML.` })
    }
    return { module, html }
  })

/**
 * `WEB_PAGES_LOCAL_HTTP`: whether a `link` to an `http:` page on `localhost` is kept. `localHttp` unless set, which only
 * `alchemy dev` passes as `true`: a deployment keeps `https:` pages alone.
 */
export const localHttpConfig = (localHttp: boolean) =>
  Config.Boolean("WEB_PAGES_LOCAL_HTTP").pipe(Config.withDefault(localHttp))

/** The policy for `request`: the app is the origin it came to (its absolute URL, as Workers and `fetch` get it). */
export const policyFor = (request: HttpServerRequest.HttpServerRequest, localHttp: boolean) => ({
  localHttp,
  appOrigin: new URL(request.originalUrl).origin,
})

type Fields = Record<string, string | number | boolean>

const noStore = { "cache-control": "no-store" }

/** A refusal: its status and code, logged and answered as `{ code }`. */
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })

/** What the route keeps of a view: its template's columns. */
type Stored =
  | { readonly id: string; readonly template: PageWrite["template"]; readonly props: ViewProps }
  | { readonly id: string; readonly template: "repo"; readonly props: RepoWrite["props"] }
  | { readonly id: string; readonly template: "issues"; readonly props: IssuesWrite["props"] }
  | { readonly id: string; readonly template: "form"; readonly props: FormWrite["props"]; readonly state: unknown }
  | {
    readonly id: string
    readonly template: "generated"
    readonly props: GeneratedWrite["props"]
    readonly title: string
    readonly size: string
    readonly state: unknown
    readonly code: string
    readonly html: string
    readonly interactions: unknown
  }

/** The columns a stored view sets beyond its id, template and props, as SQL values. */
const columnsOf = (view: Stored) =>
  view.template === "generated"
    ? {
      title: view.title,
      size: view.size,
      state: JSON.stringify(view.state),
      code: view.code,
      html: view.html,
      interactions: JSON.stringify(view.interactions),
    }
    : view.template === "form"
    ? { title: null, size: "inline", state: JSON.stringify(view.state), code: null, html: null, interactions: null }
    : { title: null, size: "inline", state: null, code: null, html: null, interactions: null }

/** Adds the view to conversation `conversationId` unless its id is taken: the transaction it added it in, or nothing. */
const insert = (view: Stored, conversationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = columnsOf(view)
    const [row] = yield* sql<{ readonly txid: string }>`
      INSERT INTO views (id, template, props, conversation_id, title, size, state, code, html, interactions)
      VALUES (${view.id}, ${view.template}, ${JSON.stringify(view.props)}::jsonb, ${conversationId}, ${columns.title},
        ${columns.size}, ${columns.state}::jsonb, ${columns.code}, ${columns.html}, ${columns.interactions}::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return row === undefined ? undefined : Number(row.txid)
  })

/** Whether the view under `view`'s id is `view` itself, in the same conversation: the same add, landed before. */
const landed = (view: Stored, conversationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Every stored docs row is built from docsTarget, which requires its repository and path.
    const [row] = view.template === "docs"
      ? yield* sql<{ readonly same: boolean }>`
        SELECT template = 'docs' AND props->>'repository' = ${view.props.repository as string}
          AND props->>'path' = ${view.props.path as string} AND conversation_id = ${conversationId} AS same
        FROM views WHERE id = ${view.id}`
      : yield* sql<{ readonly same: boolean }>`
        SELECT template = ${view.template} AND props = ${JSON.stringify(view.props)}::jsonb
          AND conversation_id = ${conversationId} AS same
        FROM views WHERE id = ${view.id}`
    return row?.same === true
  })

/** Whether a `docs` view of the same repository's same page is already under `id`. */
const addedDocs = (id: string, docs: { readonly owner: string; readonly name: string; readonly path: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly id: string }>`
      SELECT id FROM views WHERE id = ${id} AND template = 'docs'
        AND props->>'repository' = ${`${docs.owner}/${docs.name}`} AND props->>'path' = ${docs.path}`
    return row !== undefined
  })

/** The repository and page a `docs` write names: `owner/name` GitHub could have, and a path; none otherwise. */
const docsTarget = (props: PageWrite["props"]) => {
  const [owner, name] = (props.repository ?? "").split("/")
  return owner === undefined || name === undefined || props.path === undefined || !isRepository(owner, name)
    ? undefined
    : { owner, name, path: props.path, url: props.url }
}

/** The declared events of the generated view under `view`'s id, when it is this very view: the same add, landed before. */
const keptEvents = (
  view: { readonly id: string; readonly props: unknown; readonly code: string },
  conversationId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly interactions: unknown }>`
      SELECT interactions FROM views
      WHERE id = ${view.id} AND template = 'generated' AND props = ${JSON.stringify(view.props)}::jsonb
        AND conversation_id = ${conversationId} AND code = ${view.code}`
    return row?.interactions
  })

/** The conversation of answer `answerId` when `askedBy` asked its question: where its agent's views go. */
const answerConversation = (answerId: string, askedBy: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly conversationId: string }>`
      SELECT a.conversation_id AS "conversationId" FROM messages a JOIN messages q ON q.id = a.question_id
      WHERE a.id = ${answerId} AND a.role = 'assistant' AND q.asked_by = ${askedBy}`
    return row?.conversationId
  })

/** What a shape filters on for someone who may not watch a conversation: no conversation's id, so it holds no rows. */
const NO_CONVERSATION = "00000000-0000-0000-0000-000000000000"

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** The columns a device syncs: every one but a generated view's module, which only ChatApi runs. */
export const SYNCED_VIEW_COLUMNS = [
  "id",
  "conversation_id",
  "template",
  "props",
  "position",
  "created_at",
  "title",
  "size",
  "state",
  "html",
  "interactions",
  "revision",
  "updated_at",
] as const

/** What `make` takes besides the database. */
export interface Options {
  /** Whether a `link` to `http:` on `localhost` is kept: `WEB_PAGES_LOCAL_HTTP`'s default. */
  readonly localHttp?: boolean
  /**
   * The presentation realm generated views render in, loaded on the first that needs it (worker/ViewRealm.ts): `load`
   * on Cloudflare, `loadNode` in the tests.
   */
  readonly realm: Effect.Effect<PresentationRealm.Realm, PresentationRealm.RealmError>
}

/** The id in `/api/views/<id>/state`, or `undefined` for any other path. */
export const stateViewId = (path: string): string | undefined => {
  const match = new RegExp(`^${VIEWS_ROUTE}/([0-9a-fA-F-]{36})/state$`).exec(path)
  return match === null || !isUuid(match[1]!) ? undefined : match[1]!.toLowerCase()
}

/**
 * Reads Electric's connection (`ShapeProxy.config`) and `WEB_PAGES_LOCAL_HTTP` (`localHttp` unless set, `false` unless
 * given), and returns the views routes: `add` for `POST /api/views`, `state` for `POST /api/views/<id>/state` and
 * `shape` for `GET /api/shapes/views`. Each add is a log line `chat.view.add`, a span `chat.view.request` and a count;
 * each move `chat.view.state`, `chat.view.state.request` and a count; none carries the page, the module, its props,
 * its state or its HTML. `database` opens a Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options) =>
  Effect.gen(function* () {
    const localHttp = yield* localHttpConfig(options.localHttp ?? false)
    const realm = ViewRealm.once(options.realm)
    // GET /api/shapes/views?conversation=<id>: one conversation's views (decision 0013 §1), the home conversation's
    // when it names none. Anyone who may not watch the branch gets a shape with no rows; a request the server can't
    // decide, because sessions or the home conversation can't be read, is 503 (worker/ShapeAccess.ts).
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const shape = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const named = new URL(request.url, "http://localhost").searchParams.get("conversation")
        const conversation = named !== null && isUuid(named)
          ? named.toLowerCase()
          : named === null
          ? yield* Conversations.home.pipe(Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
          : undefined
        const actor = yield* ShapeAccess.actor
        // Only someone who may view the conversation's branch gets its views (worker/branch/Access.ts).
        const found = conversation === undefined
          ? undefined
          : yield* branchAccess(actor, conversation, "conversation").pipe(
            Effect.provide(database),
            Effect.mapError(() => ShapeAccess.unavailable),
          )
        return {
          table: VIEWS_TABLE,
          columns: SYNCED_VIEW_COLUMNS,
          where: "conversation_id = $1",
          params: { "1": found !== undefined && canView(found.access) ? found.conversationId : NO_CONVERSATION },
        }
      }),
      name: "chat.views.shape",
      metric: shapes,
    })

    /** What the route keeps of a page, checked against the policy, or why it refuses it. */
    const pageOf = (write: PageWrite, request: HttpServerRequest.HttpServerRequest, fields: Fields) => {
      const page = checkUrl(write.props.url, write.template === "webpage" ? "embed" : "tab", policyFor(request, localHttp))
      if (!page.ok) {
        fields.reason = page.reason
        return undefined
      }
      // The page's own title, description and https icon, as the flow's check read them (ViewWrite bounds each).
      const { url: _url, repository: _repository, path: _path, ...preview } = write.props
      return { id: write.id, template: write.template, props: { url: page.page.href, ...preview } } satisfies Stored
    }

    const add = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const actor = yield* (yield* Sessions).resolve
        if (Option.isNone(actor)) return refusal(401, "authentication")
        // A Guest, or a person with no role, may not ask, so may not add to the conversation either.
        if (!canAsk(actor.value)) return refusal(403, "forbidden")
        const body = yield* readBounded(request, MAX_GENERATED_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
          Effect.result,
        )
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const decoded = yield* decodeWrite(body.success).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        // Lowercase, as Postgres prints a uuid: one view has one id in rows, logs and the browser.
        const write = { ...decoded.value, id: decoded.value.id.toLowerCase() }
        fields.viewId = write.id
        fields.template = write.template
        // Only a generated view's module may take more than a page's or a form's 8 KiB.
        if (write.template !== "generated" && new TextEncoder().encode(body.success).length > MAX_VIEW_BODY_BYTES) {
          return refusal(413, "too_large")
        }
        if (write.template === "form") {
          const refused = formRefusal(write.props.schema)
          if (refused !== undefined) {
            fields.reason = refused
            return refusal(400, "refused")
          }
        }
        if (write.template === "docs" && pageOf(write, request, fields) === undefined) return refusal(400, "refused")
        const docs = write.template === "docs" ? docsTarget(write.props) : undefined
        if (write.template === "docs" && docs === undefined) return refusal(400, "invalid")
        // The view's conversation (decision 0013 §1): an agent's call names its answer, and the view goes to that
        // answer's conversation, only for the person who asked it; a person's names its conversation, which must
        // exist; neither means the home conversation.
        const named = write.answerId !== undefined
          ? yield* answerConversation(write.answerId.toLowerCase(), actor.value.subject.id).pipe(Effect.provide(database))
          : write.conversationId === undefined
          ? yield* Conversations.home.pipe(Effect.provide(database))
          : write.conversationId.toLowerCase()
        // What the row keeps, decided before the conversation's lock is taken: a docs page is read from its site.
        let docsStored: Stored | undefined
        if (docs !== undefined && (yield* addedDocs(write.id, docs).pipe(Effect.provide(database)))) {
          // The same page under the same id, added before: a resend whose answer was lost. The site isn't asked again,
          // so it lands as before even once the site dropped the page; the conversation is still checked below.
          docsStored = {
            id: write.id,
            template: "docs",
            props: { url: docs.url, repository: `${docs.owner}/${docs.name}`, path: docs.path },
          }
        } else if (docs !== undefined) {
          // The page as the repository's own docs index lists it, and its Markdown as the docs site answers it now.
          const read = yield* (yield* DocsSource).page(docs.owner, docs.name, docs.path)
          if (read._tag === "Refused") {
            fields.reason = read.code
            return read.code === "unavailable"
              ? refusal(503, "unavailable")
              : read.code === "docs_unreachable"
              ? refusal(502, "docs_unreachable")
              : refusal(400, "refused")
          }
          const site = checkUrl(read.page.url, "tab", policyFor(request, localHttp))
          if (!site.ok) {
            fields.reason = site.reason
            return refusal(400, "refused")
          }
          const text = cutText(read.text, MAX_VIEW_TEXT_BYTES)
          fields.truncated = text.truncated
          docsStored = {
            id: write.id,
            template: "docs",
            props: {
              url: site.page.href,
              title: read.page.title,
              repository: `${docs.owner}/${docs.name}`,
              path: read.page.path,
              text: text.text,
              ...(text.truncated ? { truncated: true } : {}),
            },
          }
        }
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(Effect.gen(function* () {
            // Shares.write holds this same row lock. Read policy only after acquiring it, and keep it through insert.
            if (named !== undefined) yield* sql`
              SELECT b.id FROM branches b JOIN conversations c ON c.branch_id = b.id
              WHERE c.id = ${named} FOR UPDATE OF b`
            const found = named === undefined
              ? undefined
              : yield* branchAccess(actor, named, "conversation")
            if (found === undefined) return refusal(404, "conversation_not_found")
            // Only someone who may edit the branch adds to its conversation (worker/branch/Access.ts).
            if (!canEdit(found.access)) return refusal(403, "forbidden")
            const conversationId = found.conversationId
            fields.conversationId = conversationId
            let stored: Stored
            if (docsStored !== undefined) {
              stored = docsStored
            } else if (write.template === "form") {
              stored = { id: write.id, template: "form", props: write.props, state: { submitted: false } }
            } else if (write.template === "repo") {
              stored = { id: write.id, template: "repo", props: write.props }
            } else if (write.template === "issues") {
              stored = { id: write.id, template: "issues", props: write.props }
            } else if (write.template === "generated") {
              // The same add again is answered from the row, without rendering the module a second time.
              const again = { id: write.id, template: "generated", props: write.props, code: write.code } as const
              const kept = yield* keptEvents(again, conversationId)
              if (kept !== undefined) {
                fields.existing = true
                return HttpServerResponse.jsonUnsafe({ txid: null, interactions: kept }, { status: 200, headers: noStore })
              }
              // The module runs here, never on a device: the HTML kept is the realm's own.
              const rendered = yield* render(yield* realm, write.code, write.props, write.state).pipe(Effect.result)
              yield* Metric.update(
                Metric.withAttributes(renders, {
                  outcome: rendered._tag === "Success" ? "rendered" : "not_rendered",
                  door: "add",
                }),
                1,
              )
              if (rendered._tag === "Failure") {
                fields.reason = rendered.failure.reason
                return HttpServerResponse.jsonUnsafe(
                  { code: "not_rendered", detail: rendered.failure.detail },
                  { status: 422, headers: noStore },
                )
              }
              stored = {
                id: write.id,
                template: "generated",
                props: write.props,
                title: write.title,
                size: write.size,
                state: write.state,
                code: write.code,
                html: rendered.success.html,
                interactions: rendered.success.module.interactions,
              }
            } else {
              const page = pageOf(write, request, fields)
              if (page === undefined) return refusal(400, "refused")
              stored = page
            }
            const txid = yield* insert(stored, conversationId)
            const events = stored.template === "generated" ? { interactions: stored.interactions } : {}
            if (txid !== undefined) {
              return HttpServerResponse.jsonUnsafe({ txid, ...events }, { status: 202, headers: noStore })
            }
            if (yield* landed(stored, conversationId)) {
              fields.existing = true
              return HttpServerResponse.jsonUnsafe({ txid: null }, { status: 200, headers: noStore })
            }
            return refusal(409, "id_taken")
          }))
        }).pipe(Effect.provide(database))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refusal(503, "unavailable")
          })
        ),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      yield* Metric.update(Metric.withAttributes(requests, { status: String(response.status) }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "chat.view.add",
      ).pipe(Effect.annotateLogs(fields))
      return response
    }).pipe(Effect.withSpan("chat.view.request", { kind: "server" }))

    /**
     * `POST /api/views/<viewId>/state { revision, event }`: one move in a generated view. Only someone who may edit the
     * view's conversation moves; the event must be one the module declares as `state`; and the revision must be the
     * view's own, so a move made against a board another device already changed is `409 { code: "stale", revision }`
     * and the device shows the synced board. The module's `reduce` runs here, from the state ChatApi keeps. Each move
     * is kept by its id with the revision it made, in its transaction: the same move again answers that revision.
     */
    const state = (viewId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = { viewId }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          const actor = yield* (yield* Sessions).resolve
          if (Option.isNone(actor)) return refusal(401, "authentication")
          if (!canAsk(actor.value)) return refusal(403, "forbidden")
          const body = yield* readBounded(request, MAX_VIEW_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
            Effect.result,
          )
          if (body._tag === "Failure") {
            return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
          }
          const move = yield* decodeState(body.success).pipe(Effect.option)
          if (Option.isNone(move)) return refusal(400, "invalid")
          return yield* Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                return yield* sql.withTransaction(Effect.gen(function* () {
                  const [view] = yield* sql<{
                    readonly template: string
                    readonly conversationId: string
                    readonly code: string | null
                    readonly props: unknown
                    readonly state: unknown
                    readonly interactions: Record<string, { readonly kind: string }> | null
                    readonly revision: number
                  }>`
                    SELECT template, conversation_id AS "conversationId", code, props, state, interactions, revision
                    FROM views WHERE id = ${viewId} FOR UPDATE`
                  if (view === undefined || view.template !== "generated" || view.code === null) {
                    return refusal(404, "not_found")
                  }
                  const found = yield* branchAccess(actor, view.conversationId, "conversation")
                  if (found === undefined || !canEdit(found.access)) return refusal(403, "forbidden")
                  // The same move again, whose answer was lost: what it made, never a stale board.
                  const [made] = yield* sql<{ readonly revision: number }>`
                    SELECT revision FROM view_moves WHERE view_id = ${viewId} AND move_id = ${move.value.moveId}`
                  if (made !== undefined) {
                    fields.existing = true
                    return HttpServerResponse.jsonUnsafe(
                      { txid: null, revision: made.revision },
                      { status: 200, headers: noStore },
                    )
                  }
                  if (view.interactions?.[move.value.event.name]?.kind !== "state") return refusal(400, "undeclared")
                  if (move.value.revision !== view.revision) {
                    return HttpServerResponse.jsonUnsafe(
                      { code: "stale", revision: view.revision },
                      { status: 409, headers: noStore },
                    )
                  }
                  const loaded = yield* realm
                  const checked = yield* ViewCode.check(view.code, { components: loaded.components }).pipe(Effect.option)
                  const moved = Option.isNone(checked) ? undefined : yield* loaded.interact({
                    module: checked.value,
                    props: view.props,
                    state: view.state,
                    event: move.value.event,
                  }).pipe(Effect.option, Effect.map(Option.getOrUndefined))
                  const kept = moved !== undefined && jsonBytes(moved.state) <= MAX_VIEW_JSON_BYTES &&
                    new TextEncoder().encode(moved.html).length <= MAX_VIEW_HTML_BYTES
                  yield* Metric.update(
                    Metric.withAttributes(renders, { outcome: kept ? "rendered" : "not_rendered", door: "state" }),
                    1,
                  )
                  // A move the module can't make, or whose state is over the bound, changes nothing.
                  if (!kept) return refusal(422, "not_rendered")
                  const [changed] = yield* sql<{ readonly txid: string; readonly revision: number }>`
                    UPDATE views SET state = ${JSON.stringify(moved.state)}::jsonb, html = ${moved.html},
                      revision = revision + 1, updated_at = now()
                    WHERE id = ${viewId}
                    RETURNING pg_current_xact_id()::xid::text AS txid, revision`
                  yield* sql`
                    INSERT INTO view_moves (view_id, move_id, revision)
                    VALUES (${viewId}, ${move.value.moveId}, ${changed!.revision})`
                  fields.revision = changed!.revision
                  return HttpServerResponse.jsonUnsafe(
                    { txid: Number(changed!.txid), revision: changed!.revision },
                    { status: 200, headers: noStore },
                  )
                }))
              }).pipe(Effect.provide(database))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refusal(503, "unavailable")
            })
          ),
        )
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(states, { status: String(response.status) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "chat.view.state",
        ).pipe(Effect.annotateLogs(fields))
        return response
      }).pipe(Effect.withSpan("chat.view.state.request", { kind: "server" }))

    return { add, state, shape }
  })

/** A question from a view that ChatApi won't take: its status and code. */
export class SourceRefused extends Data.TaggedError("SourceRefused")<{ readonly status: number; readonly code: string }> {}

/** Where a question came from: the view, and the event it sent. */
export interface Source {
  readonly viewId: string
  readonly event: string
}

/**
 * Asks `question`, sent from view `source` with `data`, in one transaction with what it changes in the view
 * (decision 0004 §3 and §6):
 * - a form's `submit`: the values must be ones the form's own schema takes, and the form must be open, or submitted by
 *   this very question (a resend); the form becomes `{ submitted: true, values, questionId }` with the question;
 * - a generated view's event: one its module declares as `message`.
 * The view must be in the question's conversation. Anything else is `SourceRefused`, and nothing is written.
 */
export const askFrom = (
  question: Parameters<typeof Messages.ask>[0],
  source: Source,
  data: FormValues | undefined,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [view] = yield* sql<{
        readonly template: string
        readonly conversationId: string
        readonly props: { readonly schema: Readonly<Record<string, unknown>> }
        readonly state: { readonly submitted?: boolean; readonly questionId?: string } | null
        readonly interactions: Record<string, { readonly kind: string }> | null
      }>`
        SELECT template, conversation_id AS "conversationId", props, state, interactions
        FROM views WHERE id = ${source.viewId} FOR UPDATE`
      if (view === undefined || view.conversationId !== question.conversationId) {
        // 400, not 404: the outbox keeps a refused question as Not sent, where a 404 is sent again forever.
        return yield* new SourceRefused({ status: 400, code: "view_not_found" })
      }
      if (view.template === "form") {
        if (source.event !== SUBMIT_EVENT) return yield* new SourceRefused({ status: 400, code: "undeclared" })
        const values = data ?? {}
        if (acceptedValues(view.props.schema, values) === undefined) {
          return yield* new SourceRefused({ status: 400, code: "invalid_values" })
        }
        if (view.state?.submitted === true && view.state.questionId !== question.id) {
          return yield* new SourceRefused({ status: 409, code: "submitted" })
        }
        const asked = yield* Messages.ask({ ...question, source, data: values })
        if (asked.txid !== null) {
          yield* sql`
            UPDATE views SET state = ${JSON.stringify({ submitted: true, values, questionId: question.id })}::jsonb,
              revision = revision + 1, updated_at = now()
            WHERE id = ${source.viewId}`
        }
        return asked
      }
      if (view.template === "generated" && view.interactions?.[source.event]?.kind === "message") {
        return yield* Messages.ask({ ...question, source, ...(data === undefined ? {} : { data }) })
      }
      return yield* new SourceRefused({ status: 400, code: "undeclared" })
    }))
  })
