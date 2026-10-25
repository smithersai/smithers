import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer, Option } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as GitHubStore from "../../../worker/github/Store.ts"
import { role as readRole } from "../repo/actions"
import { repoId } from "../repo/contract"
import { TestChatApi, TEST_REPOSITORY, openTestApp } from "../../test/chatApi"
import type { Session } from "../auth/schema"
import { SESSION } from "../auth/store"
import { Pulls } from "../pulls/pulls"
import { repositoryAccess, syncStatusAfter } from "./source"
import { IssuesStore } from "./store"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })
const session = (status: Session["status"], role: Session["role"] = null): Session => ({
  id: SESSION, status, role, login: null, available: true, signingOut: false, restored: true,
})
test("authority is device state: the named repository's role row, the session's role only on the deployment's own", () => {
  const own = { id: "own", own: true, role: null } as const
  for (const status of ["loading", "unreachable", "signed_out", "signed_in"] as const) {
    expect(repositoryAccess(session(status), [own], "own")).toBe(status === "signed_out" ? "sign_in" : status === "signed_in" ? "forbidden" : "unknown")
  }
  for (const role of ["guest", "member", "maintainer", "admin"] as const) expect(repositoryAccess(session("signed_in", role), [own], "own")).toBe("allowed")
  // No answer for the repository yet: nothing is requested, whatever the session.
  expect(repositoryAccess(session("signed_in", "admin"), [own], "other")).toBe("unknown")
  expect(repositoryAccess(session("signed_out"), [], "own")).toBe("unknown")
  // A public-read receipt names its repository, and counts only on an answer with no role.
  expect(repositoryAccess(session("signed_out"), [{ id: "other", own: false, role: null, readable: true }], "other")).toBe("allowed")
  expect(repositoryAccess(session("signed_out"), [{ id: "other", own: false, role: null, readable: true }], "own")).toBe("unknown")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: "admin", readable: true }], "own")).toBe("sign_in")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: null }], "own")).toBe("sign_in")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: null, readable: true }], "own")).toBe("allowed")
})

test("a Member of the deployment's own repository reads another only as its own answer says (decision 0079)", () => {
  const member = session("signed_in", "member")
  const own = { id: "github/smithersai/smithers", own: true, role: "member" } as const
  const vibelang = "github/smithersai/vibelang"
  expect(repositoryAccess(member, [own], own.id)).toBe("allowed")
  // GitHub's read there is a Guest: a reader, not the Member the session says.
  expect(repositoryAccess(member, [own, { id: vibelang, own: false, role: "guest" }], vibelang)).toBe("allowed")
  // No role there, or no answer yet: never the session's Member.
  expect(repositoryAccess(member, [own, { id: vibelang, own: false, role: null }], vibelang)).toBe("forbidden")
  expect(repositoryAccess(member, [own], vibelang)).toBe("unknown")
})

test("a repository the deployment doesn't sync is elsewhere for anyone, whatever their role there", () => {
  const left = { id: "github/acme/left-out", own: false, synced: false } as const
  for (const who of [session("signed_out"), session("signed_in", "admin"), session("loading")]) {
    for (const role of [null, "admin"] as const) expect(repositoryAccess(who, [{ ...left, role }], left.id)).toBe("elsewhere")
  }
  expect(repositoryAccess(session("signed_in"), [{ ...left, role: "guest", synced: true }], left.id)).toBe("allowed")
})

// A real app and stores, with a recording Effect source that delegates every authorized request to the real server.
// A signed-out cold boot used to send all eight and learn authority from their 401s.
for (const [who, actor] of [["signed out", null], ["without a role", { subject: { kind: "person", id: "person-outsider" }, login: "outsider", role: null }]] as const) {
for (const [name, paths] of [
  ["issues", ["items", "comments", "github-sync", "triage-settings"]],
  ["pulls", ["pulls", "pull-commits", "reviews", "checks"]],
] as const) {
  test(`${name}: ${who} never requests member shapes; a public receipt releases them`, async () => {
    const requests: string[] = []
    const source = { ...ShapeSource.fetchSource, request: (url: string, init: Parameters<ShapeSource.Source["request"]>[1]) =>
      Effect.suspend(() => { requests.push(new URL(url).pathname); return ShapeSource.fetchSource.request(url, init) }) }
    const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor })
    runtimes.push(runtime)
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    const [owner, repository] = TEST_REPOSITORY.split("/") as [string, string]
    const id = repoId(owner, repository)
    const repo = await runtime.runPromise(Effect.flatMap(IssuesStore, (store) => store.forRepo(id)))
    await (await runtime.runPromise(Effect.service(Pulls))).actions.warm(owner, repository)
    const state = () => Option.getOrThrow(runtime.runSync(repo.access.get("access"))).status
    await runtime.runPromise(readRole(owner, repository))
    await vi.waitFor(() => expect(state()).toBe(actor === null ? "sign_in" : "forbidden"), { timeout: 30_000 })
    await runtime.runPromise(Effect.sleep("100 millis"))
    expect(requests.filter((path) => paths.some((name) => path === `/api/shapes/${name}`))).toEqual([])
    await Effect.runPromise(api.github.run(GitHubStore.recordRepository(id, { githubId: 1, private: false })))
    await runtime.runPromise(readRole(owner, repository))
    await vi.waitFor(() => expect(paths.every((name) => requests.includes(`/api/shapes/${name}`))).toBe(true), { timeout: 15_000 })
  }, 90_000)
}
}

test("transport events cannot grant or revoke authority; failures, recovery and a 404 change only availability", () => {
  for (const current of ["unknown", "allowed", "unavailable", "sign_in", "forbidden", "elsewhere"] as const) {
    for (const transport of ["allowed", "unavailable", "elsewhere"] as const) {
      const granted = current === "allowed" || current === "unavailable" || current === "elsewhere"
      expect(syncStatusAfter(current, transport)).toBe(granted ? transport : current)
    }
  }
})
