import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { emptyHistorySentence, listNotedCommits, MAX_CHANGE_PAGES, NOTES_TREE_CONCURRENCY, parseNote, readNotes } from "./HistorySeam"
import type { SeamContext } from "./SeamContext"

// The first controller in a file pays the module warm-up; under machine load that alone passes 5 s.
setDefaultTimeout(30_000)

/*
 * The history seam through the real command path: controller.commands.run
 * drives history.show exactly as the chrome button and the slash do, the
 * stubbed mirror answers the wire shapes probed on smithers.sh on 2026-09-07
 * (git/refs, the change feed, /contents against a commit, git/commits 501),
 * and the "history" card states only what the mirror answered.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Route = Response | ((request: Request) => Response | Promise<Response>)

const backend = (routes: Record<string, Route>, seen: Array<string> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this seam's request.
    if (!path.endsWith("/contents/.smithers/factory.json") && !/\/api\/repos\/[^/]+\/[^/]+\/home$/.test(path)) seen.push(path)
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function" ? answer(new Request(absolute.toString(), init)) : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** The identity seam's definitive signed-out answer: the visitor smithers.sh/owner/name gets before sign-in. */
const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** will/flows loaded as a signed-in inventory row, or as the public catalog row a signed-out visitor explores. */
const reposChosen = async (store: AppStore, catalog: boolean): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null, ...(catalog ? { catalog: true } : {}) }]
  })
  await settled()
}

/**
 * A controller watching exactly will/flows over the given mirror. Signed out
 * unless asked, exactly as the live visitor is: the identity seam answered
 * signed-out and the repository is the public catalog row. `toastDebounceMs`
 * shortens the 300ms toast law for the in-flight test.
 */
const ready = async (services: AppServices, options: { signedIn?: boolean; toastDebounceMs?: number } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    ...services,
    features: { ...services.features },
    ...(options.toastDebounceMs === undefined ? {} : { toastDebounceMs: options.toastDebounceMs })
  })
  if (options.signedIn === true) await signedIn(store)
  else await signedOut(store)
  await reposChosen(store, options.signedIn !== true)
  return { store, controller }
}

/* ---- the mirror's wire shapes ---- */

const REPO = "/api/repos/will/flows"

const ref = (name: string, sha: string) => ({ ref: name, object: { sha, type: "commit" } })

/** One change-feed row; parents are change ids in git parent order, the first is the first parent. */
const change = (changeId: string, commitId: string, description: string, parents: ReadonlyArray<string>) => ({
  change_id: changeId,
  commit_id: commitId,
  description,
  author_name: "will",
  author_email: "will@example.test",
  timestamp: "2026-09-07T00:00:00Z",
  has_conflict: false,
  is_empty: false,
  parent_change_ids: parents
})

/** The feed paginated newest first: `cursor` is the offset, `next_cursor` empty on the last page. */
const feed = (items: ReadonlyArray<unknown>, pageSize: number): Route => (request) => {
  const offset = Number(new URL(request.url).searchParams.get("cursor") ?? "0")
  const page = items.slice(offset, offset + pageSize)
  const next = offset + pageSize < items.length ? String(offset + pageSize) : ""
  return json(200, { items: page, next_cursor: next })
}

const notImplemented = (): Response => json(501, { status: "error", message: "not implemented" })

const historyCard = (store: AppStore) => {
  const card = store.collections.cards.get("history-will/flows")
  if (card === undefined || card.kind !== "history") throw new Error("expected the history card")
  return card
}

/* The main line M3 -> M2 -> M1, plus X off M1 on another bookmark: main has 3 commits, the feed 4. */
const MAIN_ONLY = [
  change("c-m3", "aaa3000000000000000000000000000000000003", "third\n\nbody", ["c-m2"]),
  change("c-x", "ffffff00000000000000000000000000000000ff", "side branch", ["c-m1"]),
  change("c-m2", "aaa2000000000000000000000000000000000002", "second", ["c-m1"]),
  change("c-m1", "aaa1000000000000000000000000000000000001", "first", [])
]

