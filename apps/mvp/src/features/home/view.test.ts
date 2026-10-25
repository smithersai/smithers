import { Home } from "@smthrs/views"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { COMMANDS } from "../commands/catalog"
import type { FlowRow } from "../flows-ui/schema"
import type { Item } from "../issues/schema"
import type { Run } from "../status/schema"
import type { Todo } from "../todos/schema"
import { HOME_INVALID, HOME_UNREADABLE } from "./contract"
import { type CuratedRow, emptyCurrent, type HomeRow } from "./rows"
import {
  draftFor,
  filesOf,
  flowsOf,
  homePageOf,
  issuesOf,
  LIVE_ROWS,
  liveKindsOf,
  MEMBERS_ONLY,
  NOT_SYNCED,
  offered,
  runsOf,
  SIGN_IN,
  stackOf,
  tabsOf,
} from "./view"

// What the page shows of a home, from its rows: the repository's own home or Smithers' curated one, with the sections
// the person may see; nothing while it is read; or the tree with its one line. And each live block's rows.

const REPO = "github/maya/tinyhttp"
const opened = { ...emptyCurrent, owner: "maya", name: "tinyhttp", repoId: REPO }
const ready = { ...opened, key: `${REPO}@abc`, defaultBranch: "main" }

const everyone: Home.Section = { audience: "everyone", blocks: [{ type: "text", text: "Hi" }] }
const members: Home.Section = { title: "Your work", audience: "contributor", blocks: [{ type: "stack" }] }
const maintainers: Home.Section = { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }, { type: "runs" }] }

const row = (fields: Partial<HomeRow>): HomeRow => ({
  key: ready.key,
  state: "declared",
  sections: [everyone],
  contributors: "role",
  skipped: 0,
  reason: null,
  ...fields,
})

const curated = (fields: Partial<CuratedRow> = {}): CuratedRow => ({
  key: REPO,
  state: "declared",
  defaultBranch: "develop",
  sections: [maintainers, members, everyone],
  ...fields,
})

describe("homePageOf: the repository's own home", () => {
  test("the tree for a name that isn't a repository; nothing while the home is read; then the home", () => {
    expect(homePageOf(emptyCurrent, undefined, undefined)).toEqual({ kind: "tree", notice: null })
    expect(homePageOf(ready, undefined, undefined)).toEqual({ kind: "loading" })
    expect(homePageOf(ready, row({}), undefined)).toEqual({
      kind: "home",
      source: "declared",
      sections: [everyone],
      audience: "everyone",
      views: [],
      defaultBranch: "main",
      askHref: "/maya/tinyhttp/tree/main",
      docs: null,
    })
  })

  test("only the sections the person may see, by the audience ChatApi said; everyone's until it says", () => {
    const home = row({ sections: [maintainers, members, everyone] })
    const shown = (audience: Home.Audience | null) => {
      const page = homePageOf({ ...ready, audience }, home, undefined)
      return page.kind === "home" ? page.sections.map((section) => section.audience) : page.kind
    }
    expect(shown(null)).toEqual(["everyone"])
    expect(shown("everyone")).toEqual(["everyone"])
    expect(shown("contributor")).toEqual(["contributor", "everyone"])
    expect(shown("maintainer")).toEqual(["maintainer", "contributor", "everyone"])
  })

  test("a home open to anyone shows a visitor its contributors' sections; ChatApi's audience otherwise stands", () => {
    const home = row({ sections: [maintainers, members, everyone], contributors: "anyone" })
    expect(homePageOf(ready, home, undefined)).toMatchObject({ audience: "contributor", sections: [members, everyone] })
    expect(homePageOf({ ...ready, audience: "maintainer" }, home, undefined)).toMatchObject({ audience: "maintainer" })
  })

  test("a declared home with nothing the person may see, or an empty one, is no home", () => {
    expect(homePageOf(ready, row({ sections: [members] }), undefined)).toEqual({ kind: "tree", notice: null })
    expect(homePageOf(ready, row({ sections: [{ audience: "everyone", blocks: [] }] }), undefined)).toEqual({
      kind: "tree",
      notice: null,
    })
  })

  test("the tree, with its line, for a home that can't show; the repository's own broken home beats a curated one", () => {
    expect(homePageOf(ready, row({ state: "absent", sections: [] }), undefined)).toEqual({ kind: "tree", notice: null })
    expect(homePageOf(ready, row({ state: "invalid", sections: [] }), curated())).toEqual({
      kind: "tree",
      notice: HOME_INVALID,
    })
    expect(homePageOf(ready, row({ state: "unreadable", sections: [] }), curated())).toEqual({
      kind: "tree",
      notice: HOME_UNREADABLE,
    })
  })

  test("names in the links are encoded", () => {
    expect(homePageOf({ ...ready, name: "a b", defaultBranch: "fix/ü" }, row({}), undefined)).toMatchObject({
      askHref: "/maya/a%20b/tree/fix/%C3%BC",
    })
  })
})

