import { MAX_VIEW_TEXT_BYTES } from "../src/features/docs/contract.ts"
// The views routes (worker/Views.ts, docs/features/web-pages.md#the-views-table), through ChatApi's real handler on this
// file's schema of the compose Postgres (`pnpm db:up`). The route is the server's half of `app/web/open`: the flow on the
// device checks a page first, and the route checks it again before it keeps it.
import { ConfigProvider, Deferred, Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { MAX_GENERATED_BODY_BYTES, MAX_VIEW_BODY_BYTES } from "../src/features/views/contract.ts"
import type { Actor } from "./Actor.ts"
import * as Conversations from "./branch/Conversations.ts"
import { shared, tracked } from "./test/branch.ts"
import type { CuratedFile } from "./home/Curated.ts"
import { eventually, harness, recorded, testFile } from "./test/harness.ts"
import { markdown, outsideWeb, type Page } from "./test/pages.ts"
import * as Views from "./Views.ts"

const runtime = testFile("views")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const open = (options: { readonly actor?: Actor | null } = {}) =>
  harness(runtime, () => Stream.empty, options.actor === null ? {} : { actor: options.actor ?? member })

type Harness = Awaited<ReturnType<typeof open>>

/** `POST /api/views` with `body`, to the host `chat.test` unless `host` names another. */
const add = (h: Harness, body: unknown, init: RequestInit = {}) =>
  h.fetch("/api/views", {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
    ...init,
  })

const page = (url: string, template: "webpage" | "link" = "webpage") => ({
  id: crypto.randomUUID(),
  template,
  props: { url },
})

const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly template: string; readonly props: unknown; readonly position: string }>`
      SELECT id::text AS id, template, props, position::text AS position FROM views ORDER BY position`))

