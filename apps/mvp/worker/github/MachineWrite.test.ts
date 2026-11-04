// Machine writes (worker/github/MachineWrite.ts): the token's scope and end at the route, the App as the author, the
// owner's one dispatcher, a failed write's way back, and `github/Write` left as it was.
import { digestSync } from "@smthrs/crypto"
import { Effect, Exit, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { writeExecutionId } from "../../src/features/issues/contract.ts"
import { attribution } from "../../src/features/issues/publicContent.mjs"
import { FlowStarter } from "../Flows.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Host from "./Host.ts"
import * as MachineWrite from "./MachineWrite.ts"
import { admit, reset, REPOSITORY, services, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { githubHarness } from "./test/harness.ts"
import { BOT_LOGIN, INSTALLATION_ID, scriptedGitHub as makeScriptedGitHub } from "./test/scriptedGitHub.ts"
import * as Write from "./Write.ts"

const githubs: Array<ReturnType<typeof makeScriptedGitHub>> = []
const scriptedGitHub: typeof makeScriptedGitHub = (...args) => {
  const github = makeScriptedGitHub(...args)
  githubs.push(github)
  return github
}
afterEach(() => {
  for (const github of githubs.splice(0)) {
    for (const call of github.calls) {
      expect(call.userAgent, `${call.method} ${call.path}`).toBe("smithers-integrations")
    }
  }
})

const runtime = testFile("github_machine_write")
beforeEach(() => reset(runtime))

const TOKEN = "smm_test-token"
const ROUTE = "/api/repos/acme/widgets/writes"
const ALL = "ARRAY['issue/create','issue/update','issue/comment','issue/relate','work/link']::text[]"
const issueToken = (values: { token?: string; repoId?: string; scope?: string; expires?: string; revoked?: string; agent?: string; lane?: string } = {}) =>
  sql(runtime, `INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at, revoked_at)
    VALUES ('${digestSync(values.token ?? TOKEN)}', '${values.repoId ?? REPOSITORY.id}', '${values.agent ?? "fixer"}', '${values.lane ?? "lane-1"}',
      ${values.scope ?? ALL}, 'test', ${values.expires ?? "now() + interval '1 day'"}, ${values.revoked ?? "NULL"})`)
const post = (body: unknown, token = TOKEN) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const create = (fields: object = {}) => ({ writeId: crypto.randomUUID(), op: "issue/create", title: "Lint panics", body: "What and why.", ...fields })
const machineOf = (lane = "lane-1", token = TOKEN): MachineWrite.Machine => ({ agent: "fixer", lane, scope: [], tokenSha256: digestSync(token) })
const admitAs = (body: unknown, machine = machineOf()) => runtime.runPromise(MachineWrite.admit({ repoId: REPOSITORY.id, owner: "acme", machine, body: body as MachineWrite.MachineBody }))
const row = async (id: string) =>
  ((await sql(runtime, `SELECT *, item_number AS number FROM machine_writes WHERE id = '${id}'`)) as unknown as Array<Record<string, unknown>>)[0]!
/** Lets the next call go at once. */
const clear = () => sql(runtime, `UPDATE machine_dispatch SET next_at = now() - interval '1 second'`)
const posting = (pattern: RegExp) => (method: string, path: string) => method === "POST" && pattern.test(path)
/** The owner's dispatcher, as tests drive it: one tick at a time, on the epoch `launch` answers. */
const dispatcher = async (github: ReturnType<typeof scriptedGitHub>) => {
  const { services: value } = await services(runtime, github)
  const { tick } = MachineWrite.steps(value)
  const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
  let round = 0
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  ))
  return {
    logs,
    run,
    value,
    epoch,
    tick: () => run(tick({ owner: "acme", epoch, round: round++, waitMs: 0 })),
    /** The next tick with any hold lifted, as the time passing would. */
    next: async () => {
      await clear()
      return run(tick({ owner: "acme", epoch, round: round++, waitMs: 0 }))
    },
  }
}

