import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { fixture } from "../../../worker/test/codeStorage"
import { testFile } from "../../../worker/test/harness"
import { type RepoHarness, repoHarness, resetRepos } from "../../../worker/test/repos"
import { inProcessLanguageServers } from "../../test/languageServer"
import { openTab, type Tab } from "../../test/repoDevice"
import { emptyView } from "../repo/rows"
import { identifierAt, lineOf, targetOf } from "./actions"
import { kindLabel, problemsLabel, supports } from "./contract"
import { hoverOf, outlineOf, placesOf, problemsOf } from "./lsp"
import { asks, sessions } from "./metrics"
import type { CodeIntelRow } from "./rows"
import { LanguageServers } from "./session"
import { hoverCardOf, marksOf, paneOf, problemsAt } from "./view"

// Code intelligence on a tab, driven as React drives it, with no React: through the `CodeIntel` layer's plain actions,
// reading its live row. The repository is a real clone on RepoApi's real handler over the compose Postgres and
// Electric (Code Storage is the scripted provider, worker/test/codeStorage.ts), and the language server is the real
// `BrowserLanguageServer` with the real TypeScript, in this process (src/test/languageServer.ts). Unhappy paths take
// `LanguageServers.layerNone`, whose every answer is `unsupported`.

const server = testFile("code_intel")
beforeEach(() => resetRepos(server))

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 20_000 })

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

const FILES = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"lib\": [\"es2022\"], \"target\": \"es2022\" } }\n",
  "src/math.ts": "/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b\n}\n",
  "src/main.ts": [
    "import { add } from \"./math\"",
    "export const total = add(1, 2)",
    "export const again = add(total, 3)",
    "const wrong: string = 4",
    "export const local = total",
    "",
  ].join("\n"),
  "src/other.ts": "import { add } from \"./math\"\nexport const four = add(2, 2)\n",
  "src/blob.ts": new Uint8Array([0, 1, 2, 3, 0xff, 0xfe]),
  "README.md": "# Fixture\n",
}

/** A tab on `h`'s RepoApi with code intelligence over `servers`, showing `path` at `main`. */
const open = async (h: RepoHarness, path: string, servers = inProcessLanguageServers) => {
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, languageServers: servers })
  tabs.push(tab)
  route(tab, path)
  return tab
}

const route = (tab: Tab, path: string, search: { readonly L?: unknown } = {}) =>
  tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: path }, search)

const row = (tab: Tab): CodeIntelRow => tab.codeIntel!.queries.state.toArray[0]!
const actions = (tab: Tab) => tab.codeIntel!.actions

const seeded = async () => {
  const h = await repoHarness(server)
  await h.seed("octocat", "Spoon-Knife", fixture({ files: FILES }))
  return h
}

// Fault injection delays real server requests; their answers still come from TypeScript.
const delayed = (method: "hover" | "definition" | "read") => {
  let release!: () => void
  let entered = false
  let completed = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  const layer = Layer.effect(LanguageServers, Effect.gen(function* () {
    const real = yield* LanguageServers
    return LanguageServers.of({ ...real, open: (workspace) => Effect.gen(function* () {
      const server = yield* real.open(method === "read" ? { ...workspace, read: (path) =>
        Effect.sync(() => { entered = true }).pipe(Effect.andThen(Effect.promise(() => gate)), Effect.andThen(workspace.read(path)))
      } : workspace)
      if (method === "read") return server
      return { ...server, [method]: (...args: Parameters<typeof server.hover>) =>
        Effect.sync(() => { entered = true }).pipe(
          Effect.andThen(Effect.promise(() => gate)),
          Effect.andThen(server[method](...args)),
          Effect.tap(() => Effect.sync(() => { completed = true })),
        ) }
    }) })
  })).pipe(Layer.provide(inProcessLanguageServers))
  return { layer, release, entered: () => entered, completed: () => completed }
}