describe("history seam: the empty state", () => {
  test("no mythical bookmark: the card is the one sentence with no count, and the change feed is never read to estimate one", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { full_name: "will/flows", default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003"), ref("refs/heads/side", "ffffff00000000000000000000000000000000ff")]),
        // The feed would answer a walkable 3-commit main line; the seam must not count it.
        [`${REPO}/changes`]: feed(MAIN_ONLY, 2)
      }, seen)
    )
    const outcome = await controller.commands.run("history.show")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = historyCard(store)
    expect(card.title).toBe("Mythical history · will/flows")
    expect(card.payload).toEqual({ repo: "will/flows", defaultBookmark: "main", mainCommits: null, mythical: { state: "absent" } })
    expect(emptyHistorySentence(card.payload.defaultBookmark, card.payload.mainCommits)).toBe("No mythical history yet.")
    expect(seen.filter((path) => path.startsWith(`${REPO}/changes`))).toEqual([])
  })

  test("the sentence carries the count clause only when a count is given", () => {
    expect(emptyHistorySentence("main", null)).toBe("No mythical history yet.")
    expect(emptyHistorySentence(null, null)).toBe("No mythical history yet.")
    expect(emptyHistorySentence("main", 3)).toBe("No mythical history yet. main has 3 commits.")
    expect(emptyHistorySentence("main", 1)).toBe("No mythical history yet. main has 1 commit.")
    expect(emptyHistorySentence(null, 0)).toBe("No mythical history yet. the default bookmark has 0 commits.")
  })

  test("amend and fold remain signed-in and refuse without mythical history", async () => {
    const { controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003")]),
        [`${REPO}/changes`]: feed(MAIN_ONLY, 100)
      }),
      { signedIn: true }
    )
    for (const door of ["history.amend", "history.fold"]) {
      const outcome = await controller.commands.run(door)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") expect(outcome.error).toBe("No mythical history yet.")
    }
  })

  /*
   * Spec 03 §6 as amended 2026-09-07: signed out, the empty state is exactly
   * the one sentence and the bootstrap door, and that door is the sign-in
   * door: history.bootstrap parks behind the signed-in requirement and
   * auth.prompt renders the human's sign-in button in its place. The write doors never run signed out.
   */
  test("signed out, the bootstrap door parks behind sign-in and renders auth.prompt in its place; amend and fold the same", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003")])
      }, seen)
    )
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    for (const door of ["history.amend", "history.fold"]) {
      // The outcome is the fulfilling flow's (auth.prompt), never the door's own refusal: the door has not run.
      await controller.commands.run(door)
      const parked = store.session().pendingCommand
      expect([parked?.name, parked?.args, parked?.requirement]).toEqual([door, null, "signed-in"])
    }
    // The doors never touched the mirror: a parked write reads nothing.
    expect(seen.filter((path) => path.startsWith(REPO))).toEqual([])
    // The sign-in step ran in each door's place, traced as the fulfilling flow.
    const invoked = [...store.collections.transitions.values()]
      .filter((row) => row.type === "flow.invoked")
      .map((row) => (JSON.parse(row.payload) as { readonly name?: unknown }).name)
    expect(invoked.filter((name) => name === "auth.prompt").length).toBe(2)
    expect(store.collections.cards.get("history-will/flows")).toBeUndefined()
  })

  test("a slow mirror immediately displays a loading view, then replaces it with history", async () => {
    const titlesWhileReading: Array<string | null> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40))
          titlesWhileReading.push(store.collections.cards.get("history-will/flows")?.loading ? "Loading history" : null)
          return json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003")])
        }
      }),
      { toastDebounceMs: 5 }
    )
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    expect(titlesWhileReading).toEqual(["Loading history"])
    const toast = store.collections.toasts.get("toast-history.show")
    expect(toast).toBeUndefined()
    expect(historyCard(store).payload.mythical).toEqual({ state: "absent" })
  })
})

/*
 * The mythical history E2 -> E1 -> R on the first-parent line. E1 merges a1
 * (an epic of one commit); E2 merges b2 -> b1 (an epic of two). main's head M
 * sits on its own line. Notes exist for b2 only.
 */
const R = "0000000000000000000000000000000000000000"
const A1 = "a100000000000000000000000000000000000001"
const E1 = "e100000000000000000000000000000000000001"
const B1 = "b100000000000000000000000000000000000001"
const B2 = "b200000000000000000000000000000000000002"
const E2 = "e200000000000000000000000000000000000002"
const M = "3333333333333333333333333333333333333333"
const NOTES = "9999999999999999999999999999999999999999"