describe("a machine token at the route", () => {
  test("files within its scope, on its repository, until it ends", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    expect(h.starts).toEqual([{ flow: "github/MachineDispatch", executionId: MachineWrite.dispatchExecutionId("acme", 1), payload: MachineWrite.dispatchPayload("acme", 1) }])
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect((await h.fetch(ROUTE, post({ ...write, title: "Other" }))).status).toBe(409)
    await sql(runtime, `UPDATE machine_writes SET status = 'done', item_number = 7 WHERE id = '${write.writeId}'`)
    const status = await h.fetch(`${ROUTE}/${write.writeId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await status.json()).toEqual({ status: "done", failure: null, cause: null, githubStatus: null, number: 7 })
  })

  test("refuses a token that is unknown, expired, revoked, on another repository or out of scope", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken({ token: "smm_expired", expires: "now() - interval '1 second'" })
    await issueToken({ token: "smm_revoked", revoked: "now()" })
    await issueToken({ token: "smm_elsewhere", repoId: "github/acme/other" })
    await issueToken({ token: "smm_narrow", scope: "ARRAY['issue/comment']::text[]" })
    for (const token of ["smm_nobody", "smm_expired", "smm_revoked", "smm_elsewhere"]) expect((await h.fetch(ROUTE, post(create(), token))).status).toBe(401)
    expect((await h.fetch(ROUTE, post(create(), "smm_narrow"))).status).toBe(403)
    expect(h.starts).toEqual([])
  })

  test("validates label metadata and refuses reserved names and private descriptions at admission", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    for (const label of [{ name: "" }, { name: "x".repeat(51) }, { name: "tree", color: "#ffffff" }, { name: "tree", color: "xyzxyz" }, { name: "tree", description: "x".repeat(101) }, { name: "tree", description: 1 }]) {
      expect((await h.fetch(ROUTE, post(create({ labels: [label] })))).status).toBe(400)
    }
    expect((await h.fetch(ROUTE, post(create({ labels: [{ name: " SMITHERS:accepted" }] })))).status).toBe(403)
    // A name that is only whitespace is no name.
    expect((await h.fetch(ROUTE, post(create({ labels: [{ name: "  " }] })))).status).toBe(400)
    expect((await h.fetch(ROUTE, post(create({ labels: [{ name: "tree", description: "/Users/private/file" }] })))).status).toBe(422)
    expect((await h.fetch(ROUTE, post(create({ labels: ["bug", { name: "tree", description: "" }] })))).status).toBe(202)
  })

  test("a token revoked or expired while its body arrived admits nothing", async () => {
    await issueToken()
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    expect(await admitAs(create())).toEqual({ kind: "token" })
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = NULL, expires_at = now() - interval '1 second'`)
    expect(await admitAs(create())).toEqual({ kind: "token" })
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_writes")).toEqual([{ count: 0 }])
    await sql(runtime, `UPDATE machine_tokens SET expires_at = now() + interval '1 day'`)
    const links = { links: [{ kind: "queue", ref: "q-1" }] } as never
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    const { write } = await import("./WorkLinks.ts")
    const written = await runtime.runPromise(write(REPOSITORY.id, 3, links, "machine:fixer/lane-1", Date.now(), undefined, { tokenSha256: digestSync(TOKEN) }))
    expect(written._tag).toBe("None")
  })

  test("a person-only act with the same token is refused: triage does not parse, a policy label is refused", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    expect((await h.fetch(ROUTE, post({ writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" }))).status).toBe(400)
    expect((await h.fetch(ROUTE, post({ writeId: crypto.randomUUID(), op: "pr/merge", number: 1, headSha: "a", baseSha: "b" }))).status).toBe(400)
    for (const label of ["smithers:accepted", "smithers:not-accepted", "smithers:commit-now", "SMITHERS:Commit-Next", " smithers:accepted"]) {
      expect((await h.fetch(ROUTE, post(create({ labels: ["bug", label] })))).status, label).toBe(403)
    }
    expect((await h.fetch(ROUTE, post(create({ labels: ["bug", "migrate:alchemy"] })))).status).toBe(202)
    expect(h.starts).toHaveLength(1)
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM github_writes")).toEqual([{ count: 0 }])
  })

  test("refuses credential-shaped text and home paths in anything it would publish, naming the kind only", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const secret = `smm_${"a".repeat(43)}`
    for (const [fields, reason] of [
      [{ body: `leaked ${secret}` }, "credential"],
      [{ title: `leaked ${secret}` }, "credential"],
      [{ labels: [secret] }, "credential"],
      [{ body: "ghp_0123456789abcdefABCDEF0123" }, "credential"],
      [{ body: "see /Users/someone/work/x" }, "home_path"],
      [{ body: "see /home/lane/vibe and more" }, "home_path"],
      [{ body: "see ~/lanes/fix" }, "home_path"],
    ] as const) {
      const response = await h.fetch(ROUTE, post(create(fields)))
      expect(response.status).toBe(422)
      const answer = await response.text()
      expect(JSON.parse(answer)).toEqual({ code: "public_content", reason })
      expect(answer).not.toContain(secret)
    }
    // A repository path with `home` in it is no home path.
    expect((await h.fetch(ROUTE, post(create({ body: "packages/website/src/page/home/x.ts" })))).status).toBe(202)
    const links = { links: [{ kind: "queue", ref: secret }] }
    expect((await h.fetch(`/api/repos/acme/widgets/issues/3/links`, post(links))).status).toBe(400)
  })

  test("finds a credential or home path written plainly or encoded; Markdown and HTML are filed literally", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const secret = `smm_${"a".repeat(43)}`
    for (const body of [`_${secret}_`, `*${secret}*`, `x${secret}`, `https://x.test/?a=%73mm%5f${"a".repeat(43)}`, `https://x.test/?a=%2573mm%255f${"a".repeat(43)}`, `&#115;mm_${"a".repeat(43)}`, `&#x73;mm_${"a".repeat(43)}`, `SMM_${"a".repeat(43)}`]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(422)
    }
    const t = "a".repeat(43)
    // A home path or credential the page shows, written plainly or encoded, is refused.
    // A backslash a reader can see past still names the token: `smm\\_…`.
    for (const body of [`smm\\_${t}`, "_/Users/someone/private.txt_", "*~/notes*", "`/home/someone/x`", "x\\~%2fnotes", "%24HOME/confidential/notes", "${HOME}/notes",
      "&#36;HOME/private.txt", "%7E%2Flane%2Fprivate.txt", "password&#58; abcdefghijklmnop", "&#126;/confidential/notes", "xsk-abcdefghijklmnop x%73k-abcdefghijklmnop"]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(422)
    }
    // Markdown and HTML are filed escaped, so they show as written, never as a token: accepted, and literal on the page.
    for (const body of [`**smm**_${t}`, `smm_**${t}**`, `sm**m**_${t}`, `smm_\`${t}\``, `smm<!--x-->_${t}`, `<div>smm&lowbar;aaaaaaaaaaaaaaaa</div>`, "<b>x</b>", "&copy; me"]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(202)
    }
    // Literal punctuation inside words is not Markdown, and is not refused.
    for (const body of ["token_initialization", "token*initialization", "token`initialization", "packages/foo_/home/x.ts", "a*b*c and snake_case_name"]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(202)
    }
    expect((await h.fetch(ROUTE, post(create({ body: "100%25 of the smm_ prefix" })))).status).toBe(202)
  })

  test("the content check is linear: a 65,000-character body is read in well under a second", () => {
    const started = performance.now()
    expect(MachineWrite.publicContentProblem(["a".repeat(65_000)])).toBeUndefined()
    // Bodies built to make a pattern retry from every position, or a parser quadratic.
    for (const text of ["eyJ".repeat(21_666), "[a]".repeat(21_666), `<a${"-a".repeat(32_491)} title="<">`, "%25".repeat(21_666), "\\_".repeat(32_500), "smm".repeat(21_666), "-a".repeat(32_500), "a.".repeat(32_500)]) {
      MachineWrite.publicContentProblem([text])
    }
    expect(MachineWrite.publicContentProblem([`${"a".repeat(64_000)}://u:p@h`])).toBe("credential")
    // A scheme after digits or scheme punctuation is still a scheme: the shape refused these before it was made linear.
    for (const text of ["-https://u:p@h", ".https://u:p@h", "+https://u:p@h", "0https://u:p@h", "%2Dhttps://u:p@h", `${"-a".repeat(32_000)}://u:p@h`]) {
      expect(MachineWrite.publicContentProblem([text]), text.slice(0, 20)).toBe("credential")
    }
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("a write id's casing is the same write", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    const first = await h.fetch(ROUTE, post({ ...write, writeId: write.writeId.toUpperCase() }))
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ writeId: write.writeId })
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(await sql(runtime, "SELECT id::text AS id FROM machine_writes")).toEqual([{ id: write.writeId }])
    expect((await h.fetch(`${ROUTE}/${write.writeId.toUpperCase()}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    // A retry answers the canonical id, however the path spelled it.
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    const again = await h.fetch(`${ROUTE}/${write.writeId.toUpperCase()}/retry`, post({}))
    expect(await again.json()).toEqual({ writeId: write.writeId, status: "pending" })
  })

  test("a sub-issue across repositories needs this agent and lane to hold the parent's repository too", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const relate = () => ({ writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/plan", number: 1 } })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_other-lane", repoId: "github/acme/plan", lane: "lane-2" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_narrow", repoId: "github/acme/plan", scope: "ARRAY['issue/create']::text[]" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(202)
    // The same repository needs no second token.
    expect((await h.fetch(ROUTE, post({ ...relate(), parent: { repo: "acme/widgets", number: 1 } }))).status).toBe(202)
  })

  test("a write belongs to its agent and lane: another lane can't read or resubmit it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    expect((await h.fetch(ROUTE, post(write, "smm_lane-2"))).status).toBe(409)
    expect((await h.fetch(`${ROUTE}/${write.writeId}`, { headers: { authorization: "Bearer smm_lane-2" } })).status).toBe(404)
  })

  test("one token's backlog is bounded, and a settled write frees its place", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const first = create()
    expect((await h.fetch(ROUTE, post(first))).status).toBe(202)
    for (let i = 1; i < MachineWrite.MAX_BACKLOG; i++) expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
    const refused = await h.fetch(ROUTE, post(create()))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("30")
    // The same write again still answers, and another token has its own bound.
    expect((await h.fetch(ROUTE, post(first))).status).toBe(200)
    expect((await h.fetch(ROUTE, post(create(), "smm_lane-2"))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'done' WHERE id = '${first.writeId}'`)
    expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
  })

  test("work links: within scope, as the machine, and never over another source's link", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_narrow", scope: "ARRAY['issue/create']::text[]" })
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const route = "/api/repos/acme/widgets/issues/3/links"
    const links = (state: string, at: string) => ({ links: [{ kind: "queue", ref: "q-1", state, at }] })
    const soon = (ms: number) => new Date(Date.now() - 60_000 + ms).toISOString()
    expect((await h.fetch(route, post(links("queued", soon(0)), "smm_narrow"))).status).toBe(403)
    expect((await h.fetch(route, post(links("queued", soon(0))))).status).toBe(200)
    const answer = await h.fetch(route, post(links("failed", soon(1000)), "smm_lane-2"))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ changed: 0 })
    expect(await sql(runtime, "SELECT source, state FROM work_links")).toEqual([{ source: "machine:fixer/lane-1", state: "queued" }])
    expect((await h.fetch(route, post(links("passed", soon(2000))))).status).toBe(200)
    expect(await sql(runtime, "SELECT source, state FROM work_links")).toEqual([{ source: "machine:fixer/lane-1", state: "passed" }])
  })
})

