import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { RepoRole, Session } from "../auth/schema"
import { makeVisibility } from "../repo/gate"
import { IssueHeading } from "./components/IssueHeading"
import { SEARCHED, Searched } from "./schema"
import { earlySummaryOf, pageOf } from "./view"

const repoId = "github/acme/widgets"
const answer: Searched = {
  id: SEARCHED, repoId, q: "#7",
  issues: [{ number: 7, title: "The real issue", state: "closed", author: { login: "maya" }, comments: 2,
    created_at: "2026-11-01T12:00:00Z", updated_at: "2026-11-02T12:00:00Z", triage: "proposed", commitment: null }],
}

test("a held-sync issue uses only its exact early answer; a missing or failed read stays a plain heading", () => {
  for (const read of [undefined, { ...answer, repoId: "github/acme/other" }, { ...answer, q: "#8" }, { ...answer, issues: [] }]) {
    const summary = earlySummaryOf(read, repoId, 7)
    expect(summary).toBeUndefined()
    const html = renderToStaticMarkup(createElement(IssueHeading, { owner: "acme", repo: "widgets", number: 7, summary }))
    expect(html).toContain("Issue #7")
    expect(html).not.toMatch(/skeleton|aria-busy|Syncing/)
  }
  const summary = earlySummaryOf(answer, repoId, 7)
  expect(summary).toMatchObject({ number: 7, title: "The real issue", state: "closed", author: "maya" })
  const html = renderToStaticMarkup(createElement(IssueHeading, { owner: "acme", repo: "widgets", number: 7, summary }))
  expect(html).toContain("The real issue")
  expect(html).toContain('data-first-paint="settled"')
  expect(html).not.toMatch(/skeleton|aria-busy|Syncing/)
})

test("an early read with Electric held shows nothing before refusal restoration and disappears at access withdrawal", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const known = yield* Deferred.make<void>()
    const roles = yield* Collection.local<RepoRole, string>({ id: "early-roles", schema: RepoRole, getKey: (row) => row.id,
      initialData: [{ id: repoId, role: "member", own: false }] })
    const session = yield* Collection.local<Session, string>({ id: "early-session", schema: Session, getKey: (row) => row.id,
      initialData: [{ id: "session", status: "signed_in", role: "member", login: "maya", available: true, signingOut: false, restored: true }] })
    const read = yield* Collection.local<Searched, string>({ id: "early-read-test", schema: Searched, getKey: (row) => row.id, initialData: [answer] })
    const visibility = yield* makeVisibility(roles, session, Deferred.await(known))
    const gated = yield* visibility.gate(read)
    yield* gated.preload
    expect(yield* gated.toArray).toEqual([])
    yield* Deferred.succeed(known, undefined)
    yield* Effect.yieldNow
    expect(earlySummaryOf((yield* gated.toArray)[0], repoId, 7)?.title).toBe("The real issue")
    yield* roles.update(repoId, (row) => { row.role = null; row.refused = "forbidden" })
    expect(yield* gated.toArray).toEqual([])
    // Even a late response cannot bypass the gate before cleanup wipes raw memory.
    yield* read.update(SEARCHED, (row) => { row.issues = [...answer.issues] })
    expect(yield* gated.toArray).toEqual([])
  })))
})


test("an answered heading retains detail failure and recovery when Electric fails", () => {
  const summary = earlySummaryOf(answer, repoId, 7)
  const page = pageOf(undefined, undefined, true, true, { status: "unavailable", installed: false })
  expect(page).toBe("unknown")
  const html = renderToStaticMarkup(createElement(IssueHeading, {
    owner: "acme", repo: "widgets", number: 7, summary, unavailable: page === "unknown", onRetry: () => {},
  }))
  expect(html).toContain("The real issue")
  expect(html).toContain("Issue unavailable here")
  expect(html).toContain("Try again")
  expect(html).not.toMatch(/skeleton|aria-busy|Syncing/)
})
