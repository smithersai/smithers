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
test("authority is device state, including explicit public access only on the deployment repository", () => {
  for (const status of ["loading", "unreachable", "signed_out", "signed_in"] as const) {
    expect(repositoryAccess(session(status), [])).toBe(status === "signed_out" ? "sign_in" : status === "signed_in" ? "forbidden" : "unknown")
  }
  for (const role of ["guest", "member", "maintainer", "admin"] as const) expect(repositoryAccess(session("signed_in", role), [])).toBe("allowed")
  expect(repositoryAccess(session("signed_out"), [{ id: "other", own: false, role: null, readable: true }])).toBe("sign_in")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: "admin", readable: true }])).toBe("sign_in")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: null }])).toBe("sign_in")
  expect(repositoryAccess(session("signed_out"), [{ id: "own", own: true, role: null, readable: true }])).toBe("allowed")
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
    await runtime.runPromise(Effect.service(Pulls))
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    const issues = await runtime.runPromise(Effect.service(IssuesStore))
    const state = () => Option.getOrThrow(runtime.runSync(issues.access.get("access"))).status
    await vi.waitFor(() => expect(state()).toBe(actor === null ? "sign_in" : "forbidden"), { timeout: 30_000 })
    await runtime.runPromise(Effect.sleep("100 millis"))
    expect(requests.filter((path) => paths.some((name) => path === `/api/shapes/${name}`))).toEqual([])
    const [owner, repository] = TEST_REPOSITORY.split("/") as [string, string]
    await Effect.runPromise(api.github.run(GitHubStore.recordRepository(repoId(owner, repository), { githubId: 1, private: false })))
    await runtime.runPromise(readRole(owner, repository))
    await vi.waitFor(() => expect(paths.every((name) => requests.includes(`/api/shapes/${name}`))).toBe(true), { timeout: 15_000 })
  }, 90_000)
}
}

test("transport events cannot grant or revoke authority; failures and recovery change only availability", () => {
  for (const current of ["unknown", "allowed", "unavailable", "sign_in", "forbidden"] as const) {
    for (const transport of ["allowed", "unavailable"] as const) {
      expect(syncStatusAfter(current, transport)).toBe(current === "allowed" || current === "unavailable" ? transport : current)
    }
  }
})