describe("what a machine writes renders as written", () => {
  const ascii = Array.from({ length: 127 - 33 }, (_, i) => String.fromCharCode(33 + i))
  const punctuation = ascii.filter((c) => !/[A-Za-z0-9]/.test(c))

  test("mentions and issue references can't fire, and indented lines never become code that shows the escapes", () => {
    const joiner = "\u2060"
    expect(MachineWrite.escapeMarkdown("ping @someone about #12 and GH-3")).toBe(`ping \\@${joiner}someone about \\#${joiner}12 and GH\\-${joiner}3`)
    // Leading spaces and tabs become numeric entities, which no block rule reads as indentation.
    expect(MachineWrite.escapeMarkdown("    a.b\n\tc")).toBe("&#32;&#32;&#32;&#32;a\\.b\n&#9;c")
    // A bare commit id GitHub would shorten into a link: a word joiner inside it, in every hex run of 7 or more.
    expect(MachineWrite.escapeMarkdown("a877b78446d1879df196773d9cfaf461cbc247df and 0123abc")).toBe(`a877${joiner}b78446d1879df196773d9cfaf461cbc247df and 0123${joiner}abc`)
  })

  test("a body whose filed form would pass GitHub's 65,536 characters is refused before it is admitted", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    expect((await h.fetch(ROUTE, post(create({ body: ".".repeat(40_000) })))).status).toBe(413)
    // Measured with the attribution this agent and lane get: the longest names, all colons, push a body over.
    const named = `smm_${"n".repeat(43)}`
    await issueToken({ token: named, agent: ":".repeat(100), lane: ":".repeat(100) })
    expect((await h.fetch(ROUTE, post(create({ body: "x".repeat(65_000) }), named))).status).toBe(413)
    expect((await h.fetch(ROUTE, post(create({ body: ".".repeat(30_000) })))).status).toBe(202)
    // Exactly at the limit once filed is admitted: the measure is the assembled body, to the character.
    const room = 65_536 - attribution("fixer", "lane-1").length - "\n\n<!-- smithers:write=00000000-0000-0000-0000-000000000000 -->".length
    // A dot files as two characters, so the body stays under the route's own 65,000 while its filed form meets the limit.
    expect((await h.fetch(ROUTE, post(create({ body: ".".repeat(Math.floor(room / 2)) })))).status).toBe(202)
    expect((await h.fetch(ROUTE, post(create({ body: ".".repeat(Math.floor(room / 2) + 1) })))).status).toBe(413)
  })

  test("every ASCII punctuation character is escaped, and nothing else", () => {
    expect(punctuation).toHaveLength(32)
    const joiner = "\u2060"
    // A word joiner after `@`, `#` and `:` and before `$`: GitHub's own renderer showed mentions, references, emoji
    // and math firing through a backslash (ops/issues/render-fixtures.json).
    expect(MachineWrite.escapeMarkdown(punctuation.join(""))).toBe(punctuation.map((c) => (c === "$" ? `${joiner}\\$` : `\\${c}${"@#:".includes(c) ? joiner : ""}`)).join(""))
    expect(MachineWrite.escapeMarkdown("plain words, then\na line")).toBe("plain words\\, then\na line")
  })

  test("each reviewer's case is filed as literal text, and the plain forms are caught before it", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const d = await dispatcher(github)
    const t = "a".repeat(43)
    // Each renders on GitHub exactly as written: escaped, nothing joins, links, decodes or mentions.
    const cases: Array<[string, string]> = [
      [`[sm](https://example.com)m_${t}`, `\\[sm\\]\\(https\\:\u2060\\/\\/example\\.com\\)m\\_${t}`],
      [`sm**m**_${t}`, `sm\\*\\*m\\*\\*\\_${t}`],
      ["<b>x</b> &copy; @someone #12", "\\<b\\>x\\<\\/b\\> \\&copy\\; \\@\u2060someone \\#\u206012"],
      ["~/**notes**", "\\~\\/\\*\\*notes\\*\\*"],
    ]
    for (const [body, escaped] of cases) {
      const write = create({ title: "Literal", body }) as { writeId: string }
      expect(await admitAs(write), body).toEqual({ kind: "inserted" })
      await d.next()
      const made = [...github.issues.values()].at(-1)!
      expect(made.body!.startsWith(`${escaped}\n\nFiled by`), body).toBe(true)
    }
  })

  test("the plain forms of what a page could have shown are refused at the route", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const t = "ab_".repeat(14) + "A"
    for (const body of [`smm_${t}`, `sk-${"a".repeat(48)}`, `ghp_${"a".repeat(36)}`, `_eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, `xeyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, `.eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, `log.eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, `&#00000000115;mm_${"a".repeat(43)}`, `&#x0000000073;mm_${"a".repeat(43)}`,
      `smm_\u2060${"a".repeat(43)}`, `sm\ufeffm_${"a".repeat(43)}`, `smm_%E2%81%A0${"a".repeat(43)}`, "/Us\u2060ers/alice/private.txt", "/home\u200d/alice/x",
      "file:///Users/alice/private.txt", "file:///home/alice/.ssh/id_ed25519", "file://localhost/home/alice/x", "FILE://build-host/Users/alice/x", "/home/alice/private.txt", "~/notes", "$HOME/x", "%2FUsers%2Fsomeone%2Fx", "&#36;HOME/private.txt"]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(422)
    }
    // Titles show code spans: a backtick is refused there.
    const titled = await h.fetch(ROUTE, post(create({ title: "Lint `panics`" })))
    expect(titled.status).toBe(422)
    expect(await titled.json()).toEqual({ code: "public_content", reason: "markup" })
    // Prose that only looked like a trick before is filed as it is.
    for (const body of ["We use **token** initialization.", "token_initialization", "packages/foo_/home/x.ts", "R&D and A & B"]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(202)
    }
  })
})