describe("homePageOf: Smithers' curated home", () => {
  test("shows before the repository is ready, at its own default branch, with the sections ChatApi sent", () => {
    expect(homePageOf({ ...opened, audience: "contributor" }, undefined, curated({ sections: [members, everyone] }))).toEqual({
      kind: "home",
      source: "curated",
      sections: [members, everyone],
      audience: "contributor",
      views: ["contributor", "everyone"],
      defaultBranch: "develop",
      askHref: "/maya/tinyhttp/tree/develop",
      docs: null,
    })
  })

  test("shows when the repository has no home of its own, or none the person may see", () => {
    expect(homePageOf(ready, row({ state: "absent", sections: [] }), curated())).toMatchObject({ source: "curated" })
    expect(homePageOf(ready, row({ sections: [maintainers] }), curated())).toMatchObject({ source: "curated" })
  })

  test("the repository's own home wins over a curated one", () => {
    expect(homePageOf(ready, row({}), curated())).toMatchObject({ source: "declared" })
  })

  test("nothing while ChatApi is first asked; the tree once it answers none, or fails with none kept", () => {
    expect(homePageOf({ ...opened, answering: true }, undefined, undefined)).toEqual({ kind: "loading" })
    expect(homePageOf({ ...opened, answering: true }, undefined, curated())).toMatchObject({ kind: "home" })
    expect(homePageOf(opened, undefined, undefined)).toEqual({ kind: "tree", notice: null })
    expect(homePageOf(opened, undefined, curated({ state: "absent", defaultBranch: null, sections: [] }))).toEqual({
      kind: "tree",
      notice: null,
    })
    // A curated home whose sections the person may not see is none to them.
    expect(homePageOf(opened, undefined, curated({ sections: [members] }))).toEqual({ kind: "tree", notice: null })
  })
})

describe("homePageOf: the views a person may switch to (SCOPE-14)", () => {
  const home = row({ sections: [maintainers, members, everyone] })
  const shown = (audience: Home.Audience | null, viewing: Home.Audience | null, homeRow: HomeRow = home) => {
    const page = homePageOf({ ...ready, audience, viewing }, homeRow, undefined)
    return page.kind === "home"
      ? { audience: page.audience, views: page.views, sections: page.sections.map((section) => section.audience) }
      : page.kind
  }

  test("a maintainer opens on the maintainer view, and may switch to contributor or user", () => {
    expect(shown("maintainer", null)).toEqual({
      audience: "maintainer",
      views: ["maintainer", "contributor", "everyone"],
      sections: ["maintainer", "contributor", "everyone"],
    })
    expect(shown("maintainer", "contributor")).toEqual({
      audience: "contributor",
      views: ["maintainer", "contributor", "everyone"],
      sections: ["contributor", "everyone"],
    })
    expect(shown("maintainer", "everyone")).toMatchObject({ audience: "everyone", sections: ["everyone"] })
  })

  test("a contributor may switch to user only, and never sees a view above their own", () => {
    expect(shown("contributor", null)).toEqual({
      audience: "contributor",
      views: ["contributor", "everyone"],
      sections: ["contributor", "everyone"],
    })
    expect(shown("contributor", "everyone")).toMatchObject({ audience: "everyone", sections: ["everyone"] })
    // A view above the person's own, kept from another repository or written by hand, shows their own.
    expect(shown("contributor", "maintainer")).toMatchObject({ audience: "contributor", sections: ["contributor", "everyone"] })
  })

  test("a signed-out visitor, or a person with no role, has no views to switch to", () => {
    expect(shown("everyone", null)).toEqual({ audience: "everyone", views: [], sections: ["everyone"] })
    expect(shown(null, null)).toEqual({ audience: "everyone", views: [], sections: ["everyone"] })
    expect(shown("everyone", "maintainer")).toEqual({ audience: "everyone", views: [], sections: ["everyone"] })
  })

  test("on a home open to anyone, a visitor sees its contributors' sections but has no view to switch to", () => {
    // SCOPE-14: a signed-out visitor never sees a contributor option, even where the home shows them its sections.
    const open = row({ sections: [maintainers, members, everyone], contributors: "anyone" })
    expect(shown("everyone", null, open)).toEqual({ audience: "contributor", views: [], sections: ["contributor", "everyone"] })
    expect(shown("everyone", "everyone", open)).toEqual({ audience: "contributor", views: [], sections: ["contributor", "everyone"] })
    expect(shown("contributor", "everyone", open)).toMatchObject({ audience: "everyone", views: ["contributor", "everyone"] })
  })

  test("a view with nothing to show isn't offered, and asking for it shows the person's own", () => {
    const noVisitors = row({ sections: [maintainers, members] })
    expect(shown("maintainer", null, noVisitors)).toMatchObject({ views: ["maintainer", "contributor"] })
    expect(shown("maintainer", "everyone", noVisitors)).toMatchObject({ audience: "maintainer" })
    // One view is no choice.
    expect(shown("contributor", null, noVisitors)).toEqual({ audience: "contributor", views: [], sections: ["contributor"] })
  })

  test("the curated home switches the same way, over the sections ChatApi sent", () => {
    const page = homePageOf({ ...opened, audience: "maintainer", viewing: "contributor" }, undefined, curated())
    expect(page).toMatchObject({ source: "curated", audience: "contributor", views: ["maintainer", "contributor", "everyone"] })
    expect(page.kind === "home" ? page.sections : []).toEqual([members, everyone])
  })
})