const MYTHICAL = [
  change("c-e2", E2, "02 · Targets are declared in PACKAGE.ts", ["c-e1", "c-b2"]),
  change("c-m", M, "🔧 ci: something on main", ["c-r"]),
  change("c-b2", B2, "feat(targets): declare targets", ["c-b1"]),
  change("c-b1", B1, "docs(targets): what a target is", ["c-e1"]),
  change("c-e1", E1, "01 · The workspace declares its toolchain", ["c-r", "c-a1"]),
  change("c-a1", A1, "feat(workspace): WORKSPACE.ts", ["c-r"]),
  change("c-r", R, "root", [])
]

const NOTE_B2 = [
  "---",
  "commit: b2",
  "---",
  "",
  "## Tried",
  "A single PACKAGE.json (run r-1): lost type checking.",
  "",
  "## Evidence",
  "//packages/targets:test green at 4b1c.",
  "",
  "## folded",
  "9a0f2e1, c31d7a4",
  ""
].join("\n")

/** A /contents directory listing as the mirror serves it (probed 2026-09-07: sha, encoding, content and size are empty on listings). */
const listing = (entries: ReadonlyArray<readonly [name: string, type: "file" | "dir", path: string]>): unknown =>
  entries.map(([name, type, path]) => ({ name, path, sha: "", type, encoding: "", content: "", size: 0 }))

const file = (path: string, content: string): unknown => ({ name: path.split("/").at(-1), path, type: "file", encoding: "utf-8", content })

/** Answers only when asked against the notes commit; anything else is the mirror's 404. */
const againstNotes = (answer: unknown): Route => (request) =>
  new URL(request.url).searchParams.get("ref") === NOTES ? json(200, answer) : json(404, { status: "error", message: "content not found" })

const mythicalMirror = (options: { tree?: (sha: string) => Response; notes?: boolean; routes?: Record<string, Route> } = {}, seen: Array<string> = []): AppServices =>
  backend({
    [REPO]: json(200, { default_bookmark: "main" }),
    [`${REPO}/git/refs`]: json(200, [
      ref("refs/heads/main", M),
      ref("refs/heads/mythical", E2),
      ...(options.notes === true ? [ref("refs/notes/mythical", NOTES)] : [])
    ]),
    [`${REPO}/changes`]: feed(MYTHICAL, 3),
    [`${REPO}/git/commits/${E2}`]: options.tree === undefined ? notImplemented() : options.tree(E2),
    [`${REPO}/git/commits/${M}`]: options.tree === undefined ? notImplemented() : options.tree(M),
    // git notes: the notes commit's tree holds a flat `<sha>` for b2 (and a note for a commit outside the history); both listed, one read.
    [`${REPO}/contents/`]: againstNotes(listing([[B2, "file", B2], ["cafe00000000000000000000000000000000cafe", "file", "cafe00000000000000000000000000000000cafe"]])),
    [`${REPO}/contents/${B2}`]: againstNotes(file(B2, NOTE_B2)),
    ...options.routes
  }, seen)