describe("github/MachineDispatch", () => {
  test.each(["issue/create", "issue/relate"] as const)("logs a done %s once with ids only", async (op) => {
    await issueToken()
    const github = scriptedGitHub()
    const d = await dispatcher(github)
    const fields = { title: "Private completion title", body: "Private completion body", labels: ["private-label"] }
    github.labels.set(fields.labels[0]!, { name: fields.labels[0]!, color: "ededed", description: "" })
    const finish = async (write: { writeId: string }) => {
      await admitAs(write)
      for (let i = 0; i < 5 && (await row(write.writeId)).status === "pending"; i++) await d.next()
      expect(await row(write.writeId)).toMatchObject({ status: "done" })
    }
    if (op === "issue/relate") {
      await finish(create(fields))
      await finish(create(fields))
      d.logs.length = 0
    }
    const write = op === "issue/create"
      ? create(fields)
      : { writeId: crypto.randomUUID(), op, number: 2, parent: { repo: "acme/widgets", number: 1 } }
    await finish(write)
    const number = op === "issue/create" ? 1 : 2
    expect(await row(write.writeId)).toMatchObject({ status: "done", number })
    await d.next()
    const logs = d.logs.filter((log) => log.message === "github.machine_write.done")
    expect(logs.map((log) => ({ level: log.level, ...log.annotations }))).toEqual([
      { level: "INFO", writeId: write.writeId, op, number, agent: "fixer", lane: "lane-1" },
    ])
    const recorded = JSON.stringify(d.logs)
    for (const value of [fields.title, fields.body, fields.labels[0], TOKEN]) expect(recorded).not.toContain(value)
  })

  test.each([
    { name: "missing", existing: false, race: false, lost: false },
    { name: "existing", existing: true, race: false, lost: false },
    { name: "concurrently created (422 already_exists)", existing: false, race: true, lost: false },
    { name: "created with a lost answer", existing: false, race: false, lost: true },
  ])("ensures a $name label before the issue POST through the paced User-Agent seam", async ({ existing, race, lost }) => {
    await issueToken()
    const github = scriptedGitHub()
    const label = { name: "migrate:t3code/tree", color: "aabbcc", description: "Migration tree" }
    if (existing) github.labels.set(label.name.toLowerCase(), label)
    if (race) github.faults.push({ match: posting(/^\/repos\/acme\/widgets\/labels$/), hold: async () => { github.labels.set(label.name.toLowerCase(), label) } })
    if (lost) github.faults.push({ match: posting(/^\/repos\/acme\/widgets\/labels$/), lost: true })
    const write = create({ labels: [label.name] })
    await admitAs(write)
    const d = await dispatcher(github)
    await d.tick()
    expect(github.seen("GET", /\/labels\/migrate%3At3code%2Ftree$/)).toHaveLength(1)
    if (!existing) {
      expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
      expect(github.seen("POST", /^\/repos\/acme\/widgets\/labels$/)).toHaveLength(1)
      const before = github.calls.length
      const held = await d.tick()
      expect(held.waitMs).toBeGreaterThan(0)
      expect(github.calls).toHaveLength(before)
    }
    for (let i = 0; i < 4 && (await row(write.writeId)).status === "pending"; i++) await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.seen("POST", /^\/repos\/acme\/widgets\/labels$/)).toHaveLength(existing ? 0 : 1)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(github.issues.get(1)!.labels).toEqual([label.name])
    expect(github.labels.get(label.name.toLowerCase())).toEqual(existing || race ? label : { name: label.name, color: "ededed", description: "" })
    for (const request of github.calls) expect(request.userAgent).toBe("smithers-integrations")
  })

  test("a label POST permission 403 settles refused with its stored GitHub cause", async () => {
    await issueToken()
    const github = scriptedGitHub()
    github.faults.push({ match: posting(/^\/repos\/acme\/widgets\/labels$/), status: 403, message: "Resource not accessible by integration" })
    const write = create({ labels: ["tree"] })
    await admitAs(write)
    const d = await dispatcher(github)
    await d.tick()
    expect(await row(write.writeId)).toMatchObject({ status: "refused", failure: "not_allowed", cause: "github_status:403", github_status: 403 })
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
    expect(d.logs.filter((log) => log.message === "github.machine_write.refused").map((log) => log.annotations)).toContainEqual({ writeId: write.writeId, outcome: "refused", failure: "not_allowed", cause: "github_status:403", githubStatus: 403 })
  })

  test.each([
    { name: "lookup permission refusal", method: "GET", status: 403, expected: "refused", cause: "github_status:403" },
    { name: "unrelated label validation failure", method: "POST", status: 422, expected: "refused", cause: "github_status:422" },
    { name: "lookup outage", method: "GET", status: 503, expected: "pending", cause: null },
    { name: "lookup rate limit", method: "GET", status: 429, expected: "pending", cause: null },
    { name: "creation rate limit", method: "POST", status: 429, expected: "pending", cause: null },
  ])("a $name stops before the issue and preserves the hold or stored cause", async ({ method, status, expected, cause }) => {
    await issueToken()
    const github = scriptedGitHub()
    github.faults.push({ match: (verb, path) => verb === method && (method === "GET" ? path.endsWith("/labels/tree") : path === "/repos/acme/widgets/labels"), status })
    const write = create({ labels: [{ name: "tree" }] })
    await admitAs(write)
    const d = await dispatcher(github)
    await d.tick()
    expect(await row(write.writeId)).toMatchObject({ status: expected, cause, github_status: expected === "refused" ? status : null })
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
    if (expected === "pending") {
      const calls = github.calls.length
      expect((await d.tick()).waitMs).toBeGreaterThan(0)
      expect(github.calls).toHaveLength(calls)
      if (status === 429) expect(await row(write.writeId)).toMatchObject({ tries: 0 })
      for (let i = 0; i < 4 && (await row(write.writeId)).status === "pending"; i++) await d.next()
      expect(await row(write.writeId)).toMatchObject({ status: "done" })
      expect(github.labels.get("tree")).toEqual({ name: "tree", color: "ededed", description: "" })
    }
  })

  test("an untrimmed label name is created and applied under its trimmed name, so the write finishes", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create({ labels: [" tree ", { name: "area ", color: "123ABC" }] })
    const h = await githubHarness(runtime, { actor: null })
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    // The payload is stored as sent, so the same request again is the same write, not a conflict.
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    const d = await dispatcher(github)
    for (let i = 0; i < 8 && (await row(write.writeId)).status === "pending"; i++) await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect([...github.labels.keys()].sort()).toEqual(["area", "tree"])
    expect(github.seen("GET", /\/labels\/(%20|.*%20)/)).toHaveLength(0)
  })

  test("a write stored with an untrimmed label before trimming existed still finishes, and its resubmission is the same write", async () => {
    await issueToken()
    const github = scriptedGitHub()
    // Stored as a write admitted before label names were trimmed: straight through admit, untrimmed.
    const write = create({ labels: ["tree "] })
    await admitAs(write)
    const h = await githubHarness(runtime, { actor: null })
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    const d = await dispatcher(github)
    for (let i = 0; i < 8 && (await row(write.writeId)).status === "pending"; i++) await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect([...github.labels.keys()]).toEqual(["tree"])
    expect(github.seen("GET", /\/labels\/tree%20$/)).toHaveLength(0)
  })

  test("creates metadata labels and all twenty labels without spending the issue's retry budget", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const labels = Array.from({ length: 20 }, (_, i) => ({ name: `label-${i}`, color: "123ABC", description: `Label ${i}` }))
    const write = create({ labels })
    const h = await githubHarness(runtime, { actor: null })
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    const d = await dispatcher(github)
    for (let i = 0; i < 24 && (await row(write.writeId)).status === "pending"; i++) await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.seen("POST", /^\/repos\/acme\/widgets\/labels$/)).toHaveLength(20)
    for (const label of labels) expect(github.labels.get(label.name)).toEqual(label)
  })

  // A real flow: its second round sleeps the real 7.5 s spacing after the send, so it needs more than the default 30 s
  // on a loaded host.
  test("the flow runs the queue to empty and stops: the App is the author, the body says which agent, labels go on", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create({ labels: ["migrate:alchemy"] }) as { writeId: string }
    await admitAs(write)
    const { services: value } = await services(runtime, github)
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    const ran = await runFlow(MachineWrite.MachineDispatch, MachineWrite.dispatchPayload("acme", epoch), MachineWrite.registration(value), { executionId: MachineWrite.dispatchExecutionId("acme", epoch), maxConnections: 3 })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const made = github.issues.get(1)!
    expect(made.login).toBe(BOT_LOGIN)
    expect(made.body).toContain("What and why\\.\n\nFiled by the agent fixer, lane lane\\-1\\.")
    expect(made.labels).toContain("migrate:alchemy")
    expect(github.seen("POST", /\/issues$/).map((call) => call.token)).toEqual(["installation"])
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(await sql(runtime, "SELECT running FROM machine_dispatch")).toEqual([{ running: false }])
  }, 120_000)

  test("recovers its own issue by its marker, and files a sub-issue, looking first", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const parent = create() as { writeId: string }
    await admitAs(parent)
    // The answer to the first POST is lost: GitHub made it, and the next tick finds it instead of making another.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    expect(github.issues.size).toBe(1)
    await d.next()
    expect(await row(parent.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)

    const child = create({ title: "Child" }) as { writeId: string }
    await admitAs(child)
    await d.next()
    const relate = (number: number) => ({ writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/widgets", number } })
    const first = relate(1)
    await admitAs(first)
    await d.next()
    expect(await row(first.writeId)).toMatchObject({ status: "done" })
    expect(github.subIssueParents.get(2)).toBe(1)
    const posts = github.seen("POST", /sub_issues$/).length
    const again = relate(1)
    await admitAs(again)
    await d.next()
    expect(await row(again.writeId)).toMatchObject({ status: "done" })
    expect(github.seen("POST", /sub_issues$/)).toHaveLength(posts)
    const other = relate(9)
    await admitAs(other)
    await d.next()
    expect(await row(other.writeId)).toMatchObject({ status: "refused", failure: "has_parent" })
  })

  test("a sub-issue across repositories mints one token for both repositories, Issues: write only", async () => {
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    await sql(runtime, `INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/acme/plan', ${INSTALLATION_ID})`)
    const github = scriptedGitHub()
    const child = github.open("Child", "What and why.")
    // GitHub reads `sub_issue_id` with the parent's token: a token that can't see the child's repository is refused.
    const reaches: Array<ReadonlyArray<string>> = []
    const http = HttpClient.make((request, url) => {
      if (request.method !== "POST" || url.pathname !== "/repos/acme/plan/issues/1/sub_issues") return github.http.execute(request)
      const bearer = request.headers["authorization"]?.replace(/^Bearer /, "")
      const repositories = (github.minted.find((minted) => minted.token === bearer)?.body as { repositories?: ReadonlyArray<string> } | undefined)?.repositories ?? []
      reaches.push(repositories)
      const sees = repositories.includes("plan") && repositories.includes("widgets")
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(sees ? { number: 1 } : { message: "Resource not accessible by integration" }, { status: sees ? 201 : 403 })))
    })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: child.number, parent: { repo: "acme/plan", number: 1 } }
    await admitAs(relate)
    const d = await dispatcher({ ...github, http })
    await d.tick()
    expect(await row(relate.writeId)).toMatchObject({ status: "done", failure: null, cause: null, number: child.number })
    expect(reaches).toEqual([["plan", "widgets"]])
    expect(github.minted.at(-1)!.body).toEqual({ repositories: ["plan", "widgets"], permissions: { issues: "write" } })
  })

  test("a sub-issue in its own repository mints for that one repository", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const parent = github.open("Parent", "What and why.")
    const child = github.open("Child", "What and why.")
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: child.number, parent: { repo: "acme/widgets", number: parent.number } }
    await admitAs(relate)
    const d = await dispatcher(github)
    await d.tick()
    expect(await row(relate.writeId)).toMatchObject({ status: "done" })
    expect(github.subIssueParents.get(child.number)).toBe(parent.number)
    expect(github.minted.map((minted) => minted.body)).toEqual([
      { repositories: ["widgets"], permissions: { issues: "write" } },
      { repositories: ["widgets"], permissions: { issues: "write" } },
    ])
  })

  test("F1 a pending write stops when its token, or its parent's, is revoked", async () => {
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const github = scriptedGitHub()
    const first = create() as { writeId: string }
    await admitAs(first)
    const d = await dispatcher(github)
    await d.tick()
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    await admitAs(relate)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now() WHERE repo_id = 'github/acme/plan'`)
    await d.next()
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "revoked" })
    const second = create() as { writeId: string }
    await admitAs(second)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    await d.next()
    expect(await row(second.writeId)).toMatchObject({ status: "refused", failure: "revoked" })
    expect(github.seen("POST", /sub_issues$/)).toHaveLength(0)
  })

  test("F2 update: only the lane that filed it, and only what this App wrote", async () => {
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    await d.tick()

    const laneTwo = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(laneTwo, machineOf("lane-2", "smm_lane-2"))
    await d.next()
    expect(await row(laneTwo.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })

    const update = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, title: "Renamed", body: "New words.", state: "closed" }
    await admitAs(update)
    await d.next()
    expect(await row(update.writeId)).toMatchObject({ status: "done", number: 1 })
    const made = github.issues.get(1)!
    expect(made).toMatchObject({ title: "Renamed", state: "closed" })
    expect(made.body).toContain("New words\\.")
    const [{ recovery }] = (await sql(runtime, `SELECT recovery_id::text AS recovery FROM machine_writes WHERE id = '${write.writeId}'`)) as unknown as Array<{ recovery: string }>
    expect(made.body).toContain(`<!-- smithers:write=${recovery} -->`)
    expect(made.body).not.toContain(write.writeId)

    // Another App's bot, even on an issue the row says this lane filed.
    ;(made as { login: string | null }).login = "other-app[bot]"
    const other = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    await admitAs(other)
    await d.next()
    expect(await row(other.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
  })

  test("F5 a 2xx with truncated JSON costs a try, and the next tick finds the issue by its marker; a poison write settles", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), malformed: true })
    const d = await dispatcher(github)
    expect(await d.tick()).toMatchObject({ stop: false })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    // A write that keeps not finishing settles `failed`, and the queue goes on to the next.
    const stuck = create({ title: "Stuck" }) as { writeId: string }
    await admitAs(stuck)
    await sql(runtime, `UPDATE machine_writes SET tries = ${MachineWrite.MAX_TRIES} WHERE id = '${stuck.writeId}'`)
    const after = create({ title: "After" }) as { writeId: string }
    await admitAs(after)
    await d.next()
    expect(await row(stuck.writeId)).toMatchObject({ status: "failed", failure: "exhausted", cause: "exhausted", github_status: null })
    await d.next()
    expect(await row(after.writeId)).toMatchObject({ status: "done" })
  })

  test("a token GitHub won't give for the parent right now keeps the write; only a real refusal settles it", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const parent = create() as { writeId: string }
    await admitAs(parent)
    const child = create({ title: "Child" }) as { writeId: string }
    await admitAs(child)
    const d = await dispatcher(github)
    await d.tick()
    await d.next()
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/widgets", number: 1 } }
    await admitAs(relate)
    // The child's token comes first and the parent's second, so each case fails the second mint.
    const failingSecond = (failure: object) => {
      let mints = 0
      return MachineWrite.steps({
        ...value,
        tokens: { ...value.tokens, forInstallation: (...args: Parameters<typeof value.tokens.forInstallation>) => (++mints === 2 ? Effect.fail(failure) : value.tokens.forInstallation(...args)) } as never,
      })
    }
    await clear()
    await Effect.runPromise(failingSecond({ reason: "rate_limited", retryAfterMillis: 600_000 }).tick({ owner: "acme", epoch: d.epoch, round: 100, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "pending" })
    await clear()
    await Effect.runPromise(failingSecond({ reason: "outage" }).tick({ owner: "acme", epoch: d.epoch, round: 101, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "pending" })
    await clear()
    await Effect.runPromise(failingSecond({ reason: "app_not_installed" }).tick({ owner: "acme", epoch: d.epoch, round: 102, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "app_not_installed" })
  })

  test("F5 a defect settles that write failed, and the queue goes on", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const write = create() as { writeId: string }
    await admitAs(write)
    const after = create({ title: "After" }) as { writeId: string }
    await admitAs(after)
    const dying = MachineWrite.steps({ ...value, tokens: { ...value.tokens, forInstallation: () => Effect.die("boom") } as never })
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    expect(await Effect.runPromise(dying.tick({ owner: "acme", epoch, round: 0, waitMs: 0 }))).toMatchObject({ stop: false })
    expect(await row(write.writeId)).toMatchObject({ status: "failed", failure: "defect", cause: "defect", github_status: null })
    await Effect.runPromise(MachineWrite.steps(value).tick({ owner: "acme", epoch, round: 1, waitMs: 0 }))
    expect(await row(after.writeId)).toMatchObject({ status: "done" })
  })

  test("F8 first in, first served: waiting spends no try, and every write of every token is served", async () => {
    const github = scriptedGitHub()
    const writes: Array<{ writeId: string }> = []
    for (const lane of ["a", "b", "c"]) {
      await issueToken({ token: `smm_${lane}`, lane })
      for (let i = 0; i < 3; i++) {
        const write = create({ title: `${lane}${i}` }) as { writeId: string }
        await admitAs(write, machineOf(lane, `smm_${lane}`))
        writes.push(write)
      }
    }
    const d = await dispatcher(github)
    // Held: a thousand ticks' worth of waiting takes nothing from anyone.
    await sql(runtime, `UPDATE machine_dispatch SET next_at = now() + interval '1 hour'`)
    for (let i = 0; i < 5; i++) expect((await d.tick()).waitMs).toBeGreaterThan(3_000_000)
    expect(await sql(runtime, "SELECT max(tries) AS tries FROM machine_writes")).toEqual([{ tries: 0 }])
    for (let i = 0; i < writes.length; i++) await d.next()
    for (const write of writes) expect(await row(write.writeId)).toMatchObject({ status: "done" })
    expect([...github.issues.values()].map((issue) => issue.title)).toEqual(["a0", "a1", "a2", "b0", "b1", "b2", "c0", "c1", "c2"])
    expect(await d.next()).toEqual({ stop: true, waitMs: 0 })
  })

  test("F9 the next call waits 7.5 s from the end of a send, however long the send took", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const a = create({ title: "A" }) as { writeId: string }
    await admitAs(a)
    const b = create({ title: "B" }) as { writeId: string }
    await admitAs(b)
    let release = () => {}
    github.faults.push({ match: posting(/\/issues$/), hold: () => new Promise<void>((r) => { release = r }) })
    const d = await dispatcher(github)
    const first = d.tick()
    await vi.waitFor(() => expect(github.seen("POST", /\/issues$/)).toHaveLength(1))
    // Another tick while the send is open, as a replaced run's would be: the hold stops it before any call.
    const calls = github.calls.length
    expect((await d.tick()).waitMs).toBeGreaterThan(0)
    expect(github.calls).toHaveLength(calls)
    // The send is still open here, after the tick above, so a hold counted from its start falls short below.
    // Read on the database's clock, which sets the hold, so no margin depends on how busy this machine is.
    const ms = async (expression: string) => Number(((await sql(runtime, `SELECT extract(epoch FROM ${expression}) * 1000 AS ms FROM machine_dispatch`)) as unknown as Array<{ ms: string }>)[0]!.ms)
    const released = await ms("clock_timestamp()")
    release()
    const outcome = await first
    expect(await ms("next_at") - released).toBeGreaterThanOrEqual(7_500)
    expect(outcome.waitMs).toBeLessThanOrEqual(7_500)
    const again = await d.tick()
    expect(again.waitMs).toBeGreaterThan(0)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(await row(b.writeId)).toMatchObject({ status: "pending", tries: 0 })
  })

  test("F10 a limit on a read holds everything for the server's wait, and a hold stops reads and tokens", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: (method, path) => method === "GET" && /\/issues/.test(path), status: 403, headers: { "retry-after": "600" } })
    const d = await dispatcher(github)
    const out = await d.tick()
    expect(out.waitMs).toBeGreaterThan(590_000)
    // The limit spent no try.
    expect(await row(write.writeId)).toMatchObject({ tries: 0 })
    const calls = github.calls.length
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(github.calls).toHaveLength(calls)

    // On a send too, with the penalty doubling when no wait is named, and back after a success.
    await clear()
    await sql(runtime, `UPDATE machine_dispatch SET penalty_ms = 120000`)
    github.faults.push({ match: posting(/\/issues$/), status: 429 })
    expect((await d.tick()).waitMs).toBeGreaterThan(110_000)
    expect(await sql(runtime, `SELECT penalty_ms AS penalty FROM machine_dispatch`)).toEqual([{ penalty: 240000 }])
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
    expect(await sql(runtime, `SELECT penalty_ms AS penalty FROM machine_dispatch`)).toEqual([{ penalty: 60000 }])
  })

  test("F11 a limit on a mint or an installation lookup holds everything for the server's full wait, and spends no try", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    // As GitHub answers a secondary limit: the shared client reads a 403 as a limit only with its message.
    const limited = { status: 403, headers: { "retry-after": "600" }, message: "You have exceeded a secondary rate limit" }
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/installation"), ...limited })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), ...limited })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    // No wait named: the shared penalty holds, and doubles.
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 429 })
    const penalty = (await d.tick()).waitMs
    expect(penalty).toBeGreaterThan(100_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("F11 a limit GitHub says only in its headers holds the same, on a lookup and on a mint", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    const bare = { status: 403, headers: { "retry-after": "600" } }
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/installation"), ...bare })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), ...bare })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    const reset = String(Math.floor(Date.now() / 1000) + 900)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } })
    expect((await d.tick()).waitMs).toBeGreaterThan(800_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("a write admitted while the dispatcher stops is still served", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const d = await dispatcher(github)
    // Another request holds the owner's row, as a launch does, while the tick finds the queue empty and stops.
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => { locked = resolve })
    const holder = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function* () {
        yield* sql`UPDATE machine_dispatch SET running = true WHERE owner = 'acme'`
        locked()
        yield* Effect.promise(() => gate)
      }))))
    await holding
    const ticked = d.tick()
    // The tick has read an empty queue and waits on the row: Postgres shows a lock not granted.
    await vi.waitFor(async () =>
      expect(await sql(runtime, "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted")).not.toEqual([{ waiting: 0 }]))
    const write = create() as { writeId: string }
    await admitAs(write)
    release()
    await holder
    // The holder was this write's launch, which found the epoch running: stopping now would strand the write.
    expect(await ticked).toMatchObject({ stop: false })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("a run killed after GitHub made it and before the database heard makes nothing twice", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const d = await dispatcher(github)
    /** The process stops the moment a mutation of `pattern` has succeeded, before anything is written down. */
    const crashingAfter = (pattern: RegExp) => MachineWrite.steps({
      ...value,
      http: HttpClient.tap(value.http, (response) =>
        response.request.method === "POST" && pattern.test(new URL(response.request.url).pathname) ? Effect.interrupt : Effect.void),
    })
    let round = 100
    const crash = async (pattern: RegExp) => {
      await clear()
      return Effect.runPromiseExit(crashingAfter(pattern).tick({ owner: "acme", epoch: d.epoch, round: round++, waitMs: 0 }))
    }

    const issue = create() as { writeId: string }
    await admitAs(issue)
    expect(Exit.hasInterrupts(await crash(/\/issues$/))).toBe(true)
    expect(github.issues.size).toBe(1)
    expect(await row(issue.writeId)).toMatchObject({ status: "pending", number: null })
    await d.next()
    expect(await row(issue.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)

    const note = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "Noted." }
    await admitAs(note)
    expect(Exit.hasInterrupts(await crash(/\/comments$/))).toBe(true)
    expect(await row(note.writeId)).toMatchObject({ status: "pending" })
    await d.next()
    expect(await row(note.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.seen("POST", /\/comments$/)).toHaveLength(1)
  })

  test("the deployment's allowed list holds when the write runs: its repository and its parent's", async () => {
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const d = await dispatcher(github)
    const tick = (mayAct: (id: string) => boolean) => async () => {
      await clear()
      return d.run(MachineWrite.steps({ ...value, mayAct }).tick({ owner: "acme", epoch: d.epoch, round: Math.floor(Math.random() * 1e9), waitMs: 0 }))
    }
    const posts = () => github.calls.filter((call) => call.method === "POST" && !call.path.endsWith("/access_tokens")).length
    const issue = create() as { writeId: string }
    await admitAs(issue)
    await tick((id) => id !== REPOSITORY.id)()
    expect(await row(issue.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    await admitAs(relate)
    await tick((id) => id !== "github/acme/plan")()
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(posts()).toBe(0)
    expect(d.logs.filter((log) => log.message === "github.machine_write.refused").map((log) => ({ level: log.level, ...log.annotations }))).toEqual([
      { level: "WARN", writeId: issue.writeId, outcome: "refused", failure: "not_allowed", cause: "allow_list", githubStatus: null },
      { level: "WARN", writeId: relate.writeId, outcome: "refused", failure: "not_allowed", cause: "allow_list", githubStatus: null },
    ])
  })

  test("a GitHub permission 403 logs its status cause and settles after one try", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create()
    await admitAs(write)
    const d = await dispatcher(github)
    github.faults.push({ match: posting(/\/issues$/), status: 403, message: "Resource not accessible by integration" })
    await d.tick()
    expect(await row(write.writeId)).toMatchObject({ status: "refused", failure: "not_allowed", tries: 1 })
    await d.next()
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(d.logs.filter((log) => log.message === "github.machine_write.refused").map((log) => ({ level: log.level, ...log.annotations }))).toEqual([
      { level: "WARN", writeId: write.writeId, outcome: "refused", failure: "not_allowed", cause: "github_status:403", githubStatus: 403 },
    ])
    expect(JSON.stringify(d.logs)).not.toContain(write.title)
    expect(JSON.stringify(d.logs)).not.toContain(write.body)
    expect(JSON.stringify(d.logs)).not.toContain(TOKEN)
    expect(JSON.stringify(d.logs)).not.toContain("Resource not accessible")
  })

  test.each([
    { outcome: "GitHub create POST refusal", fault: { match: posting(/\/issues$/), status: 403, message: "Resource not accessible by integration" }, status: "refused", failure: "not_allowed", cause: "github_status:403", githubStatus: 403, number: null },
    { outcome: "installation refusal", fault: { match: (method: string, path: string) => method === "GET" && path.endsWith("/installation"), status: 404 }, status: "refused", failure: "app_not_installed", cause: "installation", githubStatus: 404, number: null },
    { outcome: "done write", fault: undefined, status: "done", failure: null, cause: null, githubStatus: null, number: 1 },
  ])("a $outcome stores its diagnostics and GET returns them", async ({ fault, status, failure, cause, githubStatus, number }) => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const github = scriptedGitHub()
    const write = create()
    await admitAs(write)
    const d = await dispatcher(github)
    if (fault !== undefined) github.faults.push(fault)
    await d.tick()
    expect.soft(await row(write.writeId)).toMatchObject({ status, failure, cause, github_status: githubStatus, number })
    const response = await h.fetch(`${ROUTE}/${write.writeId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status, failure, cause, githubStatus, number })
  })

  test("a slash in a token's agent or lane can't reach the table", async () => {
    await expect(issueToken({ token: "smm_a", agent: "a/b" })).rejects.toThrow()
    await expect(issueToken({ token: "smm_b", lane: "b/c" })).rejects.toThrow()
  })

  test("a permission 403 with a future reset and budget left is a refusal, never retried", async () => {
    const reset_ = String(Math.floor(Date.now() / 1000) + 3000)
    expect(MachineWrite.readAnswer(403, new Headers({ "x-ratelimit-reset": reset_, "x-ratelimit-remaining": "4000" }), { message: "Resource not accessible by integration" }, Date.now()))
      .toEqual({ kind: "refused", failure: "not_allowed" })
    expect(MachineWrite.readAnswer(403, new Headers({ "x-ratelimit-reset": reset_, "x-ratelimit-remaining": "0" }), {}, 0)).toMatchObject({ kind: "limited" })
    expect(MachineWrite.readAnswer(403, new Headers({ "retry-after": "5" }), {}, 0)).toEqual({ kind: "limited", hintMs: 5000 })
    expect(MachineWrite.readAnswer(403, new Headers(), { message: "You have exceeded a secondary rate limit" }, 0)).toEqual({ kind: "limited", hintMs: null })
    expect(MachineWrite.readAnswer(422, new Headers(), {}, 0)).toEqual({ kind: "refused", failure: "invalid" })
  })

  test("an epoch past its lease is replaced, and its old tick stops itself; a live one is left alone", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    expect(await runtime.runPromise(MachineWrite.launch("acme"))).toBe(d.epoch)
    await sql(runtime, `UPDATE machine_dispatch SET due_at = now() - interval '11 minutes'`)
    const next = await runtime.runPromise(MachineWrite.launch("acme"))
    expect(next).toBe(d.epoch + 1)
    expect(await d.tick()).toEqual({ stop: true, waitMs: 0 })
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
  })
})