describe("code intelligence race regressions", () => {
  test("a late definition cannot navigate after leaving the file", async () => {
    const gate = delayed("definition")
    const tab = await open(await seeded(), "src/main.ts", gate.layer)
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).activate({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(gate.entered()).toBe(true))
    route(tab, "README.md")
    await waitFor(() => expect(row(tab).file).toBeNull())
    gate.release()
    await waitFor(() => expect(gate.completed()).toBe(true))
    await waitFor(() => expect(tab.count(asks, { act: "definition", outcome: "answered" })).toBe(1))
    expect(tab.navigated).toEqual([])
  })

  test("Escape dismisses an outstanding hover", async () => {
    const gate = delayed("hover")
    const tab = await open(await seeded(), "src/main.ts", gate.layer)
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).move({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(gate.entered()).toBe(true))
    expect(actions(tab).key("Escape", false)).toBe(true)
    gate.release()
    await waitFor(() => expect(gate.completed()).toBe(true))
    await waitFor(() => expect(tab.count(asks, { act: "hover", outcome: "answered" })).toBe(1))
    expect(row(tab).hover).toBeNull()
  })

  test("keyboard selection before the server reads the file resolves Symbols", async () => {
    const gate = delayed("read")
    const tab = await open(await seeded(), "src/main.ts", gate.layer)
    await waitFor(() => expect(gate.entered()).toBe(true))
    await waitFor(() => expect(row(tab).path).toBe("src/main.ts"))
    actions(tab).move({ line: 2, column: 22, text: "" })
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 2, column: 22 }))
    expect(actions(tab).key("r", false)).toBe(true)
    gate.release()
    await waitFor(() => expect(row(tab).references).not.toBeNull())
    expect(row(tab).symbol?.name).toBe("add")
    expect(row(tab).definitions?.[0]?.path).toBe("src/math.ts")
  })

  test("repository metadata arriving during a keyboard lookup preserves Symbols", async () => {
    const h = await seeded()
    const gate = delayed("read")
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, languageServers: gate.layer, shapes: "stalled" })
    tabs.push(tab)
    route(tab, "src/main.ts")
    await waitFor(() => expect(gate.entered()).toBe(true))
    await waitFor(() => expect(row(tab).path).toBe("src/main.ts"))
    actions(tab).move({ line: 2, column: 22, text: "" })
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 2, column: 22 }))
    expect(actions(tab).key("r", false)).toBe(true)
    await waitFor(() => expect(row(tab).pane).toBe(true))
    await tab.heal()
    await waitFor(() => expect(tab.view().repository?.defaultBranch).toBe("main"))
    gate.release()
    await waitFor(() => expect(row(tab).references).not.toBeNull())
    expect(row(tab).symbol?.name).toBe("add")
    expect(row(tab).definitions?.[0]?.path).toBe("src/math.ts")
  })

  test("modified browser shortcuts remain unhandled", async () => {
    const tab = await open(await seeded(), "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).move({ line: 2, column: 22, text: "add" })
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
      for (const key of ["o", "r", "Enter", "F12", "F8"]) {
        expect(actions(tab).key(key, false, { [modifier]: true })).toBe(false)
      }
    }
    expect(row(tab).pane).toBe(false)
  })

  test("switching refs at the same commit updates definition links", async () => {
    const h = await repoHarness(server)
    const source = fixture({ files: FILES })
    await h.seed("octocat", "Spoon-Knife", { ...source, branches: [{ name: "other", sha: source.commit.sha, files: FILES }] })
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "other", _splat: "src/main.ts" }, {})
    await waitFor(() => expect(tab.view().view.revision).toBe("other"))
    await waitFor(() => expect(tab.count(asks, { act: "outline", outcome: "answered" })).toBe(2))
    actions(tab).activate({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/other/src/math.ts?L=2"]))
  })

  test("malformed URI escapes are Unreadable failures", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    for (const uri of ["file:///bad%.ts", "file:///bad%E0%A4.ts"]) {
      expect(Effect.runSync(Effect.result(placesOf({ uri, range }, "file:///", () => true))))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "Unreadable" } })
    }
  })
})

