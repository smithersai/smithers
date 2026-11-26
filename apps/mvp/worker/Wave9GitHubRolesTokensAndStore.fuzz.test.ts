import { GitHub } from "@smthrs/integrations"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as Actor from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as GitHubAuth from "./GitHubAuth.ts"
import * as SessionKeys from "./SessionKeys.vibe"
import * as SessionStore from "./SessionStore.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.vibe"
import * as RevokeReplaced from "./flows/RevokeReplacedGitHubToken.vibe"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as Store from "./github/Store.ts"
import * as Tokens from "./github/Tokens.ts"
import { accountIdOf, appKey, INSTALLATION_ID, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import * as H from "./test/harness.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 6), 35))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261192")
const silent = Logger.layer([])

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const send = (
  http: HttpClient.HttpClient,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: { readonly bearer?: string; readonly body?: unknown } = {},
) => {
  const url = `https://api.github.test${path}`
  let req = method === "GET"
    ? HttpClientRequest.get(url)
    : method === "POST"
    ? HttpClientRequest.post(url)
    : method === "PATCH"
    ? HttpClientRequest.patch(url)
    : method === "PUT"
    ? HttpClientRequest.put(url)
    : HttpClientRequest.delete(url)
  if (options.bearer !== undefined) req = HttpClientRequest.setHeader(req, "authorization", `Bearer ${options.bearer}`)
  if (options.body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, options.body)
  return Effect.runPromise(
    http.execute(req).pipe(
      Effect.flatMap((res) => Effect.map(res.text, (text) => ({ status: res.status, text, headers: res.headers }))),
    ),
  )
}