describe("a failed write's way back", () => {
  test("F1 a retry needs the op's scope and the parent's repository", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    await h.fetch(ROUTE, post(write))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    await sql(runtime, `UPDATE machine_tokens SET scope = ARRAY['work/link']::text[]`)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(403)
    await sql(runtime, `UPDATE machine_tokens SET scope = ${ALL}`)
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    expect((await h.fetch(ROUTE, post(relate))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${relate.writeId}'`)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now() WHERE repo_id = 'github/acme/plan'`)
    expect((await h.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(403)
  })

  test("F6 a retry whose start was lost can be asked for again, and starts the owner's current run", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    await h.fetch(ROUTE, post(write))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(202)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(202)
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(new Set(h.starts.map((start) => start.executionId))).toEqual(new Set([MachineWrite.dispatchExecutionId("acme", 1)]))
    expect(h.starts).toHaveLength(4)
  })

  test("F6 a start that failed is made good by asking again, on the first send and on a retry", async () => {
    let failing = 0
    const started: Array<string> = []
    const starter = FlowStarter.of({
      start: (_flow: unknown, start: { readonly executionId: string }) =>
        Effect.suspend(() => {
          if (failing > 0) {
            failing -= 1
            return Effect.die("the start was lost")
          }
          started.push(start.executionId)
          return Effect.void
        }),
    } as never)
    const h = await githubHarness(runtime, { actor: null, starter })
    await issueToken()
    const write = create()
    failing = 1
    expect((await h.fetch(ROUTE, post(write))).status).toBe(503)
    expect(await row((write as { writeId: string }).writeId)).toMatchObject({ status: "pending" })
    expect(started).toEqual([])
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(started).toEqual([MachineWrite.dispatchExecutionId("acme", 1)])

    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    failing = 1
    const retry = () => h.fetch(`${ROUTE}/${(write as { writeId: string }).writeId}/retry`, post({}))
    expect((await retry()).status).toBe(503)
    expect(await row((write as { writeId: string }).writeId)).toMatchObject({ status: "pending" })
    expect((await retry()).status).toBe(202)
    expect(started).toHaveLength(2)
  })

  test("a retry holds the deployment's allowed list: its repository and its parent's", async () => {
    const wide = await githubHarness(runtime, { actor: null, allowed: new Set(["github/acme/plan"]) })
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    expect((await wide.fetch(ROUTE, post(relate))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    // The parent left the list, its tokens still live.
    const narrow = await githubHarness(runtime, { actor: null, allowed: new Set() })
    expect((await narrow.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(403)
    expect(await row(relate.writeId)).toMatchObject({ status: "failed" })
    // Its own repository left it too: this deployment no longer acts there.
    const elsewhere = await githubHarness(runtime, { actor: null, own: { owner: "acme", name: "other", id: "github/acme/other" }, allowed: new Set(["github/acme/plan"]) })
    expect((await elsewhere.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(404)
    expect(await row(relate.writeId)).toMatchObject({ status: "failed" })
  })

  test("F7 every way into pending holds the bound, and a replacement token counts it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const failed = create()
    await h.fetch(ROUTE, post(failed))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    for (let i = 0; i < MachineWrite.MAX_BACKLOG; i++) expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
    expect((await h.fetch(`${ROUTE}/${failed.writeId}/retry`, post({}))).status).toBe(429)
    expect(await row(failed.writeId)).toMatchObject({ status: "failed" })
    await issueToken({ token: "smm_replacement" })
    expect((await h.fetch(`${ROUTE}/${failed.writeId}/retry`, post({}, "smm_replacement"))).status).toBe(202)
    expect(await sql(runtime, `SELECT count(*)::int AS count FROM machine_writes WHERE token_sha256 = '${digestSync("smm_replacement")}' AND status = 'pending'`)).toEqual([{ count: 1 }])
  })

  test("a failed write goes to the back of the line and stays one issue; another lane can't touch it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const github = scriptedGitHub()
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    const retry = (token = TOKEN) => h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}, token))
    // GitHub made it, then its tries ran out.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    await sql(runtime, `UPDATE machine_writes SET tries = ${MachineWrite.MAX_TRIES}`)
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "failed", failure: "exhausted", cause: "exhausted", github_status: null })
    // Resubmitting answers what it settled, and starts nothing.
    const starts = h.starts.length
    expect(await (await h.fetch(ROUTE, post(write))).json()).toEqual({ writeId: write.writeId, status: "failed" })
    expect(h.starts).toHaveLength(starts)
    expect((await retry("smm_lane-2")).status).toBe(409)
    expect((await retry()).status).toBe(202)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", failure: null, cause: null, github_status: null })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", failure: null, cause: null, github_status: null, number: 1 })
    expect(github.issues.size).toBe(1)
  })
})