describe("a TypeScript file opens in its commit's language server", () => {
  test("its problems and outline load; another file of the commit reuses the server; a file it doesn't serve clears the row", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    expect(row(tab)).toMatchObject({ path: "src/main.ts", pane: false, cursor: null, hover: null })
    expect(row(tab).file).toMatch(/^octocat\/Spoon-Knife@[0-9a-f]{40}:src\/main\.ts$/)
    expect(row(tab).problems).toEqual([
      { line: 4, column: 7, endLine: 4, endColumn: 12, severity: "error", message: "Type 'number' is not assignable to type 'string'." },
    ])
    expect(row(tab).outline).toEqual([
      { name: "again", kind: "const", line: 3, depth: 0 },
      { name: "local", kind: "const", line: 5, depth: 0 },
      { name: "total", kind: "const", line: 2, depth: 0 },
      { name: "wrong", kind: "const", line: 4, depth: 0 },
    ])
    expect(tab.count(asks, { act: "problems", outcome: "answered" })).toBe(1)
    route(tab, "src/math.ts")
    await waitFor(() => expect(row(tab).outline).toEqual([{ name: "add", kind: "fn", line: 2, depth: 0 }]))
    expect(row(tab).problems).toEqual([])
    expect(tab.count(asks, { act: "problems", outcome: "none" })).toBe(1)
    expect(tab.count(sessions)).toBe(1)
    route(tab, "README.md")
    await waitFor(() => expect(row(tab).file).toBeNull())
    expect(row(tab).outline).toBeNull()
  })

  test("hover: a symbol's signature and documentation; whitespace has none; a problem's token shows the problem; an older answer is dropped", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).rest({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(row(tab).hover).not.toBeNull())
    expect(row(tab).hover).toEqual({
      line: 2,
      column: 22,
      signature: "(alias) add(a: number, b: number): number\nimport add",
      documentation: "Adds two numbers.",
    })
    expect(row(tab).cursor).toBeNull()
    actions(tab).rest({ line: 6, column: 1, text: "" })
    await waitFor(() => expect(row(tab).hover).toBeNull())
    expect(tab.count(asks, { act: "hover", outcome: "none" })).toBe(1)
    // The keyboard moves the cursor and the card follows it.
    actions(tab).move({ line: 4, column: 7, text: "wrong" })
    await waitFor(() => expect(row(tab).hover?.line).toBe(4))
    expect(row(tab).cursor).toEqual({ line: 4, column: 7 })
    expect(hoverCardOf(row(tab))?.problems).toEqual([
      { severity: "error", message: "Type 'number' is not assignable to type 'string'." },
    ])
    // Two rests in a row: only the second's answer lands.
    actions(tab).rest({ line: 3, column: 22, text: "add" })
    actions(tab).rest({ line: 3, column: 26, text: "total" })
    await waitFor(() => expect(row(tab).hover?.column).toBe(26))
    expect(row(tab).hover?.signature).toBe("const total: number")
  })

  test("a click selects a symbol: its definition, its references with their lines, and its occurrences here", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).select({ line: 2, column: 22, text: "add" })
    expect(row(tab)).toMatchObject({ pane: true, symbol: { name: "add", line: 2, column: 22 }, definitions: null, references: null })
    await waitFor(() => expect(row(tab).references).not.toBeNull())
    expect(row(tab).definitions).toEqual([
      { path: "src/math.ts", line: 2, column: 17, text: "export function add(a: number, b: number): number {" },
    ])
    expect(row(tab).references?.map((place) => `${place.path}:${place.line}:${place.text}`).sort()).toEqual([
      "src/main.ts:1:import { add } from \"./math\"",
      "src/main.ts:2:export const total = add(1, 2)",
      "src/main.ts:3:export const again = add(total, 3)",
      "src/math.ts:2:export function add(a: number, b: number): number {",
      "src/other.ts:1:import { add } from \"./math\"",
      "src/other.ts:2:export const four = add(2, 2)",
    ])
    expect(row(tab).highlights).toEqual([{ line: 1, column: 10 }, { line: 2, column: 22 }, { line: 3, column: 22 }])
    expect(marksOf(row(tab))).toContainEqual({ line: 2, column: 22, kind: "symbol" })
    expect(paneOf(row(tab))?.symbol?.references).toHaveLength(6)
    expect(tab.count(asks, { act: "references", outcome: "answered" })).toBe(1)
  })

  test("go to definition: another file navigates there and lands the cursor; the same file moves the cursor", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).activate({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/src/math.ts?L=2"]))
    // The router moves the view; the file opens with the cursor on the definition.
    route(tab, "src/math.ts", { L: 2 })
    await waitFor(() => expect(row(tab).path).toBe("src/math.ts"))
    expect(row(tab).cursor).toEqual({ line: 2, column: 17 })
    route(tab, "src/main.ts")
    await waitFor(() => expect(row(tab).path).toBe("src/main.ts"))
    expect(row(tab).cursor).toBeNull()
    actions(tab).activate({ line: 5, column: 22, text: "total" })
    await waitFor(() => expect(tab.navigated).toHaveLength(2))
    expect(tab.navigated[1]).toBe("/octocat/Spoon-Knife/blob/main/src/main.ts?L=2")
    expect(row(tab).cursor).toEqual({ line: 2, column: 14 })
    // Nothing to go to: no navigation.
    actions(tab).activate({ line: 6, column: 1, text: "" })
    await waitFor(() => expect(tab.count(asks, { act: "definition", outcome: "none" })).toBe(1))
    expect(tab.navigated).toHaveLength(2)
  })

  test("keys: Enter and F12 go to the definition, r and Shift+F12 select, F8 steps through problems, o and Escape close", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    const key = (name: string, shift = false) => actions(tab).key(name, shift)
    // Without a cursor, the cursor keys are the page's.
    expect([key("Enter"), key("F12"), key("r"), key("x"), key("Escape")]).toEqual([false, false, false, false, false])
    expect(key("F8")).toBe(true)
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 4, column: 7 }))
    await waitFor(() => expect(row(tab).hover?.line).toBe(4))
    expect(key("Escape")).toBe(true)
    await waitFor(() => expect(row(tab).hover).toBeNull())
    expect(key("F8", true)).toBe(true)
    await waitFor(() => expect(row(tab).hover?.line).toBe(4))
    actions(tab).move({ line: 3, column: 26, text: "total" })
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 3, column: 26 }))
    expect(key("r")).toBe(true)
    await waitFor(() => expect(row(tab).symbol).toEqual({ name: "total", line: 3, column: 26 }))
    await waitFor(() => expect(row(tab).references).not.toBeNull())
    expect(key("F12", true)).toBe(true)
    expect(key("Enter")).toBe(true)
    await waitFor(() => expect(tab.navigated).toEqual(["/octocat/Spoon-Knife/blob/main/src/main.ts?L=2"]))
    expect(key("F12")).toBe(true)
    await waitFor(() => expect(tab.navigated).toHaveLength(2))
    // The pane: Escape closes it once the card is gone; o opens it on the outline.
    await waitFor(() => expect(row(tab).hover).not.toBeNull())
    expect(key("Escape")).toBe(true)
    await waitFor(() => expect(row(tab).hover).toBeNull())
    expect(key("Escape")).toBe(true)
    await waitFor(() => expect(row(tab).pane).toBe(false))
    expect(row(tab).symbol).toBeNull()
    expect(key("o")).toBe(true)
    await waitFor(() => expect(row(tab).pane).toBe(true))
    expect(paneOf(row(tab))).toEqual({ symbol: undefined, outline: row(tab).outline })
    actions(tab).togglePane()
    await waitFor(() => expect(paneOf(row(tab))).toBeUndefined())
    actions(tab).nextProblem()
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 4, column: 7 }))
  })

  test("problems: none means nothing for F8; F8 steps in order, same-line ones by column, around the file", async () => {
    const h = await repoHarness(server)
    await h.seed(
      "octocat",
      "Spoon-Knife",
      fixture({
        files: {
          "a.ts": "const a: string = 1; const b: string = 2\nreturn\n",
          "ok.js": "export const ok = 1\n",
        },
      }),
    )
    const tab = await open(h, "ok.js")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    expect(actions(tab).key("F8", false)).toBe(false)
    actions(tab).nextProblem()
    route(tab, "a.ts")
    await waitFor(() => expect(row(tab).problems).toHaveLength(3))
    actions(tab).move({ line: 1, column: 7, text: "a" })
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 1, column: 7 }))
    actions(tab).nextProblem()
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 1, column: 28 }))
    actions(tab).nextProblem()
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 2, column: 1 }))
    // `return` has no signature to show, only its problem.
    await waitFor(() => expect(row(tab).hover).toEqual({ line: 2, column: 1, signature: null, documentation: "" }))
    expect(hoverCardOf(row(tab))?.problems[0]?.message).toContain("'return'")
    actions(tab).nextProblem()
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 1, column: 7 }))
    expect(actions(tab).key("F8", true)).toBe(true)
    await waitFor(() => expect(row(tab).cursor).toEqual({ line: 2, column: 1 }))
  })

  test("an answer for a file the view left, or a symbol let go of, is dropped", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts")
    await waitFor(() => expect(row(tab).outline).not.toBeNull())
    actions(tab).select({ line: 2, column: 22, text: "add" })
    actions(tab).togglePane()
    await waitFor(() => expect(tab.count(asks, { act: "references", outcome: "answered" })).toBe(1))
    expect(row(tab)).toMatchObject({ pane: false, symbol: null, references: null, highlights: [] })
    actions(tab).rest({ line: 2, column: 22, text: "add" })
    route(tab, "README.md")
    await waitFor(() => expect(tab.count(asks, { act: "hover", outcome: "answered" })).toBe(1))
    expect(row(tab)).toMatchObject({ file: null, hover: null })
  })

  test("a server that answers nothing: no problems, no outline, no card, no places, each counted as failed", async () => {
    const h = await seeded()
    const tab = await open(h, "src/main.ts", LanguageServers.layerNone)
    await waitFor(() => expect(row(tab).outline).toEqual([]))
    expect(row(tab).problems).toEqual([])
    actions(tab).rest({ line: 2, column: 22, text: "add" })
    actions(tab).select({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(row(tab).references).toEqual([]))
    expect(row(tab).definitions).toEqual([])
    actions(tab).activate({ line: 2, column: 22, text: "add" })
    await waitFor(() => expect(tab.count(asks, { act: "definition", outcome: "failed" })).toBe(2))
    expect(row(tab).hover).toBeNull()
    expect(tab.navigated).toEqual([])
    expect(tab.count(asks, { act: "hover", outcome: "failed" })).toBe(1)
    expect(tab.lines("code.ask.failed")[0]!.annotations).toMatchObject({ act: expect.any(String), error: "@smthrs/std/StdError" })
  })

  test("actions before any file opens do nothing", async () => {
    const h = await seeded()
    const tab = await openTab({ origin: h.origin, fetch: h.fetch, languageServers: inProcessLanguageServers })
    tabs.push(tab)
    actions(tab).rest({ line: 1, column: 1, text: "a" })
    actions(tab).select({ line: 1, column: 1, text: "a" })
    actions(tab).activate({ line: 1, column: 1, text: "a" })
    expect(actions(tab).key("o", false)).toBe(true)
    await waitFor(() => expect(row(tab).pane).toBe(true))
    expect(row(tab)).toMatchObject({ file: null, symbol: null, hover: null })
    expect(tab.navigated).toEqual([])
  })
})

