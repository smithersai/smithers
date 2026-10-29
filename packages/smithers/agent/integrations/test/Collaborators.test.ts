/**
 * Collaborator permissions against a fake GitHub on a real socket.
 */
import { Effect, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Collaborators from "../src/github/Collaborators.ts"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

/** Answers keyed by the decoded login: a permission body, or a status to fail with. */
const startGitHub = async (answers: Record<string, unknown>): Promise<Fixture> => {
  fixture = await startFixture((request, response) => {
    const match = /^\/repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(
      new URL(request.url, "http://github.test").pathname
    )
    const answer = match === null ? undefined : answers[decodeURIComponent(match[1]!)]
    if (answer === undefined) return json(response, 404, { message: "Not Found" })
    if (typeof answer === "number") return json(response, answer, { message: "Forbidden" })
    json(response, 200, answer)
  })
  return fixture
}

const layer = () => gitHubLayer({ token: "token-for-tests", apiBaseUrl: (fixture as Fixture).origin }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer())))

const answer = (permission: string, roleName: string) => ({
  permission,
  role_name: roleName,
  user: { login: "x", id: 1, type: "User", permissions: { admin: false, push: true, pull: true } }
})

describe("permission", () => {
  it("answers the base permission, the role name and the account's id, dropping GitHub's other fields", async () => {
    await startGitHub({ maya: answer("write", "maintain") })
    expect(Option.getOrThrow(await run(Collaborators.permission("o", "r", "maya")))).toEqual({
      permission: "write",
      roleName: "maintain",
      userId: 1
    })
    expect(fixture!.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /repos/o/r/collaborators/maya/permission"
    ])
  })

  it("accepts an App's bot account and an Enterprise Managed User, encoding the brackets", async () => {
    await startGitHub({ "dependabot[bot]": answer("read", "read"), "sam_acme": answer("admin", "admin") })
    expect(Option.getOrThrow(await run(Collaborators.permission("o", "r", "dependabot[bot]"))).roleName).toBe("read")
    expect(Option.getOrThrow(await run(Collaborators.permission("o", "r", "sam_acme"))).permission).toBe("admin")
    expect(fixture!.requests[0]!.url).toBe("/repos/o/r/collaborators/dependabot%5Bbot%5D/permission")
  })

  it("answers no account id when GitHub names no account", async () => {
    await startGitHub({
      maya: { permission: "read", role_name: "read" },
      sam: { permission: "read", role_name: "read", user: null }
    })
    expect(Option.getOrThrow(await run(Collaborators.permission("o", "r", "maya")))).toEqual({
      permission: "read",
      roleName: "read"
    })
    expect(Option.getOrThrow(await run(Collaborators.permission("o", "r", "sam")))).toEqual({
      permission: "read",
      roleName: "read"
    })
  })

  it("answers none when GitHub answers 404", async () => {
    await startGitHub({})
    expect(Option.isNone(await run(Collaborators.permission("o", "r", "ghost")))).toBe(true)
  })

  it("passes a failure other than 404 through", async () => {
    await startGitHub({ maya: 403 })
    const error = await failure(Collaborators.permission("o", "r", "maya"))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 403, retryable: false })
  })

  it("fails decode-failed when GitHub's answer has no role name", async () => {
    await startGitHub({ maya: { permission: "write" } })
    expect((await failure(Collaborators.permission("o", "r", "maya"))).reason).toBe("decode-failed")
  })

  it.each<[string, unknown]>([
    ["an empty login", ""],
    ["a login starting with a hyphen", "-maya"],
    ["a traversing login", ".."],
    ["a login with a slash", "maya/../../user"],
    ["a 40-character login", "m".repeat(40)],
    ["a lone bot suffix", "[bot]"],
    ["a bot suffix mid-login", "a[bot]b"],
    ["a login that is not a string", 7]
  ])("refuses %s before any request", async (_name, login) => {
    await startGitHub({})
    const error = await failure(Collaborators.permission("o", "r", login as string))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ field: "login", retryable: false })
    expect(fixture!.requests).toHaveLength(0)
  })

  it("accepts a 39-character login, with or without a bot suffix", () => {
    expect(Collaborators.LOGIN_PATTERN.test("m".repeat(39))).toBe(true)
    expect(Collaborators.LOGIN_PATTERN.test(`${"m".repeat(39)}[bot]`)).toBe(true)
    expect(Collaborators.LOGIN_PATTERN.test(`${"m".repeat(40)}[bot]`)).toBe(false)
  })

  it("refuses a traversing repository before any request", async () => {
    await startGitHub({})
    expect((await failure(Collaborators.permission("o", "..", "maya"))).details).toMatchObject({ field: "repo" })
    expect(fixture!.requests).toHaveLength(0)
  })
})