describe("POST /api/views", () => {
  test.each(["webpage", "link"] as const)("stores a %s with a host-fetched inline icon larger than the form budget", async (template) => {
    const h = await open();
    const icon = "data:image/png;base64," + "Kioq".repeat(20_000);
    const view = { ...page("https://example.com/", template), props: { url: "https://example.com/", icon } };
    expect(JSON.stringify(view).length).toBeGreaterThan(MAX_VIEW_BODY_BYTES);
    expect((await add(h, view)).status).toBe(202);
    expect((await rows())[0]?.props).toEqual(view.props);
  });

  test("adds a view by the id its writer chose, at the conversation's next position, and a resend changes nothing", async () => {
    const h = await open()
    const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Show me example.com" }
    expect((await h.ask(question)).status).toBe(202)
    const view = page("https://example.com/docs?x=1#top")

    const first = await add(h, view)
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ txid: expect.any(Number) })
    const again = await add(h, { ...view, id: view.id.toUpperCase() })
    expect([again.status, await again.json()]).toEqual([200, { txid: null }])

    const [stored] = await rows()
    expect(stored).toMatchObject({ id: view.id, template: "webpage", props: { url: "https://example.com/docs?x=1#top" } })
    // After the question (position n) and its answer (n + 1).
    const [asked] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly position: string }>`SELECT max(position)::text AS position FROM messages`))
    expect(Number(stored!.position)).toBeGreaterThan(Number(asked!.position))
    expect(h.line("chat.view.add").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ viewId: view.id, template: "webpage", status: 202 }),
      expect.objectContaining({ viewId: view.id, status: 200, existing: true }),
    ])
    expect(h.count(Views.requests, { status: "202" })).toBe(1)
    expect(h.count(Views.requests, { status: "200" })).toBe(1)
  })

  test("an id that holds another view is 409, and the view stays as it was", async () => {
    const h = await open()
    const view = page("https://example.com/")
    expect((await add(h, view)).status).toBe(202)

    const taken = await add(h, { ...view, props: { url: "https://example.org/" } })

    expect([taken.status, await taken.json()]).toEqual([409, { code: "id_taken" }])
    expect((await rows()).map((row) => row.props)).toEqual([{ url: "https://example.com/" }])
  })

  test("keeps no page it wouldn't open: other schemes, credentials, the app itself, and frames that aren't https", async () => {
    const h = await open()
    const refused = [
      page("javascript:alert(document.cookie)"),
      page("data:text/html,<script>alert(1)</script>"),
      page("file:///etc/passwd", "link"),
      page("blob:https://example.com/uuid", "link"),
      page("https://user:secret@example.com/"),
      // The host the request came to, whatever its scheme, and a frame of its site or any http: page.
      page("https://chat.test/app"),
      page("https://chat.test/app", "link"),
      page("https://docs.chat.test/"),
      page("http://localhost:4000/"),
      page("http://example.com/", "link"),
    ]
    for (const view of refused) {
      const response = await add(h, view)
      expect([view.props.url, response.status, await response.json()]).toEqual([view.props.url, 400, { code: "refused" }])
    }
    expect(await rows()).toEqual([])
    expect(h.line("chat.view.add").filter((line) => line.annotations.status === 400).map((line) => line.annotations.reason))
      .toEqual(["scheme", "scheme", "scheme", "scheme", "credentials", "same_origin", "same_origin", "same_site", "insecure", "insecure"])
  })

  test("a deployment keeps https: pages alone; a link to http://localhost only where WEB_PAGES_LOCAL_HTTP says so", async () => {
    const local = page("http://localhost:4000/", "link")
    // Production's configuration: nothing set.
    const production = await add(await open(), local)
    expect([production.status, await production.json()]).toEqual([400, { code: "refused" }])
    // `alchemy dev` passes `true` as the default; a deployment would have to set it.
    const dev = await harness(runtime, () => Stream.empty, { actor: member, config: { WEB_PAGES_LOCAL_HTTP: "true" } })
    expect((await add(dev, local)).status).toBe(202)
    // Never a frame of it, whatever the setting: cookies aren't kept apart by port.
    expect((await add(dev, page("http://localhost:4000/"))).status).toBe(400)
    expect((await rows()).map((row) => row.props)).toEqual([{ url: "http://localhost:4000/" }])
  })

  test("WEB_PAGES_LOCAL_HTTP defaults to what the program passes, and the environment overrides it", () => {
    const read = (localHttp: boolean, env: Record<string, string>) =>
      Effect.runSync(
        Effect.gen(function* () { return yield* Views.localHttpConfig(localHttp) }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        ),
      )
    expect(read(false, {})).toBe(false)
    expect(read(true, {})).toBe(true)
    expect(read(true, { WEB_PAGES_LOCAL_HTTP: "false" })).toBe(false)
    expect(read(false, { WEB_PAGES_LOCAL_HTTP: "true" })).toBe(true)
  })

  test("refuses a body that isn't a view, or is too large, and any method but POST", async () => {
    const h = await open()
    for (
      const body of [
        "not json",
        { id: "not-a-uuid", template: "webpage", props: { url: "https://example.com/" } },
        { ...page("https://example.com/"), template: "iframe" },
        { ...page("https://example.com/"), props: {} },
        { ...page("https://example.com/"), props: { url: `https://example.com/${"x".repeat(2_048)}` } },
      ]
    ) {
      const response = await add(h, body)
      expect([response.status, await response.json()]).toEqual([400, { code: "invalid" }])
    }
    const large = await add(h, "x".repeat(MAX_GENERATED_BODY_BYTES + 1))
    expect([large.status, await large.json()]).toEqual([413, { code: "too_large" }])
    // Forms retain their smaller body limit when pages carry inline icons.
    const properties = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`field${index}`, { type: "string", title: "A field of the form" }]),
    )
    const form = { id: crypto.randomUUID(), template: "form", props: { title: "Big", schema: { type: "object", properties }, submitLabel: "Send" } }
    expect(JSON.stringify(form).length).toBeGreaterThan(MAX_VIEW_BODY_BYTES)
    const largeForm = await add(h, form)
    expect([largeForm.status, await largeForm.json()]).toEqual([413, { code: "too_large" }])
    const broken = await add(h, new Uint8Array([0x7b, 0xff, 0xfe]))
    expect([broken.status, await broken.json()]).toEqual([400, { code: "invalid" }])
    expect(h.line("chat.view.add").at(-1)?.annotations).toMatchObject({ status: 400, bytes: 3 })
    const get = await h.fetch("/api/views")
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
  })

  test("only a person who may ask adds a view: 401 signed out, 403 for a Guest or a person with no role", async () => {
    const view = page("https://example.com/")
    expect((await add(await open({ actor: null }), view)).status).toBe(401)
    for (const role of ["guest", null] as const) {
      const response = await add(await open({ actor: { ...member, role } }), view)
      expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
    }
    expect(await rows()).toEqual([])
  })

  test("Postgres unreachable answers 503, logged by its SQL reason, and no record carries the page", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
    const h = await harness(runtime, () => Stream.empty, { actor: member, database: unreachable })
    const sentinel = "sentinel-0c1d2e"

    const response = await add(h, page(`https://example.com/${sentinel}`))

    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(h.only("chat.view.add")).toMatchObject({
      level: "ERROR",
      annotations: { status: 503, errorCode: expect.stringMatching(/^sql:/) },
    })
    expect(h.span("chat.view.request")).toHaveLength(1)
    expect(recorded(h)).not.toContain(sentinel)
  })
})