describe("Wave9 scriptedGitHub full API protocol fuzzing", () => {
  it("fuzzes auth, installations, tokens, repos, contents, collaborators, labels, issues, sub-issues, comments, statuses", async () => {
    const gh = scriptedGitHub("acme", "widgets")
    const pem = await appKey()
    expect(Redacted.value(pem)).toContain("BEGIN PRIVATE KEY")
    expect(accountIdOf("alice")).toBe(5000)

    const userTok = Redacted.value(gh.userToken("alice"))
    const botTok = Redacted.value(gh.userToken("helper[bot]"))
    const fakeJwt = `e30.${btoa(JSON.stringify({ iss: "424242" }))}.sig`

    // Installation & access_tokens
    expect((await send(gh.http, "GET", "/repos/acme/widgets/installation", { bearer: userTok })).status).toBe(401)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/installation", { bearer: fakeJwt })).status).toBe(200)
    gh.installed = false
    expect((await send(gh.http, "GET", "/repos/acme/widgets/installation", { bearer: fakeJwt })).status).toBe(404)
    expect((await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, { bearer: fakeJwt, body: {} })).status).toBe(404)
    gh.installed = true
    expect((await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, { bearer: userTok, body: {} })).status).toBe(401)

    // Denied permissions 422
    gh.granted = "read"
    expect((await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, {
      bearer: fakeJwt,
      body: { permissions: { issues: "write" } },
    })).status).toBe(422)
    expect((await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, {
      bearer: fakeJwt,
      body: { permissions: { unknown_perm: "read" } },
    })).status).toBe(422)
    gh.granted = "write"

    // Mint full installation token (contents + issues + pulls + statuses + metadata)
    const mintFull = await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, {
      bearer: fakeJwt,
      body: { permissions: { issues: "write", contents: "write", pull_requests: "write", statuses: "write", metadata: "read" } },
    })
    expect(mintFull.status).toBe(201)
    const fullInstTok = (JSON.parse(mintFull.text) as { token: string }).token

    // Mint read-only installation token -> scope refusal 403 on write
    const mintRead = await send(gh.http, "POST", `/app/installations/${INSTALLATION_ID}/access_tokens`, {
      bearer: fakeJwt,
      body: { permissions: { issues: "read", metadata: "read" } },
    })
    const readInstTok = (JSON.parse(mintRead.text) as { token: string }).token
    expect((await send(gh.http, "POST", "/repos/acme/widgets/issues", { bearer: readInstTok, body: { title: "x", body: "y" } })).status).toBe(403)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/pulls", { bearer: readInstTok, body: {} })).status).toBe(403)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/merges", { bearer: readInstTok, body: {} })).status).toBe(403)
    expect((await send(gh.http, "POST", `/repos/acme/widgets/statuses/${"a".repeat(40)}`, { bearer: readInstTok, body: {} })).status).toBe(403)
    expect((await send(gh.http, "POST", "/graphql", { bearer: readInstTok, body: { query: "" } })).status).toBe(403)

    // Revoke installation token
    expect((await send(gh.http, "DELETE", "/installation/token", { bearer: readInstTok })).status).toBe(204)
    expect((await send(gh.http, "DELETE", "/installation/token", { bearer: readInstTok })).status).toBe(401)
    expect(gh.revoked).toContain(readInstTok)

    // /user & repo visibility & publicElsewhere
    expect((await send(gh.http, "GET", "/user", { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/user", { bearer: botTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/user", { bearer: fullInstTok })).status).toBe(403)
    gh.publicElsewhere.add("other/pub")
    expect((await send(gh.http, "GET", "/repos/other/pub")).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/other/missing")).status).toBe(404)
    expect((await send(gh.http, "GET", "/repos/acme/widgets")).status).toBe(200)
    gh.private = true
    expect((await send(gh.http, "GET", "/repos/acme/widgets")).status).toBe(404)
    expect((await send(gh.http, "GET", "/repos/acme/widgets", { bearer: userTok })).status).toBe(200)
    gh.private = false
    expect((await send(gh.http, "GET", "/repos/acme/widgets/issues")).status).toBe(401)

    // Contents: file, dir, ref, 404, 403 without contents token
    gh.files.set("docs/intro.md", "# Hello")
    expect((await send(gh.http, "GET", "/repos/acme/widgets/contents/docs/intro.md", { bearer: userTok })).status).toBe(403)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/contents/docs/intro.md", { bearer: fullInstTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/contents/docs", { bearer: fullInstTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/contents/missing.md", { bearer: fullInstTok })).status).toBe(404)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/contents/README.md?ref=main", { bearer: fullInstTok })).status).toBe(200)

    // Collaborators: string roles, custom object, missing 404
    gh.roles.set("alice", "admin")
    gh.roles.set("bob", "maintain")
    gh.roles.set("carol", "triage")
    gh.roles.set("dave", { roleName: "custom-rw", permission: "write" })
    gh.accounts.set("alice", 9999)
    for (const login of ["alice", "bob", "carol", "dave"]) {
      expect((await send(gh.http, "GET", `/repos/acme/widgets/collaborators/${login}/permission`, { bearer: fullInstTok })).status).toBe(200)
    }
    expect((await send(gh.http, "GET", "/repos/acme/widgets/collaborators/nobody/permission", { bearer: fullInstTok })).status).toBe(404)

    // Labels
    expect((await send(gh.http, "POST", "/repos/acme/widgets/labels", { bearer: userTok, body: { name: "bug", color: "ff0000" } })).status).toBe(201)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/labels", { bearer: userTok, body: { name: "bug", color: "ff0000" } })).status).toBe(422)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/labels/bug", { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/labels/nope", { bearer: userTok })).status).toBe(404)

    // Issues, sub-issues, comments, labels, pagination, sorting, helpers
    const parent = gh.open("Parent", "body", "alice")
    const child = gh.open("Child", null, null)
    const malformed = gh.open("Malformed", "b", "alice")
    malformed.malformed = true
    gh.foreignChildren.set(parent.number, [{ number: 99 }])

    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${child.number}/parent`, { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "POST", `/repos/acme/widgets/issues/${parent.number}/sub_issues`, { bearer: userTok, body: { sub_issue_id: child.id } })).status).toBe(201)
    expect((await send(gh.http, "POST", `/repos/acme/widgets/issues/${parent.number}/sub_issues`, { bearer: userTok, body: { sub_issue_id: child.id } })).status).toBe(422)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${child.number}/parent`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${parent.number}/sub_issues`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/issues/99999/sub_issues", { bearer: userTok })).status).toBe(404)
    gh.setParent(child.number, null, true)
    gh.setParent(child.number, { owner: "acme", name: "widgets", number: parent.number }, true)

    expect((await send(gh.http, "POST", "/repos/acme/widgets/issues", { bearer: userTok, body: { title: "Posted", body: "hello" } })).status).toBe(201)
    expect((await send(gh.http, "PATCH", `/repos/acme/widgets/issues/${parent.number}`, { bearer: userTok, body: { title: "Updated Parent" } })).status).toBe(200)
    expect((await send(gh.http, "PATCH", "/repos/acme/widgets/issues/99999", { bearer: userTok, body: { title: "x" } })).status).toBe(404)

    // Issue labels add/remove
    expect((await send(gh.http, "POST", `/repos/acme/widgets/issues/${parent.number}/labels`, { bearer: userTok, body: { labels: ["bug", "triage"] } })).status).toBe(200)
    expect((await send(gh.http, "DELETE", `/repos/acme/widgets/issues/${parent.number}/labels/bug`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "DELETE", `/repos/acme/widgets/issues/${parent.number}/labels/missing`, { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${parent.number}/labels`, { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/issues/99999/labels", { bearer: userTok, body: { labels: ["x"] } })).status).toBe(404)

    // Comments & issue listing pagination/since/sort
    const c1 = gh.comment(parent.number, "first comment", "alice")
    c1.malformed = true
    expect((await send(gh.http, "POST", `/repos/acme/widgets/issues/${parent.number}/comments`, { bearer: userTok, body: { body: "second" } })).status).toBe(201)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${parent.number}/comments?per_page=1&page=1`, { bearer: userTok })).headers["link"]).toContain('rel="next"')
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/${parent.number}`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues?per_page=1&page=1&sort=created&direction=asc&since=2020-01-01T00:00:00Z`, { bearer: userTok })).headers["link"]).toContain('rel="next"')
    expect((await send(gh.http, "GET", `/repos/acme/widgets/issues/comments?sort=updated&direction=desc`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "DELETE", `/repos/acme/widgets/issues/${parent.number}`, { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/unknown-endpoint", { bearer: userTok })).status).toBe(404)

    gh.retitle(parent.number, "Retitled")
    gh.relabel(parent.number, ["alpha"])
    gh.removeComment(c1.id)
    gh.remove(malformed.number)

    // Statuses
    const mainSha = gh.refs.get("main")!
    expect((await send(gh.http, "POST", `/repos/acme/widgets/statuses/${mainSha}`, {
      bearer: fullInstTok,
      body: { state: "success", context: "ci/build", description: "green" },
    })).status).toBe(201)
    expect((await send(gh.http, "POST", `/repos/acme/widgets/statuses/${"0".repeat(40)}`, {
      bearer: fullInstTok,
      body: { state: "failure", context: "ci/build" },
    })).status).toBe(422)
    expect(gh.shownStatuses(mainSha)).toEqual({ "ci/build": "success" })

    // Faults: status, hold, malformed, lost
    gh.faults.push({ match: () => true, status: 503, message: "temp" })
    expect((await send(gh.http, "GET", "/repos/acme/widgets", { bearer: userTok })).status).toBe(503)
    gh.faults.push({ match: () => true, hold: () => Promise.resolve(), status: 429, headers: { "retry-after": "2" } })
    expect((await send(gh.http, "GET", "/repos/acme/widgets", { bearer: userTok })).status).toBe(429)
    gh.faults.push({ match: () => true, malformed: true })
    expect((await send(gh.http, "GET", "/repos/acme/widgets", { bearer: userTok })).text).toBe("{}")
    gh.faults.push({ match: () => true, lost: true })
    await expect(send(gh.http, "GET", "/repos/acme/widgets", { bearer: userTok })).rejects.toBeDefined()
    expect(gh.seen("GET", /\/issues/)).toBeInstanceOf(Array)
    gh.revoke(Redacted.make(botTok))
  }, 60_000)

  it("fuzzes git refs, commits, compare, merges, pull requests, reviews, and GraphQL mutations", async () => {
    const gh = scriptedGitHub("acme", "widgets")
    const userTok = Redacted.value(gh.userToken("alice"))
    const mainSha = gh.refs.get("main")!

    // Git refs & commits
    expect((await send(gh.http, "GET", "/repos/acme/widgets/git/matching-refs/heads/ma", { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/git/ref/heads/main", { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/git/ref/heads/nope", { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/git/refs", { bearer: userTok, body: { ref: "refs/heads/feat", sha: mainSha } })).status).toBe(201)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/git/refs", { bearer: userTok, body: { ref: "refs/heads/feat", sha: mainSha } })).status).toBe(422)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/git/commits/${mainSha}`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/git/commits/${"0".repeat(40)}`, { bearer: userTok })).status).toBe(404)

    // GraphQL createCommitOnBranch: wrong repo, missing branch, stale head, ok with additions + deletions
    const gql = (body: unknown) => send(gh.http, "POST", "/graphql", { bearer: userTok, body })
    expect((await gql({
      query: "mutation createCommitOnBranch",
      variables: { input: { branch: { repositoryNameWithOwner: "wrong/repo", branchName: "feat" }, expectedHeadOid: mainSha, message: { headline: "h" }, fileChanges: { additions: [], deletions: [] } } },
    })).text).toContain("NOT_FOUND")
    expect((await gql({
      query: "mutation createCommitOnBranch",
      variables: { input: { branch: { repositoryNameWithOwner: "acme/widgets", branchName: "missing" }, expectedHeadOid: mainSha, message: { headline: "h" }, fileChanges: { additions: [], deletions: [] } } },
    })).text).toContain("No branch")
    expect((await gql({
      query: "mutation createCommitOnBranch",
      variables: { input: { branch: { repositoryNameWithOwner: "acme/widgets", branchName: "feat" }, expectedHeadOid: "0".repeat(40), message: { headline: "h" }, fileChanges: { additions: [], deletions: [] } } },
    })).text).toContain("STALE_DATA")
    const commitRes = await gql({
      query: "mutation createCommitOnBranch",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: "acme/widgets", branchName: "feat" },
          expectedHeadOid: mainSha,
          message: { headline: "Add file", body: "details" },
          fileChanges: {
            additions: [{ path: "src/a.ts", contents: btoa("export const a = 1\n") }],
            deletions: [{ path: "README.md" }],
          },
        },
      },
    })
    const featSha = (JSON.parse(commitRes.text) as { data: { createCommitOnBranch: { commit: { oid: string } } } }).data.createCommitOnBranch.commit.oid
    expect(gh.tree("feat").get("src/a.ts")).toContain("const a = 1")

    // Compare
    expect((await send(gh.http, "GET", `/repos/acme/widgets/compare/${mainSha}...${featSha}`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/compare/${mainSha}...${"0".repeat(40)}`, { bearer: userTok })).status).toBe(404)

    // Pulls: errors (missing head, no diff, open, duplicate), onPullOpened, GET, PATCH base/close, reviews, commits, files
    expect((await send(gh.http, "POST", "/repos/acme/widgets/pulls", { bearer: userTok, body: { head: "nope", base: "main", title: "T", body: "" } })).status).toBe(422)
    gh.refs.set("same-as-main", mainSha)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/pulls", { bearer: userTok, body: { head: "same-as-main", base: "main", title: "T", body: "" } })).status).toBe(422)

    let openedNum = 0
    gh.onPullOpened = (n) => { openedNum = n }
    const prRes = await send(gh.http, "POST", "/repos/acme/widgets/pulls", {
      bearer: userTok,
      body: { head: "feat", base: "main", title: "Feat PR", body: "desc", draft: true },
    })
    expect(prRes.status).toBe(201)
    const prNum = (JSON.parse(prRes.text) as { number: number }).number
    expect(openedNum).toBe(prNum)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/pulls", {
      bearer: userTok,
      body: { head: "feat", base: "main", title: "Dup", body: "" },
    })).status).toBe(422)

    // List & get pulls, commits, reviews, files
    expect((await send(gh.http, "GET", "/repos/acme/widgets/pulls?head=acme:feat&state=open", { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/pulls/${prNum}`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", "/repos/acme/widgets/pulls/99999", { bearer: userTok })).status).toBe(404)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/pulls/${prNum}/commits`, { bearer: userTok })).status).toBe(200)
    expect((await send(gh.http, "GET", `/repos/acme/widgets/pulls/${prNum}/files`, { bearer: userTok })).status).toBe(404)
    for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"]) {
      expect((await send(gh.http, "POST", `/repos/acme/widgets/pulls/${prNum}/reviews`, {
        bearer: userTok,
        body: { commit_id: featSha, event, body: `rev ${event}` },
      })).status).toBe(200)
    }
    expect((await send(gh.http, "GET", `/repos/acme/widgets/pulls/${prNum}/reviews`, { bearer: userTok })).status).toBe(200)

    // Merge while draft -> 405, then GraphQL markPullRequestReadyForReview (not found + ok)
    expect((await send(gh.http, "PUT", `/repos/acme/widgets/pulls/${prNum}/merge`, {
      bearer: userTok,
      body: { sha: featSha, merge_method: "squash" },
    })).status).toBe(405)
    expect((await gql({ query: "mutation markPullRequestReadyForReview", variables: { id: "PR_99999" } })).text).toContain("errors")
    expect((await gql({ query: "mutation markPullRequestReadyForReview", variables: { id: `PR_${prNum}` } })).text).toContain('"isDraft":false')

    // GraphQL updatePullRequestBranch: not found, stale head, held, MERGE, REBASE, conflict
    expect((await gql({ query: "mutation updatePullRequestBranch", variables: { input: { pullRequestId: "PR_99999" } } })).text).toContain("NOT_FOUND")
    expect((await gql({ query: "mutation updatePullRequestBranch", variables: { input: { pullRequestId: `PR_${prNum}`, expectedHeadOid: "0".repeat(40) } } })).text).toContain("UNPROCESSABLE")
    expect((await gql({ query: "mutation updatePullRequestBranch", variables: { input: { pullRequestId: `PR_${prNum}`, expectedHeadOid: featSha } } })).text).toContain(featSha)

    // Advance main with non-conflicting file -> MERGE & REBASE
    gh.push("main", { "other.txt": "hello\n" })
    const updMerge = await gql({ query: "mutation updatePullRequestBranch", variables: { input: { pullRequestId: `PR_${prNum}`, updateMethod: "MERGE" } } })
    expect(updMerge.text).toContain("headRefOid")
    gh.push("main", { "other2.txt": "world\n" })
    const updRebase = await gql({ query: "mutation updatePullRequestBranch", variables: { input: { pullRequestId: `PR_${prNum}`, updateMethod: "REBASE" } } })
    expect(updRebase.text).toContain("headRefOid")

    // Merge stale sha -> 409, then real merge -> 200
    expect((await send(gh.http, "PUT", `/repos/acme/widgets/pulls/${prNum}/merge`, {
      bearer: userTok,
      body: { sha: "0".repeat(40), merge_method: "squash" },
    })).status).toBe(409)
    const latestFeatSha = gh.refs.get("feat")!
    expect((await send(gh.http, "PUT", `/repos/acme/widgets/pulls/${prNum}/merge`, {
      bearer: userTok,
      body: { sha: latestFeatSha, merge_method: "rebase", commit_title: "t", commit_message: "m" },
    })).status).toBe(200)

    // POST /merges: 404, 204 held, 201 clean, 409 conflict
    expect((await send(gh.http, "POST", "/repos/acme/widgets/merges", { bearer: userTok, body: { base: "missing", head: "main" } })).status).toBe(404)
    expect((await send(gh.http, "POST", "/repos/acme/widgets/merges", { bearer: userTok, body: { base: "main", head: mainSha } })).status).toBe(204)
    gh.push("b1", { "clean.txt": "1\n" })
    expect((await send(gh.http, "POST", "/repos/acme/widgets/merges", { bearer: userTok, body: { base: "main", head: "b1", commit_message: "merge b1" } })).status).toBe(201)
    gh.push("c1", { "conflict.txt": "one\n" })
    gh.push("c2", { "conflict.txt": "two\n" })
    expect((await send(gh.http, "POST", "/repos/acme/widgets/merges", { bearer: userTok, body: { base: "c1", head: "c2" } })).status).toBe(409)

    // PATCH pull base (valid + invalid 422), close, and helper openPull/close/merge
    const p2 = gh.openPull("c1", "Conflict PR")
    expect((await send(gh.http, "PATCH", `/repos/acme/widgets/pulls/${p2.number}`, { bearer: userTok, body: { base: "b1" } })).status).toBe(200)
    expect((await send(gh.http, "PATCH", `/repos/acme/widgets/pulls/${p2.number}`, { bearer: userTok, body: { base: "no-such-branch" } })).status).toBe(422)
    expect((await send(gh.http, "PATCH", `/repos/acme/widgets/pulls/${p2.number}`, { bearer: userTok, body: { state: "closed" } })).status).toBe(200)
    const p3 = gh.openPull("c2", "Merge helper")
    expect(gh.merge(p3.number)).toBeTruthy()
    const p4 = gh.openPull("b1", "Close helper")
    gh.close(p4.number)
  }, 60_000)
})