describe("history seam: the mythical history", () => {
  test("first-parent rows are epics, each merge's second-parent chain is its atomic commits, and the badge is unsupported while git/commits answers 501", async () => {
    const { store, controller } = await ready(mythicalMirror())
    // The visitor is signed out and the repository is the catalog row: the read is the public mirror's, and the card lands the same.
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { payload } = historyCard(store)
    // The mirror exposes no commit count, so none is derived from the change feed even when the feed reached main's root.
    expect(payload.mainCommits).toBeNull()
    if (payload.mythical.state !== "present") throw new Error("expected the mythical history")
    expect(payload.mythical.head).toBe(E2)
    expect(payload.mythical.mainHead).toBe(M)
    expect(payload.mythical.treeEqual).toBe("unsupported")
    expect(payload.mythical.notes).toBe("absent")
    expect(payload.mythical.commitCount).toBe(6)
    expect(payload.mythical.epics.map((epic) => [epic.title, epic.merge, epic.commits.map((commit) => commit.title)])).toEqual([
      ["02 · Targets are declared in PACKAGE.ts", true, ["feat(targets): declare targets", "docs(targets): what a target is"]],
      ["01 · The workspace declares its toolchain", true, ["feat(workspace): WORKSPACE.ts"]],
      ["root", false, []]
    ])
    expect(payload.mythical.epics.flatMap((epic) => [epic.note, ...epic.commits.map((commit) => commit.note)]).every((note) => note === null)).toBe(true)
  })

  test("the badge compares the two heads' tree shas when the mirror serves git commits", async () => {
    const equal = await ready(mythicalMirror({ tree: () => json(200, { tree: { sha: "7777777777777777777777777777777777777777" } }) }))
    expect((await equal.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const same = historyCard(equal.store).payload.mythical
    expect(same.state === "present" ? same.treeEqual : same).toBe("equal")

    const differ = await ready(mythicalMirror({ tree: (sha) => json(200, { tree: { sha: `tree-of-${sha}` } }) }))
    expect((await differ.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const different = historyCard(differ.store).payload.mythical
    expect(different.state === "present" ? different.treeEqual : different).toBe("different")
  })

  test("notes under refs/notes/mythical are read for exactly the commits the notes tree names, through /contents against the notes commit, and parsed into the four sections", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(mythicalMirror({ notes: true }, seen))
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { mythical } = historyCard(store).payload
    if (mythical.state !== "present") throw new Error("expected the mythical history")
    expect(mythical.notes).toBe("read")
    const b2 = mythical.epics[0]!.commits.find((commit) => commit.sha === B2)
    expect(b2?.note).toEqual({
      tried: "A single PACKAGE.json (run r-1): lost type checking.",
      evidence: "//packages/targets:test green at 4b1c.",
      folded: "9a0f2e1, c31d7a4",
      superseded: null
    })
    expect(mythical.epics[0]!.note).toBeNull()
    expect(mythical.epics[0]!.commits.find((commit) => commit.sha === B1)?.note).toBeNull()
    // One listing of the tree, then one read per noted commit of the history: no probe per commit, no read of the note outside the history.
    expect(seen.filter((path) => path.startsWith(`${REPO}/contents/`))).toEqual([
      `${REPO}/contents/?ref=${NOTES}`,
      `${REPO}/contents/${B2}?ref=${NOTES}`
    ])
  })

  test("a note on the last of many atomic commits is read: the notes tree, fanned out two characters per directory, says which commits carry one", async () => {
    // E3 on top of E2 merges a chain of 45 atomic commits; the deepest one carries the only note, stored at cc/<38>.
    const E3 = "e300000000000000000000000000000000000003"
    const chainSha = (index: number): string => `cc${String(index).padStart(38, "0")}`
    const deepest = chainSha(45)
    const chain = Array.from({ length: 45 }, (_, index) => {
      const n = index + 1
      return change(`c-cc${n}`, chainSha(n), `step ${n}`, [n === 45 ? "c-e2" : `c-cc${n + 1}`])
    })
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", M), ref("refs/heads/mythical", E3), ref("refs/notes/mythical", NOTES)]),
        [`${REPO}/changes`]: feed([change("c-e3", E3, "03 · Forty-five steps", ["c-e2", "c-cc1"]), ...chain, ...MYTHICAL], 100),
        [`${REPO}/git/commits/${E3}`]: notImplemented(),
        [`${REPO}/git/commits/${M}`]: notImplemented(),
        [`${REPO}/contents/`]: againstNotes(listing([["cc", "dir", "cc"]])),
        [`${REPO}/contents/cc`]: againstNotes(listing([[deepest.slice(2), "file", `cc/${deepest.slice(2)}`]])),
        [`${REPO}/contents/cc/${deepest.slice(2)}`]: againstNotes(file(`cc/${deepest.slice(2)}`, "## Tried\nthe forty-fifth step\n"))
      }, seen)
    )
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { mythical } = historyCard(store).payload
    if (mythical.state !== "present") throw new Error("expected the mythical history")
    expect(mythical.commitCount).toBe(6 + 1 + 45)
    expect(mythical.notes).toBe("read")
    const epic = mythical.epics[0]!
    expect(epic.commits.length).toBe(45)
    expect(epic.commits.at(-1)?.sha).toBe(deepest)
    expect(epic.commits.at(-1)?.note).toEqual({ tried: "the forty-fifth step", evidence: null, folded: null, superseded: null })
    expect(epic.commits.slice(0, 44).every((commit) => commit.note === null)).toBe(true)
    expect(seen.filter((path) => path.startsWith(`${REPO}/contents/`))).toEqual([
      `${REPO}/contents/?ref=${NOTES}`,
      `${REPO}/contents/cc?ref=${NOTES}`,
      `${REPO}/contents/cc/${deepest.slice(2)}?ref=${NOTES}`
    ])
  })

  test("a notes tree the mirror will not list, or a listed note it will not serve, is the unread state with every note null, never absence", async () => {
    const unlisted = await ready(mythicalMirror({ notes: true, routes: { [`${REPO}/contents/`]: json(500, { status: "error", message: "boom" }) } }))
    expect((await unlisted.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const tree = historyCard(unlisted.store).payload.mythical
    if (tree.state !== "present") throw new Error("expected the mythical history")
    expect(tree.notes).toBe("unread")
    expect(tree.epics.flatMap((epic) => [epic.note, ...epic.commits.map((commit) => commit.note)]).every((note) => note === null)).toBe(true)

    const unserved = await ready(mythicalMirror({ notes: true, routes: { [`${REPO}/contents/${B2}`]: json(404, { status: "error", message: "content not found" }) } }))
    expect((await unserved.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const blob = historyCard(unserved.store).payload.mythical
    if (blob.state !== "present") throw new Error("expected the mythical history")
    expect(blob.notes).toBe("unread")
    expect(blob.epics[0]!.commits.find((commit) => commit.sha === B2)?.note).toBeNull()
  })

  test("a page bound that trips with the first-parent line resolved but an epic's chain unresolved is the typed unsupported state, never an epic with zero commits", async () => {
    // Page 1 resolves the whole line E2 -> E1 -> R and main, but E2's second parent b1 names a parent every later page defers.
    const pages: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", M), ref("refs/heads/mythical", E2)]),
        [`${REPO}/changes`]: (request) => {
          pages.push(new URL(request.url).searchParams.get("cursor") ?? "")
          const n = pages.length
          const items = n === 1
            ? [
              change("c-e2", E2, "02 · Targets are declared in PACKAGE.ts", ["c-e1", "c-b1"]),
              change("c-m", M, "🔧 ci: something on main", ["c-r"]),
              change("c-b1", B1, "docs(targets): what a target is", ["c-deferred-2"]),
              change("c-e1", E1, "01 · The workspace declares its toolchain", ["c-r"]),
              change("c-r", R, "root", [])
            ]
            : [change(`c-deferred-${n}`, `dd${String(n).padStart(38, "0")}`, `deferred ${n}`, [`c-deferred-${n + 1}`])]
          return json(200, { items, next_cursor: String(n * 100) })
        }
      })
    )
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    expect(pages.length).toBe(MAX_CHANGE_PAGES)
    const { payload } = historyCard(store)
    expect(payload.mainCommits).toBeNull()
    expect(payload.mythical).toEqual({
      state: "unsupported",
      reason: `The mirror's change feed did not reach every atomic commit of epic ${E2.slice(0, 7)} within ${MAX_CHANGE_PAGES} pages.`
    })
  })

  test("a write door on a present history refuses by name until the retell flow exists", async () => {
    const { controller } = await ready(mythicalMirror(), { signedIn: true })
    const outcome = await controller.commands.run("history.fold")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The mythical history of will/flows cannot be rewritten from here yet: this host does not support amend or fold.")
    }
  })

  test("signed in, the read is unchanged: the same card from the same mirror routes", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(mythicalMirror({}, seen), { signedIn: true })
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { mythical } = historyCard(store).payload
    if (mythical.state !== "present") throw new Error("expected the mythical history")
    expect(mythical.epics.map((epic) => epic.title)).toEqual(["02 · Targets are declared in PACKAGE.ts", "01 · The workspace declares its toolchain", "root"])
    expect(seen.slice(0, 2).sort()).toEqual([REPO, `${REPO}/git/refs`])
  })

  test("a mirror that lists no refs is an honest error, not an empty card", async () => {
    const { store, controller } = await ready(backend({ [REPO]: json(200, { default_bookmark: "main" }) }))
    const outcome = await controller.commands.run("history.show")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("The history of will/flows couldn't be read: the mirror did not list its refs.")
    expect(store.collections.cards.get("history-will/flows")).toMatchObject({ status: "error", loading: false })
  })
})