describe("tabsOf", () => {
  test("the Home and Code tabs only for a home that shows, Code at its default branch", () => {
    expect(tabsOf(homePageOf(ready, row({}), undefined), ready)).toEqual({
      owner: "maya",
      repo: "tinyhttp",
      ref: "main",
      _splat: "",
      docs: false,
    })
    expect(tabsOf(homePageOf({ ...ready, defaultBranch: "a/b/c" }, row({}), undefined), ready)).toMatchObject({
      ref: "a",
      _splat: "b/c",
    })
    expect(tabsOf(homePageOf(opened, undefined, curated()), opened)).toMatchObject({ ref: "develop" })
    expect(tabsOf(homePageOf(ready, row({ state: "absent", sections: [] }), undefined), ready)).toMatchObject({ ref: "main", docs: false })
    expect(tabsOf({ kind: "loading" }, ready)).toMatchObject({ ref: "main", docs: false })
    expect(tabsOf({ kind: "tree", notice: null }, { ...ready, docs: "docs/index.md" })).toMatchObject({ docs: true })
    expect(tabsOf({ kind: "loading" }, opened)).toBeUndefined()
  })

  test("Docs only when the repository names docs: its own home's, else the curated home's", () => {
    const own = "https://own.example/llms.txt"
    const smithers = "https://curated.example/llms.txt"
    expect(homePageOf({ ...ready, docs: own, curatedDocs: smithers }, row({}), curated())).toMatchObject({ docs: own })
    expect(homePageOf({ ...ready, curatedDocs: smithers }, row({}), curated())).toMatchObject({ docs: smithers })
    expect(homePageOf({ ...opened, curatedDocs: smithers }, undefined, curated())).toMatchObject({ docs: smithers })
    expect(tabsOf(homePageOf({ ...ready, docs: own }, row({}), undefined), ready)).toMatchObject({ docs: true })
    expect(tabsOf(homePageOf(ready, row({}), curated()), ready)).toMatchObject({ docs: false })
  })
})

describe("offered and draftFor", () => {
  test("a command line whose command the composer has starts it; anything else starts nothing", () => {
    const command = COMMANDS[0]!.name
    expect(offered(command)).toBe(true)
    expect(draftFor(command)).toBe(`/${command} `)
    expect(draftFor("flow.run release-notes")).toBe("/flow.run release-notes ")
    expect(offered("issue.implement")).toBe(false)
    expect(draftFor("issue.implement")).toBeUndefined()
    expect(draftFor("issue.implement now")).toBeUndefined()
    expect(draftFor(undefined)).toBeUndefined()
  })
})

describe("filesOf", () => {
  test("each Markdown block's file by its path, in the states the home view takes", () => {
    expect(
      filesOf([
        { path: "a.md", state: "text", text: "# A" },
        { path: "b.md", state: "loading", text: null },
        { path: "c.md", state: "failed", text: null },
        { path: "d.md", state: "text", text: null },
      ]),
    ).toEqual({
      "a.md": { state: "text", text: "# A" },
      "b.md": { state: "loading" },
      "c.md": { state: "failed" },
      "d.md": { state: "text", text: "" },
    })
  })
})