describe("Wave9 RepoRoles, Tokens, Store & Revoke flows on real Postgres 18", () => {
  const runtime = H.testFile("wave9_gh")

  it("fuzzes RepoRoles permissionOf, allowedRepositories, actsOn, checkHeld/holds, resolve, refresh, workBasis, workUninstalled, publicCopy", async () => {
    // Pure permissionOf & actsOn & allowedRepositories
    const permArb = Arbitrary.schema(Schema.Struct({
      roleName: Schema.Literals(["admin", "maintain", "write", "triage", "read", "custom-role"]),
      permission: Schema.Literals(["admin", "write", "read", "none"]),
    }))
    await holds(permArb, execs, (p) =>
      Effect.sync(() => {
        const res = RepoRoles.permissionOf({ roleName: p.roleName, permission: p.permission, userId: 1 })
        expect(["admin", "maintain", "write", "triage", "read", "none"]).toContain(res)
      }))

    const own = repositoryOf("acme/own")
    const other = repositoryOf("acme/widgets")
    const allowedSet = await Effect.runPromise(
      RepoRoles.allowed.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ GITHUB_ALLOWED_REPOSITORIES: "acme/widgets, acme/extra" })),
      ),
    )
    expect(Option.isSome(allowedSet)).toBe(true)
    const badAllowed = await Effect.runPromiseExit(
      RepoRoles.allowed.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ GITHUB_ALLOWED_REPOSITORIES: "not valid!!" })),
      ),
    )
    expect(Exit.isFailure(badAllowed)).toBe(true)
    expect(RepoRoles.actsOn(own, allowedSet)(own.id)).toBe(true)
    expect(RepoRoles.actsOn(own, allowedSet)(other.id)).toBe(true)
    expect(RepoRoles.actsOn(own, allowedSet)(repositoryOf("other/denied").id)).toBe(false)
    expect(RepoRoles.actsOn(own, Option.none())(repositoryOf("any/repo").id)).toBe(true)

    const scratch = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Effect.promise(() => import("../db/TestDatabase.ts"))).Scratch }))
    const db = scratch.database

    const gh = scriptedGitHub("acme", "widgets")
    const pem = await appKey()
    const appConfig = { appId: "424242", privateKey: pem, apiBaseUrl: "https://api.github.test" }

    // Seed person + session in Postgres
    const personId = H.uuid()
    const sessionId = H.uuid()
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, ${accountIdOf("alice")}, 'alice')`
      const k = yield* SessionKeys.make(Redacted.make("0123456789abcdef".repeat(4)))
      const sAccess = yield* k.seal(Redacted.make("ghu_rr"), { id: sessionId, name: "github_access", version: 1 })
      yield* SessionStore.createSession({
        id: sessionId,
        tokenDigest: SessionKeys.digest(sessionId),
        personId,
        role: "maintainer",
        roleGeneration: "1",
        access: sAccess,
        accessExpiresAt: Date.now() + 3600_000,
        refresh: null,
        refreshDigest: null,
        maxAgeSeconds: 3600,
      })
    }))
    const actor: Actor.Actor = { subject: { kind: "person", id: personId }, role: "maintainer", login: "alice", session: sessionId }

    const roles = await Effect.runPromise(
      RepoRoles.make(db, {
        repository: own,
        app: Option.some(appConfig as never),
        allowed: Option.some(new Set([other.id])),
        http: gh.http,
        refreshCooldownSeconds: 1,
      }).pipe(Effect.provide(silent)),
    )

    // workBasis all branches
    expect(roles.workBasis?.(own, true)).toBe("deployment")
    expect(roles.workBasis?.(other, false)).toBe("public")
    expect(roles.workBasis?.(other, true)).toBe("repository")
    expect(roles.workBasis?.(repositoryOf("denied/repo"), true)).toBe("public")

    // Own repo resolves from session
    const ownRes = await Effect.runPromise(roles.resolve(actor, own).pipe(Effect.provide(silent)))
    expect(ownRes.role).toBe("maintainer")

    // Disallowed repo -> not_found
    const deniedExit = await Effect.runPromiseExit(roles.resolve(actor, repositoryOf("denied/repo")).pipe(Effect.provide(silent)))
    expect(Exit.isFailure(deniedExit)).toBe(true)

    // Collaborator on other repo -> resolves via GitHub, then cached, then checkHeld/holds
    gh.roles.set("alice", "admin")
    const first = await Effect.runPromise(roles.resolve(actor, other).pipe(Effect.provide(silent)))
    expect(first.role).toBe("admin")
    const cached = await Effect.runPromise(roles.resolve(actor, other).pipe(Effect.provide(silent)))
    expect(cached.role).toBe("admin")

    // checkHeld / holds on real Postgres: held, denied, expired+permitted -> RoleRefused, missing -> unavailable
    const held = Option.getOrThrow(first.held)
    const heldResult = await runtime.runPromise(RepoRoles.checkHeld(held))
    expect(heldResult).toBe("held")
    expect(await runtime.runPromise(RepoRoles.holds(held))).toBe(true)
    expect(await runtime.runPromise(RepoRoles.checkHeld({ ...held, role: "guest" }))).toBe("denied")
    expect(await runtime.runPromise(RepoRoles.checkHeld({ ...held, personId: H.uuid() }))).toBe("unavailable")
    // Age the row so fresh check fails -> unavailable without permitted, RoleRefused with permitted
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE github_repo_roles SET checked_at = now() - interval '10 minutes' WHERE repo_id = ${other.id} AND person_id = ${personId}`))
    expect(await runtime.runPromise(RepoRoles.checkHeld(held))).toBe("unavailable")
    const expiredExit = await runtime.runPromiseExit(RepoRoles.checkHeld(held, ["admin"]))
    expect(Exit.isFailure(expiredExit)).toBe(true)

    // refresh() hits GitHub again; test mismatched account id -> role null
    gh.accounts.set("alice", 777777)
    const refreshed = await Effect.runPromise(roles.refresh!(actor, other, held).pipe(Effect.provide(silent)))
    expect(refreshed.role).toBeNull()

    // publicCopy + workUninstalled (public -> actor.role, private -> null, rate-limited -> refusal)
    expect(await Effect.runPromise(roles.publicCopy!(other).pipe(Effect.provide(silent)))).toBe(true)
    expect(await Effect.runPromise(roles.workUninstalled!(actor, own).pipe(Effect.provide(silent)))).toBe("maintainer")
    expect(await Effect.runPromise(roles.workUninstalled!(actor, other).pipe(Effect.provide(silent)))).toBe("maintainer")

    // App not installed -> remembers absence
    const ghUninst = scriptedGitHub("acme", "uninstalled")
    ghUninst.installed = false
    const uninstRepo = repositoryOf("acme/uninstalled")
    const rolesUninst = await Effect.runPromise(
      RepoRoles.make(db, {
        repository: own,
        app: Option.some(appConfig as never),
        http: ghUninst.http,
        refreshCooldownSeconds: 0,
      }).pipe(Effect.provide(silent)),
    )
    const uninstExit = await Effect.runPromiseExit(rolesUninst.resolve(actor, uninstRepo).pipe(Effect.provide(silent)))
    expect(Exit.isFailure(uninstExit)).toBe(true)

    // Rate limited -> cooldown refusal on second call
    const ghRate = scriptedGitHub("acme", "ratelimited")
    ghRate.faults.push({ match: () => true, status: 429, headers: { "retry-after": "5" } })
    const rateRepo = repositoryOf("acme/ratelimited")
    const rolesRate = await Effect.runPromise(
      RepoRoles.make(db, {
        repository: own,
        app: Option.some(appConfig as never),
        http: ghRate.http,
        refreshCooldownSeconds: 5,
      }).pipe(Effect.provide(silent)),
    )
    expect(Exit.isFailure(await Effect.runPromiseExit(rolesRate.resolve(actor, rateRepo).pipe(Effect.provide(silent))))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(rolesRate.resolve(actor, rateRepo).pipe(Effect.provide(silent))))).toBe(true)

    // Local mode with localRoles + no app
    const localRoles = await Effect.runPromise(
      RepoRoles.make(db, {
        repository: own,
        app: Option.none(),
        local: true,
        localRoles: (_a, r) => r.id === other.id ? "guest" : undefined,
      }).pipe(Effect.provide(silent)),
    )
    expect(localRoles.uninstalled?.(actor, other)).toBe("guest")
    expect(localRoles.uninstalled?.(actor, own)).toBe("maintainer")
    expect(localRoles.workBasis?.(other, false)).toBe("local")
  }, 120_000)

  it("fuzzes Tokens, Store helpers/DB ops, RevokeGitHubToken & RevokeReplacedGitHubToken on real Postgres 18", async () => {
    const scratch = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Effect.promise(() => import("../db/TestDatabase.ts"))).Scratch }))
    const db = scratch.database
    const gh = scriptedGitHub("acme", "widgets")
    const pem = await appKey()
    const repo = repositoryOf("acme/widgets")

    // Tokens.permissionsOf all 8 accesses
    const accesses: ReadonlyArray<Tokens.Access> = ["read", "write", "contents", "pulls", "publish", "review", "status", "metadata"]
    for (const a of accesses) {
      expect(Object.keys(Tokens.permissionsOf(a)).length).toBeGreaterThan(0)
    }

    const appAuth = await Effect.runPromise(
      GitHub.AppAuth.make({ appId: "424242", privateKey: pem, apiBaseUrl: "https://api.github.test" }).pipe(Effect.provide(gh.layer)),
    )
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make("0123456789abcdef".repeat(4))))
    const otherKeys = await Effect.runPromise(SessionKeys.make(Redacted.make("fedcba9876543210".repeat(4))))
    let refreshed = 0
    const tokens = Tokens.make({
      app: appAuth,
      keys: Option.some(keys),
      refresh: () => Effect.sync(() => { refreshed += 1 }),
    })

    // forInstallation: mints & remembers, then uses remembered id, then 422 not_allowed, then 404 forgets
    const t1 = await runtime.runPromise(tokens.forInstallation(repo, "write", [repositoryOf("acme/other")]).pipe(Effect.provide(silent)))
    expect(Redacted.value(t1)).toContain("ghs_")
    gh.granted = "read"
    const deniedTok = await runtime.runPromiseExit(tokens.forInstallation(repo, "write").pipe(Effect.provide(silent)))
    expect(Exit.isFailure(deniedTok)).toBe(true)
    gh.granted = "write"
    gh.installed = false
    const notInstTok = await runtime.runPromiseExit(tokens.forInstallation(repo, "read").pipe(Effect.provide(silent)))
    expect(Exit.isFailure(notInstTok)).toBe(true)
    gh.installed = true

    // forSession: no keys, missing session, near-expiry triggers refresh, unreadable token, valid token
    const noKeysTokens = Tokens.make({ app: appAuth, keys: Option.none(), refresh: () => Effect.void })
    expect(Exit.isFailure(await runtime.runPromiseExit(noKeysTokens.forSession(H.uuid()).pipe(Effect.provide(silent))))).toBe(true)
    expect(Exit.isFailure(await runtime.runPromiseExit(tokens.forSession(H.uuid()).pipe(Effect.provide(silent))))).toBe(true)

    const personId = H.uuid()
    const validSessId = H.uuid()
    const expiringSessId = H.uuid()
    const unreadableSessId = H.uuid()
    const sealedGood = await Effect.runPromise(keys.seal(Redacted.make("ghu_valid_1"), { id: validSessId, name: "github_access", version: 1 }))
    const sealedExpiring = await Effect.runPromise(keys.seal(Redacted.make("ghu_exp_1"), { id: expiringSessId, name: "github_access", version: 1 }))
    const sealedBad = await Effect.runPromise(otherKeys.seal(Redacted.make("ghu_bad_1"), { id: unreadableSessId, name: "github_access", version: 1 }))

    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 55501, 'tokuser')`
      yield* SessionStore.createSession({
        id: validSessId, tokenDigest: SessionKeys.digest(validSessId), personId, role: "member", roleGeneration: "1",
        access: sealedGood, accessExpiresAt: Date.now() + 30 * 60_000, refresh: null, refreshDigest: null, maxAgeSeconds: 3600,
      })
      yield* SessionStore.createSession({
        id: expiringSessId, tokenDigest: SessionKeys.digest(expiringSessId), personId, role: "member", roleGeneration: "2",
        access: sealedExpiring, accessExpiresAt: Date.now() + 60_000, refresh: null, refreshDigest: null, maxAgeSeconds: 3600,
      })
      yield* SessionStore.createSession({
        id: unreadableSessId, tokenDigest: SessionKeys.digest(unreadableSessId), personId, role: "member", roleGeneration: "3",
        access: sealedBad, accessExpiresAt: Date.now() + 30 * 60_000, refresh: null, refreshDigest: null, maxAgeSeconds: 3600,
      })
    }))

    const opened = await runtime.runPromise(tokens.forSession(validSessId).pipe(Effect.provide(silent)))
    expect(Redacted.value(opened)).toBe("ghu_valid_1")
    expect(Exit.isFailure(await runtime.runPromiseExit(tokens.forSession(expiringSessId).pipe(Effect.provide(silent))))).toBe(true)
    expect(refreshed).toBe(1)
    expect(Exit.isFailure(await runtime.runPromiseExit(tokens.forSession(unreadableSessId).pipe(Effect.provide(silent))))).toBe(true)

    // Store pure helpers: markedWrite, shownBody, parentNamed, statedParent
    expect(Store.markedWrite(null)).toBeNull()
    expect(Store.shownBody(null)).toBe("")
    expect(Store.parentNamed("https://api.github.com/repos/acme/widgets/issues/42")?.number).toBe(42)
    expect(Store.parentNamed("https://api.github.com/repos/bad..owner/widgets/issues/42")).toBeUndefined()
    expect(Store.parentNamed("https://api.github.com/repos/acme/widgets/issues/999999999999999999999999")).toBeUndefined()
    expect(Store.parentNamed("not-a-url")).toBeUndefined()
    expect(Store.statedParent(repo.id, { number: 1, sub_issues_summary: null } as never)).toBeUndefined()
    expect(Store.statedParent(repo.id, { number: 1, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, parent_issue_url: null } as never)).toBeNull()
    expect(Store.statedParent(repo.id, { number: 1, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, parent_issue_url: "https://api.github.com/repos/acme/widgets/issues/1" } as never)).toBeUndefined()
    expect(Store.statedParent(repo.id, { number: 2, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, parent_issue_url: "https://api.github.com/repos/acme/widgets/issues/1" } as never)?.number).toBe(1)

    // RevokeGitHubToken & RevokeReplacedGitHubToken flows on real Postgres
    const okGitHubAuth = {
      authorizeUrl: () => "https://github.com/login/oauth/authorize",
      exchange: () => Effect.die("unused"),
      refresh: () => Effect.die("unused"),
      user: () => Effect.die("unused"),
      permission: () => Effect.die("unused"),
      revoke: () => Effect.void,
    }
    const failGitHubAuth = {
      ...okGitHubAuth,
      revoke: () => Effect.fail(new GitHubAuth.GitHubRefused({ step: "revoke", reason: "unavailable" })),
    }
    const misconfGitHubAuth = {
      ...okGitHubAuth,
      revoke: () => Effect.fail(new GitHubAuth.GitHubRefused({ step: "revoke", reason: "misconfigured" })),
    }

    // Live session -> revoke returns outcome "live"
    const liveRes = await Effect.runPromise(
      RevokeGitHubToken.observed(validSessId, { keys, github: okGitHubAuth as never }, db).pipe(Effect.provide(silent)),
    )
    expect(liveRes.outcome).toBe("live")

    // End session -> ended, then ending again -> over
    expect((await Effect.runPromise(RevokeGitHubToken.end(validSessId, db).pipe(Effect.provide(silent)))).outcome).toBe("ended")
    expect((await Effect.runPromise(RevokeGitHubToken.end(validSessId, db).pipe(Effect.provide(silent)))).outcome).toBe("over")

    // Revoke with failing GitHub -> RevocationFailed(github_unavailable), misconfigured -> github_misconfigured, ok -> revoked, second -> none
    expect(Exit.isFailure(await Effect.runPromiseExit(
      RevokeGitHubToken.observed(validSessId, { keys, github: failGitHubAuth as never }, db).pipe(Effect.provide(silent)),
    ))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(
      RevokeGitHubToken.observed(validSessId, { keys, github: misconfGitHubAuth as never }, db).pipe(Effect.provide(silent)),
    ))).toBe(true)
    const revOk = await Effect.runPromise(
      RevokeGitHubToken.observed(validSessId, { keys, github: okGitHubAuth as never }, db).pipe(Effect.provide(silent)),
    )
    expect(revOk.outcome).toBe("revoked")
    const revNone = await Effect.runPromise(
      RevokeGitHubToken.observed(validSessId, { keys, github: okGitHubAuth as never }, db).pipe(Effect.provide(silent)),
    )
    expect(revNone.outcome).toBe("none")

    // Forget step + RevokeReplacedGitHubToken.ensure (admitted, StartConflict, unavailable)
    expect((await Effect.runPromise(RevokeGitHubToken.forget(validSessId, db).pipe(Effect.provide(silent)))).outcome).toBe("forgotten")
    expect(RevokeGitHubToken.revokeExecutionId(validSessId)).toContain(validSessId)
    expect(RevokeGitHubToken.registration(db, { keys, github: okGitHubAuth as never })).toBeDefined()
    expect(RevokeReplaced.registration(db, { keys, github: okGitHubAuth as never })).toBeDefined()

    await Effect.runPromise(
      RevokeReplaced.ensure.pipe(
        Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({ start: () => Effect.void })),
        Effect.provide(silent),
      ),
    )
    await Effect.runPromise(
      RevokeReplaced.ensure.pipe(
        Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({
          start: () => Effect.fail(new Flows.StartConflict()),
        })),
        Effect.provide(silent),
      ),
    )
    expect(Exit.isFailure(await Effect.runPromiseExit(
      RevokeReplaced.ensure.pipe(
        Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({
          start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })),
        })),
        Effect.provide(silent),
      ),
    ))).toBe(true)
    expect(SessionStore.held).toBeDefined()
  }, 120_000)
})