describe("listNotedCommits", () => {
  /** A notes tree fanned out into `count` sibling directories, each holding one note; every listing answers after one timer tick. */
  const fannedOutMirror = (count: number, failing?: string) => {
    const seen: Array<string> = []
    let active = 0
    let peak = 0
    const http = async (url: string): Promise<Response> => {
      seen.push(url)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      const dir = new URL(url, "https://mirror.invalid").pathname.split("/contents/")[1] ?? ""
      if (dir === failing) return json(500, { status: "error", message: "boom" })
      const body = dir === ""
        ? listing(Array.from({ length: count }, (_, index) => [index.toString(16).padStart(2, "0"), "dir", index.toString(16).padStart(2, "0")] as const))
        : listing([["a".repeat(38), "file", `${dir}/${"a".repeat(38)}`]])
      return json(200, body)
    }
    const ctx = { http, baseUrl: "https://mirror.invalid" } as unknown as SeamContext
    return { ctx, seen, peak: () => peak, active: () => active }
  }

  test("sibling directories of the notes tree are listed through a bounded concurrent queue: one request per directory, more than one in flight, never past the bound", async () => {
    const mirror = fannedOutMirror(64)
    const noted = await listNotedCommits(mirror.ctx, REPO, NOTES)
    expect(noted?.size).toBe(64)
    expect(noted?.get(`03${"a".repeat(38)}`)).toBe(`03/${"a".repeat(38)}`)
    // The root plus one listing per directory, nothing probed twice.
    expect(mirror.seen.length).toBe(65)
    expect(new Set(mirror.seen).size).toBe(65)
    expect(mirror.seen[0]).toBe(`${REPO}/contents/?ref=${NOTES}`)
    expect(mirror.peak()).toBeGreaterThan(1)
    expect(mirror.peak()).toBeLessThanOrEqual(NOTES_TREE_CONCURRENCY)
    expect(mirror.active()).toBe(0)
  })

  test("a sibling directory the mirror will not list makes the whole tree unread, even when its peers listed", async () => {
    const mirror = fannedOutMirror(64, "2a")
    expect(await listNotedCommits(mirror.ctx, REPO, NOTES)).toBeNull()
    expect(mirror.active()).toBe(0)
    expect(await readNotes(mirror.ctx, REPO, NOTES, [`03${"a".repeat(38)}`])).toEqual({ state: "unread" })
    expect(mirror.active()).toBe(0)
  })

  test("queued descendants retain their prefix and stop listing at the depth guard", async () => {
    const seen: Array<string> = []
    const http = async (url: string): Promise<Response> => {
      const dir = new URL(url, "https://mirror.invalid").pathname.split("/contents/")[1] ?? ""
      seen.push(dir)
      const depth = dir === "" ? 0 : dir.split("/").length
      return json(200, [
        { name: "a", type: "dir" },
        ...(depth === 20 ? [{ name: "b".repeat(20), type: "file" }] : [])
      ])
    }
    const ctx = { http } as unknown as SeamContext
    const noted = await listNotedCommits(ctx, REPO, NOTES)
    expect(seen.length).toBe(21)
    expect(noted?.size).toBe(1)
    expect(noted?.get("a".repeat(20) + "b".repeat(20))).toBe(`${Array(20).fill("a").join("/")}/${"b".repeat(20)}`)
  })
})

describe("parseNote", () => {
  test("strips frontmatter, accepts any heading level and case, and answers null for a missing section", () => {
    expect(parseNote("---\na: 1\n---\nintro\n# TRIED\nx\n\n### Superseded\nby y\n")).toEqual({
      tried: "x",
      evidence: null,
      folded: null,
      superseded: "by y"
    })
  })

  test("a heading outside the four sections ends the current one", () => {
    expect(parseNote("## evidence\nproof\n## Other\nignored\n## folded\nabc").evidence).toBe("proof")
    expect(parseNote("## evidence\nproof\n## Other\nignored\n## folded\nabc").folded).toBe("abc")
  })
})