describe("the routed file and its lines", () => {
  const view = { ...emptyView, owner: "o", name: "n", kind: "blob" as const, sha: "s".repeat(40), path: "a.ts" }
  const tree = { key: "t", state: "ready" as const, paths: ["a.ts", "b.md"], truncated: false, message: null }

  test("a served file at a commit with its file list is the target; anything else is none", () => {
    expect(targetOf({ view, tree }, "main")).toEqual({
      owner: "o",
      name: "n",
      sha: view.sha,
      path: "a.ts",
      paths: ["a.ts", "b.md"],
      revision: view.sha,
      defaultBranch: "main",
    })
    expect(targetOf({ view: { ...view, revision: "main" }, tree }, null)?.revision).toBe("main")
    expect(targetOf(undefined, null)).toBeUndefined()
    expect(targetOf({ view: { ...view, kind: "tree" }, tree }, null)).toBeUndefined()
    expect(targetOf({ view: { ...view, sha: null }, tree }, null)).toBeUndefined()
    expect(targetOf({ view, tree: { ...tree, state: "loading" } }, null)).toBeUndefined()
    expect(targetOf({ view, tree: undefined }, null)).toBeUndefined()
    expect(targetOf({ view: { ...view, path: "b.md" }, tree }, null)).toBeUndefined()
    expect(targetOf({ view: { ...view, path: "gone.ts" }, tree }, null)).toBeUndefined()
  })

  test("a line by number across line endings, and the identifier a column starts", () => {
    const texts = new Map([["a.ts", "one\r\ntwo\rthree\nfour"]])
    expect([1, 2, 3, 4].map((line) => lineOf(texts, "a.ts", line))).toEqual(["one", "two", "three", "four"])
    expect(identifierAt("  total + 1", 3)).toBe("total")
    expect(identifierAt("  total + 1", 9)).toBe("")
  })
})

