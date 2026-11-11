// `repositoryReadable`'s proof and its viewer sources, without Postgres: a role answers every viewer here, so no stage
// reads the database. The readers' answers over the whole matrix are worker/github/Readers.test.ts's.
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import * as Access from "./Access.ts"
import type { RepoRoles } from "./RepoRoles.ts"

const OWN = { owner: "acme", name: "own", id: "github/acme/own" } as const
const person: Actor = { subject: { kind: "person", id: "person-cookie" }, role: "member" }
const agent: Actor = { ...person, act: { kind: "agent", id: "run-1", root: "run-1", chain: ["chat/Answer"], ceiling: [] } as never }

// Never opened: a stage that reached Postgres would fail the test.
const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
const roles: RepoRoles<never> = {
  repository: OWN,
  resolve: (actor, target) => Effect.succeed({ role: "member", held: Option.some({ repoId: target.id, personId: actor.subject.id, role: "member" }) }),
}
const access = Access.make({ repository: OWN, mayAct: (id) => id === OWN.id, roles, visibility: () => Effect.die("unread"), database: unreachable })

/** Sessions where the request's credential is `agent` and its cookie `person`, with the cookie resolver or not. */
const sessions = (cookie: boolean) =>
  Layer.succeed(Sessions, Sessions.of({
    resolve: Effect.succeedSome(agent),
    ...(cookie ? { resolveCookie: Effect.succeedSome(person) } : {}),
  }))

const readable = (source: Access.ViewerSource, cookie = true) =>
  Effect.runPromise(access.repositoryReadable(OWN, source).pipe(
    Effect.map(({ proof }) => proof),
    Effect.provide(sessions(cookie)),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://app.test/"))),
  ))

describe("repositoryReadable's proof", () => {
  test("names who read and by what: the session's actor, a credential's run included", async () => {
    expect(await readable("session")).toEqual({ _tag: "Readable", target: OWN, viewer: { kind: "person", actor: agent }, role: "member", via: "role" })
  })

  test("the cookie source reads the cookie's person, never the request's credential", async () => {
    expect(await readable("cookie")).toEqual({ _tag: "Readable", target: OWN, viewer: { kind: "person", actor: person }, role: "member", via: "role" })
  })

  test("the cookie source without a cookie resolver is unavailable, never another resolver's answer", async () => {
    expect(await readable("cookie", false)).toEqual({ _tag: "Refused", target: OWN, stage: "viewer", refusal: "unavailable", status: 503 })
  })

  test("a repository the deployment doesn't act on is refused at the deployment stage, before any viewer", async () => {
    const proof = await Effect.runPromise(access.repositoryReadable({ owner: "acme", name: "else", id: "github/acme/else" }, "session").pipe(
      Effect.map(({ proof }) => proof),
      Effect.provide(Layer.succeed(Sessions, Sessions.of({ resolve: Effect.die("no viewer is resolved") }))),
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://app.test/"))),
    ))
    expect(proof).toMatchObject({ _tag: "Refused", stage: "deployment", refusal: "not_found", status: 404 })
  })
})
