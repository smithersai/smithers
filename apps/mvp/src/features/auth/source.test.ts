import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer, Option } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as GitHubStore from "../../../worker/github/Store.ts"
import { openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { IssuesStore } from "../issues/store"
import { Pulls } from "../pulls/pulls"
import { role as readRole } from "../repo/actions"
import { repoId } from "../repo/contract"
import { AuthStore, SESSION } from "./store"

// Which shapes a page opens (decision 0112): a real app over a real ChatApi, with a recording source that sends every
// request on. Before, every tab opened every store's shape on boot: a signed-out visitor's repository page followed a
// person's runs, flows, drafts, notifications, conversations and writes (all empty for nobody), the triage settings,
// and every pull request's commits, reviews and checks, about 7 to 10 long polls per tab the page never read.

/** A person's own shapes, and the repository's triage settings: none of them a signed-out page's. */
const PERSONAL = ["runs", "flows", "flow-drafts", "notifications", "my-conversations", "github-writes", "triage-settings"]
/** A pull request's own shapes: its page's, not the repository's. */
const DETAIL = ["items", "comments", "pull-commits", "reviews", "checks"]

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

const recorded = (actor: null | undefined) => {
  const requests: Array<string> = []
  const source: ShapeSource.Source = {
    request: (url, init) =>
      Effect.suspend(() => {
        requests.push(new URL(url).pathname.replace("/api/shapes/", ""))
        return ShapeSource.fetchSource.request(url, init)
      }),
  }
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, actor === null ? { actor } : {})
  runtimes.push(runtime)
  const asked = (names: ReadonlyArray<string>) => requests.filter((name) => names.includes(name))
  return { runtime, requests, asked }
}

const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]

test("signed out on a public repository's pull requests: no personal, admin or pull request shape until sign-in and a pull request's page", async () => {
  const { runtime, requests, asked } = recorded(null)
  const pulls = await runtime.runPromise(Effect.service(Pulls))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  await Effect.runPromise(api.github.run(GitHubStore.recordRepository(repoId(owner, name), { githubId: 1, private: false })))
  await runtime.runPromise(readRole(owner, name))
  pulls.actions.open(owner, name)
  await vi.waitFor(() => expect(requests).toEqual(expect.arrayContaining(["item-summaries", "pulls"])), { timeout: 30_000 })
  // Long enough for every other store's first request, which used to go out on boot.
  await runtime.runPromise(Effect.sleep("300 millis"))
  expect(asked([...PERSONAL, ...DETAIL])).toEqual([])

  // Sign-in on this tab, without a reload: the person's shapes open.
  const auth = await runtime.runPromise(Effect.service(AuthStore))
  await runtime.runPromise(auth.session.update(SESSION, (row) => {
    row.status = "signed_in"
    row.role = "member"
  }))
  await vi.waitFor(() => expect(new Set(asked(PERSONAL))).toEqual(new Set(PERSONAL)), { timeout: 15_000 })
  expect(asked(DETAIL)).toEqual([])

  // A pull request's page opens its commits, reviews and checks.
  pulls.actions.open(owner, name, 1)
  await vi.waitFor(() => expect(new Set(asked(DETAIL))).toEqual(new Set(DETAIL)), { timeout: 15_000 })
}, 90_000)

test("a Member's tab opens their own shapes on boot, and a pull request's only on its page", async () => {
  const { runtime, asked } = recorded(undefined)
  const issues = await runtime.runPromise(Effect.service(IssuesStore))
  const pulls = await runtime.runPromise(Effect.service(Pulls))
  // A repository's triage settings open with the repository (decision 0079 slice 1b).
  pulls.actions.open(owner, name)
  await vi.waitFor(() => expect(new Set(asked(PERSONAL))).toEqual(new Set(PERSONAL)), { timeout: 30_000 })
  const repository = await runtime.runPromise(issues.forRepo(repoId(owner, name)))
  expect(Option.getOrThrow(runtime.runSync(repository.access.get("access"))).status).toBe("allowed")
  await runtime.runPromise(Effect.sleep("300 millis"))
  expect(asked(DETAIL)).toEqual([])
  pulls.actions.open(owner, name, 1)
  await vi.waitFor(() => expect(new Set(asked(DETAIL))).toEqual(new Set(DETAIL)), { timeout: 15_000 })
}, 90_000)