describe("the language server's answers, decoded", () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect))

  test("a hover in every form the protocol allows", () => {
    expect(run(hoverOf(null))).toMatchObject({ _tag: "Success", success: null })
    expect(run(hoverOf({ contents: "plain words" }))).toMatchObject({ success: { signature: null, documentation: "plain words" } })
    expect(run(hoverOf({ contents: [{ language: "ts", value: "let a: 1" }, "docs"] }))).toMatchObject({
      success: { signature: "let a: 1", documentation: "docs" },
    })
    expect(run(hoverOf({ contents: { kind: "markdown", value: "```ts\nx\n```" } }))).toMatchObject({
      success: { signature: "x", documentation: "" },
    })
    expect(run(hoverOf({ contents: 7 }))).toMatchObject({ _tag: "Failure", failure: { _tag: "Unreadable" } })
  })

  test("locations and links under the root that name repository files", () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
    const inRepository = (path: string) => path !== "gone.ts"
    expect(run(placesOf(null, "file:///", inRepository))).toMatchObject({ success: [] })
    expect(run(placesOf({ uri: "file:///a%20b.ts", range }, "file:///", inRepository))).toMatchObject({
      success: [{ path: "a b.ts", line: 2, column: 3 }],
    })
    expect(
      run(placesOf(
        [
          { targetUri: "file:///src/x.ts", targetSelectionRange: range },
          { uri: "file:///gone.ts", range },
          { uri: "https://elsewhere/x.ts", range },
        ],
        "file:///",
        inRepository,
      )),
    ).toMatchObject({ success: [{ path: "src/x.ts", line: 2, column: 3 }] })
  })

  test("problems by severity, and an outline depth first", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    expect(run(problemsOf({ kind: "full", items: [
      { range, message: "e" },
      { range, severity: 2, message: "w" },
      { range, severity: 3, message: "i" },
      { range, severity: 4, message: "h" },
    ] }))).toMatchObject({ success: [{ severity: "error" }, { severity: "warning" }, { severity: "info" }, { severity: "info" }] })
    expect(run(outlineOf(null))).toMatchObject({ success: [] })
    expect(run(outlineOf([{ name: "A", kind: 5, selectionRange: range, children: [{ name: "m", kind: 6, selectionRange: range }] }])))
      .toMatchObject({ success: [{ name: "A", kind: "class", line: 1, depth: 0 }, { name: "m", kind: "method", depth: 1 }] })
  })
})