describe("recovery is the dispatcher's own", () => {
  test("a machine can't adopt an issue github/Write made by sending its marker as a write id", async () => {
    const github = scriptedGitHub()
    github.roles.set("maya", "write")
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: { op: "issue/create", title: "Theirs", body: "Not the machine's." } })
    const { services: value } = await services(runtime, github)
    await runFlow(Write.Write, { writeId }, Write.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    const theirs = github.issues.get(1)!
    expect(theirs.body).toContain(writeId)
    // The strongest case: the App wrote it, so an author check alone would pass it.
    ;(theirs as { login: string | null }).login = BOT_LOGIN

    await issueToken()
    const claim = create({ writeId, title: "Mine now" }) as { writeId: string }
    await admitAs(claim)
    const d = await dispatcher(github)
    await d.tick()
    expect(await row(claim.writeId)).toMatchObject({ status: "done", number: 2 })
    expect(github.issues.size).toBe(2)
    const close = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(close)
    await d.next()
    expect(await row(close.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.issues.get(1)!.state).toBe("open")
  })

  test("a marker copied into an older issue someone else wrote is ignored, and the App's issue is found", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const older = create({ title: "Older" }) as { writeId: string }
    await admitAs(older)
    const d = await dispatcher(github)
    await d.tick()
    // Someone else's issue, older than the one about to be made.
    ;(github.issues.get(1)! as { login: string | null }).login = "mallory"
    const write = create({ title: "Mine" }) as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    await d.next()
    expect(github.issues.get(2)!.login).toBe(BOT_LOGIN)
    const [{ recovery }] = (await sql(runtime, `SELECT recovery_id::text AS recovery FROM machine_writes WHERE id = '${write.writeId}'`)) as unknown as Array<{ recovery: string }>
    const theirs = github.issues.get(1)!
    theirs.body = `${theirs.body}\n<!-- smithers:write=${recovery} -->`
    theirs.updatedAt = Date.now()
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 2 })
    expect(github.issues.size).toBe(2)
  })

  test("an update whose read-back failed never goes after a newer one on the same issue", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const made = create() as { writeId: string }
    await admitAs(made)
    const d = await dispatcher(github)
    await d.tick()
    const close = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(close)
    const reopen = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    await admitAs(reopen)
    // The close's PATCH succeeds; the read after it fails.
    let reads = 0
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/1") && ++reads === 2, status: 502 })
    for (let i = 0; i < 4; i++) await d.next()
    expect(await row(reopen.writeId)).toMatchObject({ status: "done" })
    expect(github.issues.get(1)!.state).toBe("open")
    expect(github.seen("PATCH", /\/issues\/1$/)).toHaveLength(2)

    // A failed older update, retried after newer ones succeeded: a field a newer one set is theirs, any other still goes.
    const stale = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed", body: "Older words." }
    await admitAs(stale)
    const newer = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, title: "Newer", body: "Newer words." }
    await admitAs(newer)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${stale.writeId}'`)
    await d.next()
    expect(await row(newer.writeId)).toMatchObject({ status: "done" })
    await sql(runtime, `UPDATE machine_writes SET status = 'pending', queued_at = clock_timestamp() WHERE id = '${stale.writeId}'`)
    await d.next()
    expect(await row(stale.writeId)).toMatchObject({ status: "done" })
    expect(github.issues.get(1)!).toMatchObject({ title: "Newer", state: "closed" })
    expect(github.issues.get(1)!.body).toContain("Newer words\\.")

    // Every field it asked for a newer one has set since: superseded, and nothing is sent.
    const reopen2 = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    const closeLate = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(closeLate)
    await admitAs(reopen2)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${closeLate.writeId}'`)
    await d.next()
    expect(await row(reopen2.writeId)).toMatchObject({ status: "done" })
    const patches = github.seen("PATCH", /\/issues\/1$/).length
    await sql(runtime, `UPDATE machine_writes SET status = 'pending', queued_at = clock_timestamp() WHERE id = '${closeLate.writeId}'`)
    await d.next()
    expect(await row(closeLate.writeId)).toMatchObject({ status: "refused", failure: "superseded" })
    expect(github.seen("PATCH", /\/issues\/1$/)).toHaveLength(patches)
    expect(github.issues.get(1)!.state).toBe("open")
  })

  test("an App with its own slug finds its own issue after a lost answer, and may update it", async () => {
    await issueToken()
    const login = "acme-filer[bot]"
    const github = scriptedGitHub("acme", "widgets", login)
    const { services: value } = await services(runtime, github)
    const steps = MachineWrite.steps({ ...value, appLogin: login })
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    let round = 0
    const next = async () => {
      await clear()
      return Effect.runPromise(steps.tick({ owner: "acme", epoch, round: round++, waitMs: 0 }))
    }
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    await next()
    await next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    const update = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(update)
    await next()
    expect(await row(update.writeId)).toMatchObject({ status: "done" })
  })

  test("a marked issue another author wrote is never adopted", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    // The answer is lost, and someone else edits the issue to be theirs: a marker is not a receipt without the App as author.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    ;(github.issues.get(1)! as { login: string | null }).login = "mallory"
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 2 })
  })
})

describe("github/Write across the change", () => {
  test("a person's write replays on the host with both flows: same plan, no second POST, no machine rows", async () => {
    expect(Write.SEND_VERSION).toBe("github-write/send/v2")
    expect(Host.flows).toContain(Write.Write)
    expect(Host.flows).toContain(MachineWrite.MachineDispatch)
    const github = scriptedGitHub()
    github.roles.set("maya", "write")
    const token = github.userToken("maya")
    const person = await signedIn(runtime, { login: "maya", token })
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: { op: "issue/create", title: "A person's", body: "Theirs." } })
    const { services: value } = await services(runtime, github)
    const before = await runFlow(Write.Write, { writeId }, Write.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    expect(before.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    const posts = github.seen("POST", /\/issues$/).length
    const ran = await runFlow(Write.Write, { writeId }, Host.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.seen("POST", /\/issues$/)).toHaveLength(posts)
    expect(github.issues.get(1)!.login).toBe("maya")
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_writes")).toEqual([{ count: 0 }])
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_dispatch")).toEqual([{ count: 0 }])
  })
})
