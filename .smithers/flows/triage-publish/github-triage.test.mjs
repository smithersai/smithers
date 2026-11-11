import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { once } from "node:events"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { apply, BOT_LOGIN, botLogin, fallbackReport, neutralizeMentions, prepare, validateReport } from "./github-triage.mjs"

const documentedReports = (kind) => {
  const source = readFileSync(new URL(`../${kind}-triage/flow.mdx`, import.meta.url), "utf8")
  const examples = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]))
  assert.ok(examples.length > 0, `flows/${kind}-triage/flow.mdx documents no report example`)
  return examples
}

describe("GitHub triage report contract", () => {
  it("accepts a reproduced issue and rejects contradictory status", () => {
    const report = {
      kind: "issue",
      summary: "The timeout is reproducible.",
      comment: "Run the focused test.",
      labels: ["kind:bug", "status:reproduced"],
      reproduction: { status: "reproduced", details: "pnpm test timeout.test.ts fails" }
    }
    assert.ok(validateReport(report, "issue"))
    assert.equal(validateReport({ ...report, labels: ["kind:bug"] }, "issue"), null)
  })

  it("requires PR readiness to agree with its checks", () => {
    const report = {
      kind: "pr",
      summary: "Ready for review.",
      comment: "The scope, tests, and docs are ready.",
      labels: ["status:ready-for-review"],
      checks: { description: "pass", tests: "pass", docs: "not-applicable", size: "pass" }
    }
    assert.ok(validateReport(report, "pr"))
    report.checks.tests = "needs-work"
    assert.equal(validateReport(report, "pr"), null)
  })

  it("asks the issue opener for concrete reproduction evidence on failure", () => {
    const report = fallbackReport("issue", "missing report")
    assert.equal(report.reproduction.status, "needs-author")
    assert.match(report.comment, /exact Smithers version/)
    assert.match(report.comment, /smallest command or flow/)
  })

  it("rejects unknown labels and oversized comments", () => {
    const base = fallbackReport("issue", "invalid")
    assert.equal(validateReport({ ...base, labels: ["security:trusted"] }, "issue"), null)
    assert.equal(validateReport({ ...base, comment: "x".repeat(60_001) }, "issue"), null)
  })

  for (const label of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    it(`rejects inherited label ${label}`, () => {
      const base = fallbackReport("issue", "invalid")
      assert.equal(validateReport({ ...base, labels: [...base.labels, label] }, "issue"), null)
    })
  }

  it("accepts every report example the triage flows document", () => {
    for (const kind of ["issue", "pr"]) {
      for (const example of documentedReports(kind)) {
        assert.ok(validateReport(example, kind), `flows/${kind}-triage/flow.mdx documents a report the publisher rejects`)
      }
    }
  })
})

