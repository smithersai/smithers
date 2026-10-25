// What a repository's view in a conversation shows, and where its links and Back to chat go (./embedView.ts): pure, over
// hand-built rows of the embeds query.
import { describe, expect, test } from "vitest"
import { COULDNT_LOAD, NOT_CLONED, NOT_FOUND } from "./contract"
import { type EmbedQueryRow, embedHref, embedShown, fullScreenHref, minimizedOf } from "./embedView"
import type { EmbedRow } from "./rows"

const embed = (overrides: Partial<EmbedRow> = {}): EmbedRow => ({
  key: "v",
  repoId: "github/octocat/spoon-knife",
  owner: "octocat",
  name: "Spoon-Knife",
  kind: "tree",
  path: "",
  state: "loading",
  message: null,
  revision: null,
  sha: null,
  treeKey: null,
  bodyKey: null,
  bodyPath: null,
  ...overrides,
})

const row = (overrides: Partial<EmbedRow>, rest: Omit<EmbedQueryRow, "embed"> = {}): EmbedQueryRow => ({
  embed: embed(overrides),
  ...rest,
})

describe("embedShown", () => {
  test("is loading with no row or while loading, and says why it shows nothing", () => {
    expect(embedShown(undefined)).toEqual({ kind: "loading" })
    expect(embedShown(row({}))).toEqual({ kind: "loading" })
    expect(embedShown(row({ state: "missing" }))).toEqual({ kind: "empty", title: NOT_FOUND })
    expect(embedShown(row({ state: "missing", message: "Gone" }))).toEqual({ kind: "empty", title: "Gone" })
    expect(embedShown(row({ state: "failed" }))).toEqual({ kind: "empty", title: COULDNT_LOAD })
    expect(embedShown(row({ state: "failed", message: "Busy" }))).toEqual({ kind: "empty", title: "Busy" })
    expect(embedShown(row({ state: "not_cloned" }))).toEqual({ kind: "empty", title: NOT_CLONED })
    // A preview whose About isn't on the device, or has no top folder, shows Not cloned.
    expect(embedShown(row({ state: "preview" }))).toEqual({ kind: "empty", title: NOT_CLONED })
    const about = (fields: Record<string, unknown>) => ({ key: "a", state: "ready" as const, about: fields as never, message: null })
    expect(embedShown(row({ state: "preview" }, { about: about({ defaultBranch: "main", root: null, readme: null }) })))
      .toEqual({ kind: "empty", title: NOT_CLONED })
    // GitHub's root with no README shows the folder alone.
    expect(embedShown(row({ state: "preview" }, { about: about({ defaultBranch: "trunk", root: [], readme: null }) }))).toEqual({
      kind: "view",
      tree: { state: "ready", paths: [], directories: [], truncated: false },
      location: { kind: "tree", path: "" },
      revision: "trunk",
      defaultBranch: "trunk",
    })
  })

  test("a ready file shows the file; a directory its README, or none", () => {
    const body = { key: "b", state: "text" as const, contents: "# Hi", size: 4, message: null }
    const tree = { key: "t", state: "ready" as const, paths: ["README.md", "docs/a.md"], truncated: false, message: null }
    const repository = { owner: "octocat", name: "Spoon-Knife", defaultBranch: "main" }
    const file = embedShown(row({ state: "ready", kind: "blob", path: "README.md", revision: "dev", bodyPath: "README.md" }, { body, tree, repository }))
    expect(file).toEqual({
      kind: "view",
      tree: { state: "ready", paths: ["README.md", "docs/a.md"], truncated: false },
      location: { kind: "blob", path: "README.md" },
      revision: "dev",
      defaultBranch: "main",
      file: { state: "text", contents: "# Hi", size: 4 },
    })
    const readme = embedShown(row({ state: "ready", revision: "main", bodyPath: "README.md" }, { body, tree, repository }))
    expect(readme).toMatchObject({ readme: { path: "README.md", file: { state: "text" } } })
    const bare = embedShown(row({ state: "ready", path: "docs" }))
    expect(bare).toEqual({
      kind: "view",
      tree: { state: "loading" },
      location: { kind: "tree", path: "docs" },
      revision: "",
      defaultBranch: null,
    })
    if (file.kind !== "view" || readme.kind !== "view") throw new Error("shown")
    expect(embedHref(embed(), file, { kind: "blob", path: "src/a.ts", line: 3 })).toBe("/octocat/Spoon-Knife/blob/dev/src/a.ts?L=3")
    expect(embedHref(embed(), readme, { kind: "tree", path: "" })).toBe("/octocat/Spoon-Knife")
  })
})

describe("fullScreenHref", () => {
  test("opens what the view shows once known, else what its props name", () => {
    expect(fullScreenHref({ repo: "octocat/Spoon-Knife" }, undefined)).toBe("/octocat/Spoon-Knife")
    // A path without a ref waits for the default branch's name: the root until the view knows it.
    expect(fullScreenHref({ repo: "octocat/Spoon-Knife", path: "docs" }, row({}))).toBe("/octocat/Spoon-Knife")
    expect(fullScreenHref({ repo: "octocat/Spoon-Knife", ref: "feature/x" }, undefined)).toBe("/octocat/Spoon-Knife/tree/feature/x")
    expect(fullScreenHref({ repo: "octocat/Spoon-Knife", ref: "main", kind: "blob", path: "a b.md" }, undefined))
      .toBe("/octocat/Spoon-Knife/blob/main/a%20b.md")
    expect(fullScreenHref({ repo: "octo cat/Spoon Knife" }, undefined)).toBe("/octo%20cat/Spoon%20Knife")
  })
})

describe("minimizedOf", () => {
  test("names the repository, its ref unless the default branch, and its location unless the root", () => {
    const view = { owner: "octocat", name: "Spoon-Knife", kind: "tree" as const, path: "", revision: "main" }
    expect(minimizedOf(view, "main")).toEqual({ repo: "octocat/Spoon-Knife" })
    expect(minimizedOf({ ...view, revision: null }, null)).toEqual({ repo: "octocat/Spoon-Knife" })
    expect(minimizedOf({ ...view, revision: "dev", kind: "blob", path: "README.md" }, "main")).toEqual({
      repo: "octocat/Spoon-Knife",
      ref: "dev",
      kind: "blob",
      path: "README.md",
    })
  })
})