describe("liveKindsOf", () => {
  test("the kinds of block the shown home holds; none for a page that isn't a home", () => {
    expect([...liveKindsOf(homePageOf({ ...opened, audience: "maintainer" }, undefined, curated()))]).toEqual([
      "issues",
      "runs",
      "stack",
      "text",
    ])
    expect(liveKindsOf({ kind: "loading" }).size).toBe(0)
  })
})

const item = (fields: Partial<Item>): Item => ({
  id: `${REPO}#1`,
  repoId: REPO,
  number: 1,
  kind: "issue",
  githubId: 1,
  title: "An issue",
  body: "",
  state: "open",
  stateReason: null,
  authorLogin: "ann",
  comments: 0,
  createdAt: "2026-10-20 10:00:00+00",
  updatedAt: "2026-10-20 10:00:00+00",
  closedAt: null,
  deletedAt: null,
  writeId: null,
  triage: "proposed",
  triagePinned: false, commitment: null,
  ...fields,
})

describe("issuesOf", () => {
  test("the repository's open issues by triage state, the ones to triage newest first, and its open pull requests", () => {
    const items = [
      item({ id: "a", number: 1, triage: "proposed", updatedAt: "2026-10-20 09:00:00+00" }),
      item({ id: "b", number: 2, triage: "conflict", updatedAt: "2026-10-20 11:00:00+00" }),
      item({ id: "c", number: 3, triage: "accepted" }),
      item({ id: "d", number: 4, triage: "not_accepted" }),
      item({ id: "e", number: 5, kind: "pull", triage: "proposed", title: "A fix" }),
      // Not counted: closed, deleted, another repository's.
      item({ id: "f", number: 6, state: "closed" }),
      item({ id: "g", number: 7, deletedAt: "2026-10-20 12:00:00+00" }),
      item({ id: "h", number: 8, repoId: "github/other/repo" }),
    ]
    const issues = issuesOf(items, "maya", "tinyhttp", REPO, true)
    expect(issues).toEqual({
      proposed: 2,
      accepted: 1,
      notAccepted: 1,
      href: "/maya/tinyhttp/issues",
      triage: {
        total: 2,
        href: "/maya/tinyhttp/issues",
        entries: [
          { key: "b", label: "#2", title: "An issue", href: "/maya/tinyhttp/issues/2", at: Date.parse("2026-10-20T11:00:00+00:00") },
          { key: "a", label: "#1", title: "An issue", href: "/maya/tinyhttp/issues/1", at: Date.parse("2026-10-20T09:00:00+00:00") },
        ],
      },
      pulls: {
        total: 1,
        entries: [{ key: "e", label: "#5", title: "A fix", href: "/maya/tinyhttp/pull/5", at: Date.parse("2026-10-20T10:00:00+00:00") }],
      },
    })
  })

  test("lists at most a few rows and counts them all; a repository not synced says so", () => {
    const many = Array.from({ length: LIVE_ROWS + 2 }, (_, index) => item({ id: `i${index}`, number: index + 1 }))
    const issues = issuesOf(many, "maya", "tinyhttp", REPO, true)
    expect("triage" in issues && [issues.triage.entries.length, issues.triage.total]).toEqual([LIVE_ROWS, LIVE_ROWS + 2])
    expect(issuesOf(many, "maya", "tinyhttp", REPO, false)).toEqual({ notice: NOT_SYNCED })
  })
})

const todo = (fields: Partial<Todo>): Todo => ({
  id: "t1",
  repoId: REPO,
  number: 1,
  title: "A TODO",
  state: "queued",
  step: null,
  position: 1,
  revision: 1,
  attempt: 1,
  branch: null,
  prNumber: null,
  failure: null,
  note: null,
  createdLogin: "ann",
  createdAt: "2026-10-20 10:00:00+00",
  updatedAt: "2026-10-20 10:00:00+00",
  settledAt: null,
  issueNumber: null,
  runId: null,
  ...fields,
})