// Every view belongs to one conversation (decision 0013 §1, docs/features/branch-workspace.md): a branch's, or the
// home conversation's.
describe("a view's conversation", () => {
  const REPO = "github/octocat/spoon-knife"

  /** A tracked branch of its own: its conversation's id. */
  const branchConversation = async () =>
    (await tracked(runtime, REPO, `views-${crypto.randomUUID().slice(0, 8)}`)).conversationId

  const conversationOf = async (viewId: string) =>
    (await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly conversationId: string }>`
        SELECT conversation_id AS "conversationId" FROM views WHERE id = ${viewId}`)))[0]?.conversationId

  test("a person's view goes to the conversation it names, or the home conversation when it names none", async () => {
    const h = await open()
    const conversation = await branchConversation()
    const named = { ...page("https://example.com/"), conversationId: conversation.toUpperCase() }
    const unnamed = page("https://example.org/")

    expect((await add(h, named)).status).toBe(202)
    expect((await add(h, unnamed)).status).toBe(202)

    const home = await runtime.runPromise(Conversations.home)
    expect([await conversationOf(named.id), await conversationOf(unnamed.id)]).toEqual([conversation, home])
    expect(h.line("chat.view.add").map((line) => line.annotations.conversationId)).toEqual([conversation, home])
  })

  test("someone else's branch takes a view only from the people it is shared with to edit: 403 otherwise", async () => {
    const h = await open()
    const theirs = await tracked(runtime, REPO, `theirs-${crypto.randomUUID().slice(0, 8)}`, "open", "person-owner")
    const named = () => ({ ...page("https://example.com/"), conversationId: theirs.conversationId })
    expect([(await add(h, named())).status]).toEqual([403])
    await shared(runtime, theirs.branchId, member.subject.id, "view")
    const viewer = await add(h, named())
    expect([viewer.status, await viewer.json()]).toEqual([403, { code: "forbidden" }])
    expect(await rows()).toEqual([])
    await shared(runtime, theirs.branchId, member.subject.id, "edit")
    expect((await add(h, named())).status).toBe(202)
  })

  test("a view waiting on a share revocation rechecks edit access before inserting", async () => {
    const h = await open()
    const branch = await tracked(runtime, REPO, `revoke-${crypto.randomUUID().slice(0, 8)}`, "open", "person-owner")
    await shared(runtime, branch.branchId, member.subject.id, "edit")
    const locked = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const revoke = runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT id FROM branches WHERE id = ${branch.branchId} FOR UPDATE`
        yield* sql`LOCK TABLE views IN SHARE MODE`
        yield* sql`DELETE FROM branch_shares WHERE branch_id = ${branch.branchId} AND grantee = ${member.subject.id}`
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(release)
      }))
    }))
    await runtime.runPromise(Deferred.await(locked))
    let completed = false
    const response = add(h, { ...page("https://example.com/"), conversationId: branch.conversationId })
      .then((value) => { completed = true; return value })
    try {
      // The old insert waits on the views table until revocation commits; corrected code waits before reading access.
      await eventually(async () => completed || await runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ waiting: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
            AND ((query LIKE '%branches%' AND query LIKE '%FOR UPDATE%') OR query LIKE '%INSERT INTO views%')
        ) AS waiting`
        return row!.waiting
      })))
    } finally {
      await runtime.runPromise(Deferred.succeed(release, undefined))
      await revoke
    }
    expect((await response).status).toBe(403)
    expect(await rows()).toEqual([])
    expect(h.line("chat.view.add").at(-1)?.annotations.status).toBe(403)
    expect(h.count(Views.requests, { status: "403" })).toBe(1)
  })

  test("a conversation that doesn't exist is 404, and nothing is kept", async () => {
    const h = await open()
    const response = await add(h, { ...page("https://example.com/"), conversationId: crypto.randomUUID() })
    expect([response.status, await response.json()]).toEqual([404, { code: "conversation_not_found" }])
    expect(await rows()).toEqual([])
  })

  test("an agent's view goes to its answer's conversation for the person who asked, whatever it names, and to nobody else", async () => {
    const h = await open()
    const conversation = await branchConversation()
    const question = {
      id: crypto.randomUUID(),
      answerId: crypto.randomUUID(),
      text: "Show me example.com",
      conversationId: conversation,
    }
    expect((await h.ask(question)).status).toBe(202)
    // The person's tab has moved home since; the answer's conversation still wins.
    const view = { ...page("https://example.com/"), answerId: question.answerId.toUpperCase() }
    expect((await add(h, view)).status).toBe(202)
    expect(await conversationOf(view.id)).toBe(conversation)

    const stranger = await open({ actor: { ...member, subject: { kind: "person", id: "person-stranger" } } })
    const theirs = await add(stranger, { ...page("https://example.org/"), answerId: question.answerId })
    expect([theirs.status, await theirs.json()]).toEqual([404, { code: "conversation_not_found" }])
    // A question's id is no answer.
    const notAnAnswer = await add(h, { ...page("https://example.org/"), answerId: question.id })
    expect(notAnAnswer.status).toBe(404)
    expect((await rows()).map((row) => row.id)).toEqual([view.id])
  })

  test("the same view resent to another conversation is 409: one id is one view in one conversation", async () => {
    const h = await open()
    const view = page("https://example.com/")
    expect((await add(h, view)).status).toBe(202)
    const moved = await add(h, { ...view, conversationId: await branchConversation() })
    expect([moved.status, await moved.json()]).toEqual([409, { code: "id_taken" }])
  })
})