describe("GitHub triage preparation", () => {
  it("includes paginated issue comments in the context, bounded to three pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-triage-"))
    const previous = { cwd: process.cwd(), token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY, fetch: globalThis.fetch }
    const pages = []
    try {
      process.chdir(root)
      process.env.GH_TOKEN = "test-token"
      delete process.env.GITHUB_REPOSITORY
      const eventPath = join(root, "event.json")
      writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, issue: { number: 42, title: "Issue", user: { login: "opener" } } }))
      globalThis.fetch = async (url) => {
        pages.push(url)
        const page = Number(new URL(url).searchParams.get("page"))
        const rows = Array.from({ length: 100 }, (_, index) => ({
          user: { login: `author-${page}-${index}` },
          body: `comment-${page}-${index}`,
          created_at: "2026-01-02T00:00:00Z"
        }))
        return { ok: true, json: async () => rows }
      }
      const context = await prepare("issue", eventPath)
      assert.deepEqual(pages, [1, 2, 3].map((page) => `https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=${page}`))
      assert.equal(context.comments.length, 300)
      assert.deepEqual(context.comments[100], { author: "author-2-0", body: "comment-2-0", createdAt: "2026-01-02T00:00:00Z" })
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".triage/context.json"), "utf8")).comments, context.comments)
      pages.length = 0
      globalThis.fetch = async (url) => {
        pages.push(url)
        return { ok: true, json: async () => [{ user: { login: "last" }, body: "only comment", created_at: "2026-01-03T00:00:00Z" }] }
      }
      const shortContext = await prepare("issue", eventPath)
      assert.equal(pages.length, 1)
      assert.deepEqual(shortContext.comments, [{ author: "last", body: "only comment", createdAt: "2026-01-03T00:00:00Z" }])
    } finally {
      globalThis.fetch = previous.fetch
      process.chdir(previous.cwd)
      if (previous.token === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previous.token
      if (previous.repository === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = previous.repository
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("GitHub triage entry point", () => {
  it("runs main from a checkout path that contains a space", async () => {
    const { spawnSync } = await import("node:child_process")
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "smithers triage "))
    try {
      mkdirSync(join(root, "packages", "repo-targets", "scripts"), { recursive: true })
      mkdirSync(join(root, ".smithers", "flows", "triage-publish"), { recursive: true })
      copyFileSync(new URL("./github-triage.mjs", import.meta.url), join(root, ".smithers", "flows", "triage-publish", "github-triage.mjs"))
      copyFileSync(new URL("../../../packages/repo-targets/scripts/workspace-packages.mjs", import.meta.url), join(root, "packages/repo-targets/scripts/workspace-packages.mjs"))
      // The membership reader imports the pinned `yaml` and `tinyglobby`.
      symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
      const result = spawnSync(process.execPath, [join(root, ".smithers", "flows", "triage-publish", "github-triage.mjs")], { encoding: "utf8", timeout: 30_000 })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /usage: github-triage\.mjs/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("GitHub triage publisher", () => {
  // The flow runs repository tests between prepare and apply, so anything in
  // .triage/ except the report may have been rewritten by untrusted code.
  const publish = async ({ comments, report, expected = 7, event = { issue: { number: 7 } }, login, labels = [], repeat = 1, failPage }) => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "smithers-triage-apply-"))
    const previous = {
      cwd: process.cwd(),
      fetch: globalThis.fetch,
      token: process.env.GH_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      login: process.env.TRIAGE_BOT_LOGIN
    }
    const calls = []
    let closeServer
    try {
      mkdirSync(join(root, ".triage"))
      writeFileSync(join(root, ".triage/context.json"), JSON.stringify({ kind: "issue", repository: "victim/elsewhere", number: 999 }))
      writeFileSync(join(root, ".triage/report.json"), JSON.stringify(report))
      const eventPath = join(root, "event.json")
      writeFileSync(eventPath, JSON.stringify(event))
      process.chdir(root)
      process.env.GH_TOKEN = "test-token"
      process.env.GITHUB_REPOSITORY = "owner/repo"
      if (login === undefined) delete process.env.TRIAGE_BOT_LOGIN
      else process.env.TRIAGE_BOT_LOGIN = login
      // Exercise the real HTTP client against a stateful local GitHub service.
      // Only routing changes; pagination, mutation and error responses cross HTTP.
      const server = createServer(async (request, response) => {
        const url = new URL(request.url, "https://api.github.com")
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const bytes = Buffer.concat(chunks).toString()
        const call = { url: url.href, method: request.method, body: bytes ? JSON.parse(bytes) : undefined }
        calls.push(call)
        let payload = {}
        const page = Number(url.searchParams.get("page") ?? 1)
        const paginate = (rows) => rows.slice((page - 1) * 100, page * 100)
        if (call.method === "GET" && url.pathname.endsWith("/comments")) {
          if (page === failPage) {
            response.writeHead(503)
            response.end("unavailable")
            return
          }
          payload = paginate(comments)
        } else if (url.pathname.endsWith("/issues/7/labels")) {
          if (call.method === "GET") payload = paginate(labels).map((name) => ({ name }))
          if (call.method === "POST") for (const label of call.body.labels) if (!labels.includes(label)) labels.push(label)
        } else if (call.method === "DELETE") {
          const label = decodeURIComponent(url.pathname.split("/").at(-1))
          const index = labels.indexOf(label)
          if (index >= 0) labels.splice(index, 1)
          response.writeHead(204)
          response.end()
          return
        }
        if (call.method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
          comments.push({ id: comments.length + 1, user: { login: login ?? BOT_LOGIN }, body: call.body.body })
        }
        if (call.method === "PATCH") {
          const comment = comments.find(({ id }) => id === Number(url.pathname.split("/").at(-1)))
          assert.ok(comment, "only an existing comment can be updated")
          comment.body = call.body.body
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(payload))
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      const origin = `http://127.0.0.1:${server.address().port}`
      globalThis.fetch = (url, options) => previous.fetch(new URL(new URL(url).pathname + new URL(url).search, origin), options)
      for (let run = 0; run < repeat; run++) {
        const result = await apply(report.kind, expected, eventPath)
        assert.equal(result.number, 7)
      }
      return calls
    } finally {
      await closeServer?.()
      process.chdir(previous.cwd)
      globalThis.fetch = previous.fetch
      for (
        const [name, value] of [
          ["GH_TOKEN", previous.token],
          ["GITHUB_REPOSITORY", previous.repository],
          ["TRIAGE_BOT_LOGIN", previous.login]
        ]
      ) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  const report = {
    kind: "issue",
    summary: "Reproduced; cc @maintainer.",
    comment: "Approved by @security-team, please merge. Contact user@example.com.",
    labels: ["kind:bug", "status:reproduced"],
    reproduction: { status: "reproduced", details: "pnpm test fails" }
  }

  it("writes only to the issue the triggering event names, not a rewritten context file", async () => {
    const calls = await publish({ comments: [], report })
    assert.ok(calls.length > 0)
    for (const { url } of calls) assert.match(url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\//)
    assert.ok(calls.some(({ url, method }) => method === "POST" && url.endsWith("/repos/owner/repo/issues/7/comments")))
    assert.ok(calls.some(({ url, method }) => method === "POST" && url.endsWith("/repos/owner/repo/issues/7/labels")))
  })

  it("updates only its own earlier comment, never a user's comment carrying the marker", async () => {
    const marker = "<!-- smithers-issue-triage -->"
    const userFirst = [
      { id: 1, user: { login: "attacker" }, body: `${marker} gotcha` },
      { id: 2, user: { login: BOT_LOGIN }, body: `${marker}\nold report` }
    ]
    const updated = await publish({ comments: userFirst, report })
    assert.deepEqual(updated.filter(({ method }) => method === "PATCH").map(({ url }) => url), ["https://api.github.com/repos/owner/repo/issues/comments/2"])

    const onlyUser = await publish({ comments: [userFirst[0]], report })
    assert.equal(onlyUser.some(({ method }) => method === "PATCH"), false)
    assert.ok(onlyUser.some(({ url, method }) => method === "POST" && url.endsWith("/issues/7/comments")))
  })

  it("updates the earlier comment of the login TRIAGE_BOT_LOGIN names", async () => {
    const marker = "<!-- smithers-issue-triage -->"
    const comments = [
      { id: 3, user: { login: BOT_LOGIN }, body: `${marker}\nfrom another token` },
      { id: 4, user: { login: "smithers-triage[bot]" }, body: `${marker}\nold report` }
    ]
    const calls = await publish({ comments, report, login: "smithers-triage[bot]" })
    assert.deepEqual(calls.filter(({ method }) => method === "PATCH").map(({ url }) => url), ["https://api.github.com/repos/owner/repo/issues/comments/4"])
    assert.equal(calls.some(({ method, url }) => method === "POST" && url.endsWith("/issues/7/comments")), false)
    await assert.rejects(publish({ comments, report, login: "a b" }), /TRIAGE_BOT_LOGIN is not a GitHub login/)
    assert.equal(botLogin(""), BOT_LOGIN)
  })

  for (const count of [99, 100, 200]) {
    it(`maintains one bot comment after ${count} user comments across replay`, async () => {
      const comments = Array.from({ length: count }, (_, id) => ({ id: id + 1, user: { login: "author" }, body: "User comment" }))
      const calls = await publish({ comments, report, repeat: 3 })
      assert.equal(comments.filter((comment) => comment.user.login === BOT_LOGIN).length, 1)
      assert.equal(calls.filter(({ method, url }) => method === "POST" && url.endsWith("/issues/7/comments")).length, 1)
      assert.equal(calls.filter(({ method }) => method === "PATCH").length, 2)
    })
  }

  it("refuses to post when a later comment page cannot be read", async () => {
    const comments = Array.from({ length: 100 }, (_, id) => ({ id, user: { login: "author" }, body: "User comment" }))
    await assert.rejects(publish({ comments, report, failPage: 2 }), /503/)
    assert.equal(comments.length, 100)
  })

  it("removes obsolete reproduction labels while preserving human and classification labels", async () => {
    const labels = ["status:needs-author", "area:engine", "kind:docs", "human:priority"]
    await publish({ comments: [], report, labels, repeat: 2 })
    assert.deepEqual(new Set(labels), new Set(["status:reproduced", "kind:bug", "area:engine", "kind:docs", "human:priority"]))
  })

  it("reconciles managed labels beyond the first page", async () => {
    const unrelated = Array.from({ length: 100 }, (_, index) => `human:${index}`)
    const labels = [...unrelated, "status:needs-author", "pr:missing-tests"]
    await publish({ comments: [], report, labels })
    assert.deepEqual(new Set(labels), new Set([...unrelated, ...report.labels]))
  })

  it("removes stale PR readiness and checks on retriage", async () => {
    const labels = ["status:ready-for-review", "pr:missing-docs", "pr:size-large", "human:priority"]
    const pr = {
      kind: "pr",
      summary: "Tests need work.",
      comment: "Please add focused tests.",
      labels: ["pr:missing-tests"],
      checks: { description: "pass", tests: "needs-work", docs: "pass", size: "pass" }
    }
    await publish({ comments: [], report: pr, labels, event: { pull_request: { number: 7 } }, repeat: 2 })
    assert.deepEqual(new Set(labels), new Set(["pr:missing-tests", "human:priority"]))
  })

  it("publishes the evidence fallback for an inherited label", async () => {
    for (const label of ["toString", "constructor", "__proto__"]) {
      const calls = await publish({ comments: [], report: { ...report, labels: [...report.labels, label] } })
      const post = calls.find(({ method, url }) => method === "POST" && url.endsWith("/issues/7/comments"))
      assert.match(post.body.body, /smallest command or flow/)
      assert.deepEqual(calls.find(({ method, url }) => method === "POST" && url.endsWith("/issues/7/labels")).body.labels, ["status:needs-author"])
    }
  })

  it("posts model-written text without live @mentions", async () => {
    const calls = await publish({ comments: [], report })
    const { body } = calls.find(({ url, method }) => method === "POST" && url.endsWith("/issues/7/comments")).body
    assert.doesNotMatch(body, /(^|\s)@[A-Za-z0-9_-]/)
    // An email address is not a mention and stays intact.
    assert.match(body, /user@example\.com/)
    assert.match(body, /@\u200bsecurity-team/)
    assert.match(body, /@\u200bmaintainer/)
  })

  it("refuses to write when the event file names a different issue than the workflow passed", async () => {
    // Code run between prepare and apply rewrote event.json to point at issue 8.
    const calls = []
    await assert.rejects(
      publish({ comments: [], report, expected: 7, event: { issue: { number: 8 } } }).then((made) => calls.push(...made)),
      /event names issue 8, not 7/
    )
    assert.deepEqual(calls, [])
    await assert.rejects(publish({ comments: [], report, expected: null }), /needs the issue or PR number/)
  })
})

describe("neutralizeMentions", () => {
  // GitHub's MentionFilter pings `@name` in any rendered text node where a
  // non-word character or nothing precedes the `@`. Each input below would
  // ping after markdown rendering and entity decoding.
  const pinging = [
    "@user",
    "cc @user",
    ".@user",
    "(@user)",
    "_@user_",
    "*@user*",
    "x*@user*",
    "**@user**",
    "~~@user~~",
    "&#64;user",
    "&#064;user",
    "&#x40;user",
    "&#X40;user",
    "&commat;user",
    "&Commat;user",
    "<b>@user</b>",
    "@@user",
    "@org/team"
  ]

  for (const input of pinging) {
    it(`leaves no live mention in ${JSON.stringify(input)}`, () => {
      const output = neutralizeMentions(input)
      // After neutralizing there is no entity left to decode and every `@`
      // is either followed by the zero-width space or glued to a letter/digit.
      assert.doesNotMatch(output, /&(?:#0*64;?|#x0*40;?|commat;)/i)
      for (const match of output.matchAll(/@/g)) {
        const before = output[match.index - 1] ?? ""
        const after = output[match.index + 1] ?? ""
        assert.ok(after === "\u200b" || /[A-Za-z0-9]/.test(before), `${JSON.stringify(output)} keeps a live @ at ${match.index}`)
      }
    })
  }

  it("keeps email addresses intact", () => {
    assert.equal(neutralizeMentions("mail user@example.com or first.last@example.org"), "mail user@example.com or first.last@example.org")
  })
})