describe("stackOf", () => {
  test("the TODOs still on the stack, in its order, each with its state's pill and word", () => {
    const todos = [
      todo({ id: "b", number: 2, position: 2, state: "working" }),
      todo({ id: "a", number: 1, position: 1, state: "in_review" }),
      todo({ id: "m", number: 3, position: null, state: "merged" }),
    ]
    expect(stackOf(todos, "maya", "tinyhttp", "allowed")).toEqual({
      total: 2,
      href: "/maya/tinyhttp/stack",
      entries: [
        { key: "a", label: "T1", title: "A TODO", href: "/maya/tinyhttp/stack/1", status: { status: "waiting", label: "In review" }, at: Date.parse("2026-10-20T10:00:00+00:00") },
        { key: "b", label: "T2", title: "A TODO", href: "/maya/tinyhttp/stack/2", status: { status: "running", label: "Working" }, at: Date.parse("2026-10-20T10:00:00+00:00") },
      ],
    })
    expect(stackOf([], "maya", "tinyhttp", undefined)).toEqual({ total: 0, href: "/maya/tinyhttp/stack", entries: [] })
  })

  test("every state's pill", () => {
    const states = ["queued", "working", "in_review", "merged", "dropped", "failed"] as const
    const pills = states.map((state) => {
      const stack = stackOf([todo({ state })], "maya", "tinyhttp", "allowed")
      return "entries" in stack ? stack.entries[0]!.status : null
    })
    expect(pills.map((pill) => pill?.status)).toEqual(["queued", "running", "waiting", "done", "cancelled", "failed"])
  })

  test("a person the stack refused sees why", () => {
    expect(stackOf([todo({})], "maya", "tinyhttp", "sign_in")).toEqual({ notice: SIGN_IN })
    expect(stackOf([todo({})], "maya", "tinyhttp", "forbidden")).toEqual({ notice: MEMBERS_ONLY })
  })
})

const run = (fields: Partial<Run>): Run => ({
  id: "r1",
  flow: "chat/Answer",
  status: "done",
  waiting: null,
  wait: null,
  version: 1,
  answer: null,
  answeredAt: null,
  createdAt: "2026-10-20 10:00:00+00",
  updatedAt: "2026-10-20 10:00:00+00",
  ...fields,
})

describe("runsOf", () => {
  test("this person's runs newest first, each with its state, and how many failed", () => {
    const runs = runsOf([
      run({ id: "a", status: "done", updatedAt: "2026-10-20 09:00:00+00" }),
      run({ id: "b", status: "failed", updatedAt: "2026-10-20 11:00:00+00" }),
      run({ id: "c/d", status: "working", updatedAt: "2026-10-20 10:00:00+00" }),
      run({ id: "e", status: "waiting", updatedAt: "2026-10-20 08:00:00+00" }),
      run({ id: "f", status: "needs_you", updatedAt: "2026-10-20 07:00:00+00" }),
    ])
    expect(runs.failed).toBe(1)
    expect(runs.total).toBe(5)
    expect(runs.href).toBe("/app/runs")
    expect(runs.entries.map((entry) => [entry.key, entry.href, entry.status])).toEqual([
      ["b", "/app/runs/b", { status: "failed", label: "Failed" }],
      ["c/d", "/app/runs/c%2Fd", { status: "running", label: "Working" }],
      ["a", "/app/runs/a", { status: "done", label: "Done" }],
      ["e", "/app/runs/e", { status: "waiting", label: "Waiting" }],
      ["f", "/app/runs/f", { status: "waiting", label: "Needs you" }],
    ])
    expect(runs.entries[0]!.title).toBe("chat/Answer")
  })
})

describe("flowsOf", () => {
  test("this person's own flows, newest first, each run with /flow.run and its name", () => {
    const flow = (name: string, updatedAt: string): FlowRow => ({
      id: name,
      name,
      revision: 1,
      description: `${name} does a thing.`,
      placement: "client",
      createdAt: updatedAt,
      updatedAt,
    })
    expect(flowsOf([flow("older", "2026-10-19 10:00:00+00"), flow("newer", "2026-10-20 10:00:00+00")])).toEqual([
      { flow: "flow.run newer", name: "newer", title: "newer does a thing." },
      { flow: "flow.run older", name: "older", title: "older does a thing." },
    ])
  })
})

describe("VibeLang's draft home", () => {
  test("reads as a home, skips nothing, and shows each audience its own sections first", () => {
    const text = readFileSync(new URL("../../../docs/design/repo-home/vibelang.home.json", import.meta.url), "utf8")
    const read = Home.read(text)
    if (read._tag !== "Declared") throw new Error(`vibelang.home.json is ${read.reason}`)
    expect(read.skipped).toBe(0)
    const row: HomeRow = { key: ready.key, state: "declared", sections: read.sections, contributors: read.contributors, skipped: 0, reason: null }
    const titles = (audience: Home.Audience) => {
      const page = homePageOf({ ...ready, audience }, row, undefined)
      return page.kind === "home" ? page.sections.map((section) => section.title ?? section.audience) : page.kind
    }
    expect(titles("everyone")).toEqual(["everyone"])
    expect(titles("contributor")).toEqual(["Contribute", "everyone"])
    expect(titles("maintainer")).toEqual(["Today", "Contribute", "everyone"])
  })
})