// A `docs` view (docs/features/docs.md#the-docs-view): the write names a repository and a page's path; ChatApi reads the
// page from that repository's docs index and keeps its Markdown. GitHub is the outside web here, offline, so each
// repository's docs come from its curated home (worker/docs/Source.ts).
describe("a docs view", () => {
  const INDEX = "https://docs.example/llms.txt"
  const RETRYING = "# Retrying\n\nUse `retry` with a schedule.\n"
  const index = [
    "# Example",
    "- [Retrying](/guide/retrying.md): Retry a failing effect.",
    "- [Huge](/guide/huge.md): A long page.",
    "- [Gone](/guide/gone.md): A page the site lost.",
  ].join("\n")
  const curated = (repository: string, docs: string): CuratedFile => ({
    repository,
    defaultBranch: "main",
    home: { docs, blocks: [{ type: "text", text: "Curated" }] },
  })
  const site: Record<string, Page> = {
    [INDEX]: markdown(index),
    "https://docs.example/guide/retrying.md": markdown(RETRYING),
    // Each "é" is two bytes: the cut must not split one.
    "https://docs.example/guide/huge.md": markdown(`# Huge\n\n${"é".repeat(MAX_VIEW_TEXT_BYTES)}`),
    "https://chat.test/llms.txt": markdown("# Ours\n- [Page](/page.md)"),
    "https://chat.test/page.md": markdown("# Page"),
  }
  const docsOpen = (pages: Record<string, Page> = site) =>
    harness(runtime, () => Stream.empty, {
      actor: member,
      fetch: outsideWeb(pages),
      homes: [
        curated("acme/widgets", INDEX),
        curated("acme/offline", "https://offline.example/llms.txt"),
        curated("acme/ours", "https://chat.test/llms.txt"),
      ],
    })
  const docsView = (path: string, repository = "acme/widgets", extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    template: "docs",
    props: { url: `https://docs.example${path}`, title: "What the writer says", repository, path, ...extra },
  })

  test("keeps the page as the repository's index lists it, with its Markdown, never the writer's; a resend changes nothing", async () => {
    const h = await docsOpen()
    const view = docsView("/guide/retrying.md", "acme/widgets", { text: "Markdown the writer chose" })

    expect((await add(h, view)).status).toBe(202)

    expect((await rows()).map((row) => row.props)).toEqual([{
      url: "https://docs.example/guide/retrying.md",
      title: "Retrying",
      repository: "acme/widgets",
      path: "/guide/retrying.md",
      text: RETRYING,
    }])
    // The same page again under the same id, even once the site changed it, is the same view.
    const changed = await docsOpen({ ...site, "https://docs.example/guide/retrying.md": markdown("# Retrying, rewritten") })
    const again = await add(changed, view)
    expect([again.status, await again.json()]).toEqual([200, { txid: null }])
    // A resend after the site dropped the page, or went down, still finds the view it added: the site isn't asked.
    const gone = await docsOpen({ [INDEX]: site[INDEX]! })
    const late = await add(gone, view)
    expect([late.status, await late.json()]).toEqual([200, { txid: null }])
    const offline = await docsOpen({})
    expect((await add(offline, view)).status).toBe(200)
    // Another page under that id is another view.
    const other = await add(changed, { ...view, props: { ...view.props, path: "/guide/huge.md" } })
    expect([other.status, await other.json()]).toEqual([409, { code: "id_taken" }])
    expect(h.only("chat.view.add").annotations).toMatchObject({ template: "docs", status: 202, truncated: false })
  })

  test("keeps at most 64 KiB of a page's Markdown, cut between characters and marked truncated", async () => {
    const h = await docsOpen()
    expect((await add(h, docsView("/guide/huge.md"))).status).toBe(202)
    const [stored] = await rows()
    const props = stored!.props as { readonly text: string; readonly truncated?: boolean }
    expect(props.truncated).toBe(true)
    expect(new TextEncoder().encode(props.text).length).toBeLessThanOrEqual(MAX_VIEW_TEXT_BYTES)
    expect(props.text.endsWith("é")).toBe(true)
    expect(h.only("chat.view.add").annotations).toMatchObject({ truncated: true })
  })

  test("refuses a page the index doesn't list, docs it can't read, and a write that names no page", async () => {
    const h = await docsOpen()
    const answer = async (body: unknown) => {
      const response = await add(h, body)
      return [response.status, await response.json()]
    }
    expect(await answer(docsView("/guide/missing.md"))).toEqual([400, { code: "refused" }])
    expect(await answer(docsView("/guide/gone.md"))).toEqual([502, { code: "docs_unreachable" }])
    expect(await answer(docsView("/llms.txt", "acme/offline"))).toEqual([502, { code: "docs_unreachable" }])
    // GitHub is offline and Smithers curates nothing for it: nobody can say where its docs are now.
    expect(await answer(docsView("/guide/retrying.md", "acme/unknown"))).toEqual([503, { code: "unavailable" }])
    // A docs site on the app's own origin is never kept.
    expect(await answer(docsView("/page.md", "acme/ours"))).toEqual([400, { code: "refused" }])
    expect(await answer(docsView("/guide/retrying.md", "acme/widgets", { url: "https://chat.test/private" })))
      .toEqual([400, { code: "refused" }])
    for (
      const props of [
        { url: "https://docs.example/a.md", path: "/a.md" },
        { url: "https://docs.example/a.md", repository: "acme/widgets" },
        { url: "https://docs.example/a.md", repository: "app/widgets", path: "/a.md" },
        { url: "https://docs.example/a.md", repository: "acme", path: "/a.md" },
        { url: "https://docs.example/a.md", repository: "acme/widgets", path: "a.md" },
      ]
    ) {
      expect(await answer({ id: crypto.randomUUID(), template: "docs", props })).toEqual([400, { code: "invalid" }])
    }
    expect(await rows()).toEqual([])
    expect(h.line("chat.view.add").slice(0, 5).map((line) => line.annotations.reason)).toEqual([
      "page_not_found",
      "docs_unreachable",
      "docs_unreachable",
      "unavailable",
      "same_origin",
    ])
    expect(recorded(h)).not.toContain("/guide/")
  })

  test("a web page's write keeps no docs fields", async () => {
    const h = await docsOpen()
    const view = { ...page("https://example.com/", "link"), props: { url: "https://example.com/", repository: "a/b", path: "/x" } }
    expect((await add(h, view)).status).toBe(202)
    expect((await rows()).map((row) => row.props)).toEqual([{ url: "https://example.com/" }])
  })
})