describe("what the view draws", () => {
  const base: CodeIntelRow = {
    id: "code-intel",
    file: "f",
    path: "a.ts",
    cursor: null,
    hover: null,
    symbol: null,
    definitions: null,
    references: null,
    highlights: [],
    problems: [{ line: 2, column: 3, endLine: 4, endColumn: 2, severity: "warning", message: "spans lines" }],
    outline: null,
    pane: false,
  }

  test("a problem across lines underlines to its first line's end and holds every position in its range", () => {
    expect(marksOf(base)).toEqual([{ line: 2, column: 3, end: Number.MAX_SAFE_INTEGER, kind: "warning" }])
    expect([{ line: 2, column: 2 }, { line: 2, column: 3 }, { line: 3, column: 99 }, { line: 4, column: 1 }, { line: 4, column: 2 }]
      .map((at) => problemsAt(base, at).length)).toEqual([0, 1, 1, 1, 0])
    expect(hoverCardOf(base)).toBeUndefined()
    expect(hoverCardOf({ ...base, hover: { line: 3, column: 1, signature: null, documentation: "" } })).toEqual({
      line: 3,
      column: 1,
      signature: undefined,
      documentation: "",
      problems: [{ severity: "warning", message: "spans lines" }],
    })
    expect(paneOf({ ...base, pane: true, symbol: { name: "a", line: 1, column: 1 } })).toEqual({
      symbol: { name: "a", definitions: undefined, references: undefined },
      outline: undefined,
    })
  })

  test("the files served, the toolbar's count and the outline's kinds", () => {
    expect(["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"].every(supports)).toBe(true)
    expect(["a.md", "a.rs", "ts"].some(supports)).toBe(false)
    expect([problemsLabel(1), problemsLabel(3)]).toEqual(["1 problem", "3 problems"])
    expect([2, 5, 6, 7, 9, 10, 11, 12, 13, 14, 22, 26].map(kindLabel)).toEqual([
      "mod", "class", "method", "prop", "new", "enum", "type", "fn", "var", "const", "member", "var",
    ])
  })
})

test("a symbol lookup that finishes after leaving the file cannot overwrite the new page", async () => {
  const gate = delayed("definition")
  const tab = await open(await seeded(), "src/main.ts", gate.layer)
  await waitFor(() => expect(row(tab).outline).not.toBeNull())
  actions(tab).select({ line: 2, column: 22, text: "add" })
  await waitFor(() => expect(gate.entered()).toBe(true))
  route(tab, "README.md")
  await waitFor(() => expect(row(tab).file).toBeNull())
  gate.release()
  await waitFor(() => expect(gate.completed()).toBe(true))
  await waitFor(() => expect(tab.count(asks, { act: "definition", outcome: "answered" })).toBe(1))
  expect(row(tab).file).toBeNull()
  expect(row(tab).symbol).toBeNull()
})
