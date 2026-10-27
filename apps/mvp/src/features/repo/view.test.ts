import { describe, expect, test } from "vitest"
import { CAPACITY_COPY, CLONING, COULDNT_LOAD, FAILURE_COPY, NOT_CLONED, READING_PAUSED, SIGN_IN_TO_CLONE } from "./contract"
import { type AboutRow, type BlobRow, type CloneRow, emptyView, type RefsRow, type TreeRow, type ViewRow } from "./rows"
import type { About, Repository } from "./schema"
import {
  aboutFailed,
  directoryFileOf,
  aboutOf,
  aboutProps,
  atRoot,
  countLabel,
  countsOf,
  generatedLinksFor,
  headCommitOf,
  pageOf,
  missingFileOf,
  missingRefOf,
  previewCommitOf,
  previewReadmeOf,
  previewTreeOf,
  reclaimNoteOf,
  capacityText,
  commitOf,
  fileLinksOf,
  fileProps,
  formatBytes,
  codeEmptyOf,
  headerOf,
  parseTimestamp,
  refsProps,
  revisionLabel,
  shownOf,
  treeProps,
  type ViewState,
} from "./view"

// What the view shows, from the rows the queries read.

const SHA = "c".repeat(40)

const repository = (fields: Partial<Repository> = {}): Repository => ({
  id: "github/octocat/spoon-knife",
  owner: "octocat",
  name: "Spoon-Knife",
  status: "ready",
  failure: null,
  capacity: null,
  storedBytes: null,
  retryAt: null,
  defaultBranch: "main",
  headSha: SHA,
  headMessage: "Fix the fork\n\nLonger body",
  headAuthor: "The Octocat",
  headAt: "2026-10-20 12:00:00+00",
  attempt: 1,
  cloneId: "0b6c1d2e-3f40-4a51-8b62-7c83d94ea5f6",
  requestedAt: "2026-10-20 11:59:00+00",
  settledAt: "2026-10-20 12:00:05+00",
  stage: null,
  reclaimable: false,
  ...fields,
})

const clone = (status: CloneRow["status"]): CloneRow => ({ id: "github/o/n", owner: "o", name: "n", status })

describe("treeProps and fileProps", () => {
  test("no row and a loading row are loading", () => {
    expect(treeProps(undefined)).toEqual({ state: "loading" })
    expect(treeProps({ key: "k", state: "loading", paths: [], truncated: false, message: null })).toEqual({
      state: "loading",
    })
    expect(fileProps(undefined)).toEqual({ state: "loading" })
    expect(fileProps({ key: "k", state: "loading", contents: null, size: null, message: null })).toEqual({
      state: "loading",
    })
  })

  test("a ready list, and a file as text, binary or too large", () => {
    expect(treeProps({ key: "k", state: "ready", paths: ["a"], truncated: true, message: null })).toEqual({
      state: "ready",
      paths: ["a"],
      truncated: true,
    })
    expect(fileProps({ key: "k", state: "text", contents: "hi", size: 2, message: null })).toEqual({
      state: "text",
      contents: "hi",
      size: 2,
    })
    expect(fileProps({ key: "k", state: "text", contents: null, size: null, message: null })).toEqual({
      state: "text",
      contents: "",
      size: 0,
    })
    expect(fileProps({ key: "k", state: "binary", contents: null, size: 9, message: null })).toEqual({
      state: "binary",
      size: 9,
    })
    expect(fileProps({ key: "k", state: "too-large", contents: null, size: null, message: null })).toEqual({
      state: "too-large",
      size: 0,
    })
  })

  test("a failed load carries its message", () => {
    expect(treeProps({ key: "k", state: "failed", paths: [], truncated: false, message: "Busy" })).toEqual({
      state: "failed",
      message: "Busy",
    })
    expect(treeProps({ key: "k", state: "failed", paths: [], truncated: false, message: null })).toEqual({
      state: "failed",
      message: "",
    })
    expect(fileProps({ key: "k", state: "failed", contents: null, size: null, message: "Gone" })).toEqual({
      state: "failed",
      message: "Gone",
    })
    expect(fileProps({ key: "k", state: "failed", contents: null, size: null, message: null })).toEqual({
      state: "failed",
      message: "",
    })
  })
})

describe("codeEmptyOf", () => {
  // The branch workspace's recordings showed a blank page for a repository nobody had cloned (Will, 2026-10-20):
  // the Code view rendered nothing until the clone was ready.
  test("a repository that isn't ready says so in the Code view, never a blank page", () => {
    expect(codeEmptyOf(headerOf(undefined, undefined, true))).toBe(NOT_CLONED)
    expect(codeEmptyOf(headerOf(undefined, undefined, false))).toBe(NOT_CLONED)
    expect(codeEmptyOf(headerOf(repository({ status: "failed", failure: "timed_out" }), undefined, true))).toBe(NOT_CLONED)
    expect(codeEmptyOf(headerOf(undefined, clone("limit"), true))).toBe(NOT_CLONED)
    expect(codeEmptyOf(headerOf(repository({ status: "cloning" }), undefined, true))).toBe(CLONING)
    expect(codeEmptyOf(headerOf(undefined, clone("requesting"), true))).toBe(CLONING)
  })

  test("says nothing while the device can't tell yet, or once the files show", () => {
    expect(codeEmptyOf(headerOf(undefined, undefined, true, false))).toBeUndefined()
    expect(codeEmptyOf(headerOf(repository(), undefined, true))).toBeUndefined()
  })
})

describe("headerOf", () => {
  test("About missing offers no clone or sign-in action, even before the repositories shape answers", () => {
    const about: AboutRow = { key: "github/o/n", state: "missing", about: null, message: "Not found" }
    for (const answered of [false, true]) {
      for (const signedIn of [true, false, null]) {
        expect(headerOf(undefined, undefined, signedIn, answered, about)).toEqual({ kind: "missing" })
        expect(codeEmptyOf(headerOf(undefined, undefined, signedIn, answered, about))).toBe("Not found")
      }
    }
    expect(headerOf(repository(), undefined, true, true, about)).toEqual({ kind: "ready" })
    expect(headerOf(repository({ status: "cloning" }), undefined, true, true, about)).toEqual({ kind: "cloning" })
    expect(headerOf(undefined, clone("requesting"), true, true, about)).toEqual({ kind: "cloning" })
    expect(headerOf(undefined, clone("failed"), true, true, about)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable })
    for (const state of ["loading", "ready"] as const) {
      expect(headerOf(undefined, undefined, true, true, { ...about, state })).toEqual({ kind: "clone" })
      expect(headerOf(undefined, undefined, true, false, { ...about, state })).toEqual({ kind: "unknown" })
    }
  })

  test("this tab's own request wins until Electric delivers what it did", () => {
    expect(headerOf(repository({ status: "failed", failure: "not_found" }), clone("requesting"), true)).toEqual({
      kind: "cloning",
    })
    expect(headerOf(undefined, clone("sign_in"), null)).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE })
    expect(headerOf(undefined, clone("limit"), true)).toEqual({ kind: "refused", text: CAPACITY_COPY.paused })
    expect(headerOf(undefined, clone("failed"), true)).toEqual({ kind: "refused", text: FAILURE_COPY.unavailable })
  })

  test("no repository is Clone, or sign-in for a signed-out person", () => {
    expect(headerOf(undefined, undefined, true)).toEqual({ kind: "clone" })
    expect(headerOf(undefined, undefined, null)).toEqual({ kind: "clone" })
    expect(headerOf(undefined, undefined, false)).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE })
    // Before the repositories' shape has answered, a repository the device hasn't seen offers nothing.
    expect(headerOf(undefined, undefined, true, false)).toEqual({ kind: "unknown" })
    expect(headerOf(undefined, undefined, false, false)).toEqual({ kind: "unknown" })
    expect(headerOf(repository({ status: "ready" }), undefined, true, false)).toEqual({ kind: "ready" })
    expect(headerOf(undefined, clone("requesting"), true, false)).toEqual({ kind: "cloning" })
  })

  test("a repository shows its status", () => {
    expect(headerOf(repository({ status: "cloning" }), undefined, true)).toEqual({ kind: "cloning" })
    expect(headerOf(repository(), undefined, false)).toEqual({ kind: "ready" })
    expect(headerOf(repository({ status: "failed", failure: "timed_out" }), undefined, true)).toEqual({
      kind: "refused",
      text: FAILURE_COPY.timed_out,
    })
    expect(headerOf(repository({ status: "failed" }), undefined, true)).toEqual({
      kind: "refused",
      text: FAILURE_COPY.unavailable,
    })
    expect(headerOf(repository({ status: "capacity", capacity: "storage" }), undefined, true)).toEqual({
      kind: "refused",
      text: CAPACITY_COPY.storage,
    })
  })
})

describe("capacityText", () => {
  test("names the size of a repository over the limit, and when GitHub gives the size again", () => {
    expect(capacityText(repository({ status: "capacity", capacity: "too_large", storedBytes: 1.2 * 1024 ** 3 }))).toBe(
      `${CAPACITY_COPY.too_large} · 1.2 GB`,
    )
    expect(capacityText(repository({ status: "capacity", capacity: "too_large" }))).toBe(CAPACITY_COPY.too_large)
    expect(
      capacityText(repository({ status: "capacity", capacity: "size_unknown", retryAt: "2026-10-20 15:40:00+00" })),
    ).toMatch(new RegExp(`^${CAPACITY_COPY.size_unknown} \\d`))
    expect(capacityText(repository({ status: "capacity", capacity: "size_unknown" }))).toBe(
      CAPACITY_COPY.size_unknown,
    )
    expect(capacityText(repository({ status: "capacity" }))).toBe(CAPACITY_COPY.paused)
  })
})

describe("formatting", () => {
  test("bytes in the largest whole unit", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB")
    expect(formatBytes(3 * 1024 ** 5)).toBe("3072.0 TB")
  })

  test("Postgres timestamps and ISO ones", () => {
    expect(parseTimestamp("2026-10-20 15:40:00+00")).toBe(Date.UTC(2026, 9, 20, 15, 40))
    expect(parseTimestamp("2026-10-20 15:40:00.5-07")).toBe(Date.UTC(2026, 9, 20, 22, 40, 0, 500))
    expect(parseTimestamp("2026-10-20T15:40:00Z")).toBe(Date.UTC(2026, 9, 20, 15, 40))
  })
})

describe("commitOf", () => {
  test("the head commit's first line, author, short SHA and time", () => {
    expect(commitOf(repository())).toEqual({
      message: "Fix the fork",
      author: "The Octocat",
      shortSha: "ccccccc",
      at: Date.UTC(2026, 9, 20, 12),
    })
    expect(commitOf(repository({ headMessage: null, headAuthor: null }))).toMatchObject({ message: "", author: "" })
  })

  test("nothing before Settle wrote the head", () => {
    expect(commitOf(undefined)).toBeUndefined()
    expect(commitOf(repository({ headSha: null }))).toBeUndefined()
    expect(commitOf(repository({ headAt: null }))).toBeUndefined()
  })

  test("only at the head: another commit's details aren't on the device", () => {
    expect(commitOf(repository(), SHA)?.shortSha).toBe("ccccccc")
    expect(commitOf(repository(), null)).toBeUndefined()
    expect(commitOf(repository(), "d".repeat(40))).toBeUndefined()
  })
})

describe("the picker", () => {
  test("refs as the picker takes them: loading, ready or failed", () => {
    const row = { key: "k", branches: [{ name: "main", sha: SHA }], tags: [], truncated: true, message: null }
    expect(refsProps(undefined)).toEqual({ state: "loading" })
    expect(refsProps({ ...row, state: "loading" })).toEqual({ state: "loading" })
    expect(refsProps({ ...row, state: "ready" })).toEqual({
      state: "ready",
      branches: [{ name: "main", sha: SHA }],
      tags: [],
      truncated: true,
    })
    expect(refsProps({ ...row, state: "failed", message: "Code Storage is busy" })).toEqual({
      state: "failed",
      message: "Code Storage is busy",
    })
    expect(refsProps({ ...row, state: "failed" })).toEqual({ state: "failed", message: "" })
  })

  test("a branch or tag shows its name, a commit its short SHA", () => {
    expect(revisionLabel("feature/x")).toBe("feature/x")
    expect(revisionLabel(SHA)).toBe("ccccccc")
  })
})

describe("fileLinksOf", () => {
  const view = { owner: "octocat", name: "Spoon-Knife", sha: SHA, path: "docs/a b.md" }
  const blob = (fields: Partial<BlobRow>): BlobRow => ({
    key: "k",
    state: "text",
    contents: "x",
    size: 1,
    message: null,
    ...fields,
  })

  test("a text file: Raw and Download at its commit, and its text to copy", () => {
    const raw = `/api/repos/octocat/Spoon-Knife/raw/${SHA}/docs/a%20b.md`
    expect(fileLinksOf(view, blob({}))).toEqual({ raw, download: { href: raw, name: "a b.md" }, copyContents: true })
    expect(fileLinksOf(view, blob({ state: "binary", contents: null }))).toEqual({
      raw,
      download: { href: raw, name: "a b.md" },
      copyContents: false,
    })
  })

  test("a file over the limit opens GitHub's raw bytes; one not loaded yet, failed, or at no commit has nothing", () => {
    expect(fileLinksOf(view, blob({ state: "too-large", contents: null, size: 600_000 }))).toEqual({
      raw: `https://github.com/octocat/Spoon-Knife/raw/${SHA}/docs/a%20b.md`,
      download: { href: `/api/repos/octocat/Spoon-Knife/raw/${SHA}/docs/a%20b.md?download=1`, name: "a b.md" },
      copyContents: false,
    })
    for (const file of [undefined, blob({ state: "loading" }), blob({ state: "failed", message: "Not found" })]) {
      expect(fileLinksOf(view, file)).toEqual({ copyContents: false })
    }
    expect(fileLinksOf({ ...view, sha: null }, blob({}))).toEqual({ copyContents: false })
  })
})

const about = (fields: Partial<About> = {}): About => ({
  name: "octocat/Spoon-Knife",
  description: "Demo",
  homepage: "https://example.com",
  topics: ["demo"],
  stars: 14126,
  forks: 3,
  watchers: 9,
  license: "MIT",
  defaultBranch: "main",
  archived: false,
  languages: [{ name: "HTML", bytes: 300 }],
  release: { tag: "v 1", name: null, publishedAt: "2026-10-01T12:00:00Z" },
  releases: 2,
  contributors: [{ login: "octo cat", avatarUrl: "https://avatars.githubusercontent.com/u/1" }],
  contributorCount: 40,
  commits: 3,
  branches: 3,
  tags: 1,
  head: { sha: "d".repeat(40), message: "First line\n\nBody", author: "octocat", at: "2014-02-12T23:20:44Z" },
  root: [{ name: "README.md", kind: "file" }, { name: "docs", kind: "dir" }],
  readme: { path: "README.md", text: "# Hi é" },
  installUrl: "https://github.com/apps/smithers/installations/new",
  ...fields,
})

const aboutRow = (state: AboutRow["state"], value: About | null = null): AboutRow => ({
  key: "github/octocat/spoon-knife",
  state,
  about: value,
  message: null,
})

describe("the first visit: what GitHub says, before and after a clone", () => {
  test("a failed public root read needs an honest error instead of a clone claim", () => {
    expect(aboutFailed(aboutRow("failed"), { kind: "clone" }, true)).toBe(true)
    const unavailable = headerOf(undefined, undefined, false, true, aboutRow("failed"))
    expect(unavailable).toEqual({ kind: "unavailable" })
    expect(aboutFailed(aboutRow("failed"), unavailable, true)).toBe(true)
    expect(codeEmptyOf(unavailable)).toBe(COULDNT_LOAD)
    expect(aboutFailed(aboutRow("loading"), { kind: "clone" }, true)).toBe(false)
    expect(aboutFailed(aboutRow("ready", about()), { kind: "clone" }, true)).toBe(false)
    expect(aboutFailed(aboutRow("failed"), { kind: "ready" }, true)).toBe(false)
    expect(aboutFailed(aboutRow("failed"), { kind: "unknown" }, true)).toBe(false)
    expect(aboutFailed(aboutRow("failed"), { kind: "clone" }, false)).toBe(false)
    // A stale failed About answer must not cover Clone's progress or a clone refusal.
    expect(aboutFailed(aboutRow("failed"), headerOf(undefined, clone("requesting"), true), true)).toBe(false)
    expect(aboutFailed(aboutRow("failed"), headerOf(repository({ status: "cloning" }), undefined, true), true)).toBe(false)
    expect(aboutFailed(aboutRow("failed"), headerOf(undefined, clone("failed"), true), true)).toBe(false)
  })

  test("the top level is the repository's home or a ref's root; a file or a folder isn't", () => {
    expect(atRoot({ kind: "tree", path: "" })).toBe(true)
    expect(atRoot({ kind: "tree", path: "docs" })).toBe(false)
    expect(atRoot({ kind: "blob", path: "" })).toBe(false)
  })

  test("the about panel's props: loading, then GitHub's answer with its links; none for a failure", () => {
    expect(aboutOf(undefined)).toBeUndefined()
    expect(aboutOf(aboutRow("loading"))).toBeUndefined()
    expect(aboutOf(aboutRow("ready", about()))).toEqual(about())
    expect(aboutProps(undefined)).toEqual({ loading: true })
    expect(aboutProps(aboutRow("loading"))).toEqual({ loading: true })
    expect(aboutProps(aboutRow("failed"))).toEqual({ loading: false })
    expect(aboutProps(aboutRow("ready", about()))).toMatchObject({
      loading: false,
      description: "Demo",
      stars: 14126,
      release: {
        tag: "v 1",
        name: null,
        publishedAt: Date.parse("2026-10-01T12:00:00Z"),
        href: "https://github.com/octocat/Spoon-Knife/releases/tag/v%201",
      },
      contributors: [{ login: "octo cat", href: "https://github.com/octo%20cat" }],
      contributorCount: 40,
    })
    expect(aboutProps(aboutRow("ready", about({ release: null }))).release).toBeNull()
    expect(
      aboutProps(aboutRow("ready", about({ release: { tag: "v1", name: "One", publishedAt: "not a time" } }))).release,
    ).toMatchObject({ publishedAt: null })
  })

  test("before a clone: GitHub's top folder, README and newest commit", () => {
    expect(previewTreeOf(undefined)).toBeUndefined()
    expect(previewTreeOf(about({ root: null }))).toBeUndefined()
    expect(previewTreeOf(about())).toEqual({ state: "ready", paths: ["README.md"], directories: ["docs"], truncated: false })
    expect(previewReadmeOf(about({ readme: null }))).toBeUndefined()
    // Its size is the UTF-8 bytes, as a file's is.
    expect(previewReadmeOf(about())).toEqual({ path: "README.md", file: { state: "text", contents: "# Hi é", size: 7 } })
    expect(previewCommitOf(undefined)).toBeUndefined()
    expect(previewCommitOf(about({ head: null }))).toBeUndefined()
    expect(previewCommitOf(about({ head: { sha: "e".repeat(40), message: "m", author: "a", at: "" } }))).toBeUndefined()
    expect(previewCommitOf(about())).toEqual({
      message: "First line",
      author: "octocat",
      shortSha: "ddddddd",
      at: Date.parse("2014-02-12T23:20:44Z"),
    })
  })

  test("branch and tag counts: the clone's own once its refs loaded whole, else GitHub's; commits only GitHub's", () => {
    const refs = (fields: Partial<RefsRow> = {}): RefsRow => ({
      key: "k",
      state: "ready",
      branches: [{ name: "main", sha: "a".repeat(40) }],
      tags: [],
      truncated: false,
      message: null,
      ...fields,
    })
    expect(countsOf(undefined, undefined)).toEqual({})
    expect(countsOf(refs(), undefined)).toEqual({ branches: 1, tags: 0 })
    expect(countsOf(refs(), about())).toEqual({ branches: 1, tags: 0, commits: 3 })
    expect(countsOf(refs({ truncated: true }), about())).toEqual({ branches: 3, tags: 1, commits: 3 })
    expect(countsOf(refs({ state: "loading" }), about({ branches: null, tags: null, commits: null }))).toEqual({})
    expect(countLabel(1, "Branch", "Branches")).toBe("1 Branch")
    expect(countLabel(1200, "Tag", "Tags")).toBe("1,200 Tags")
  })

  test("a ready copy storage may reclaim gets the note, with Install when GitHub named the App's path", () => {
    expect(reclaimNoteOf(undefined, about())).toBeUndefined()
    expect(reclaimNoteOf(repository({ reclaimable: false }), about())).toBeUndefined()
    expect(reclaimNoteOf(repository({ status: "cloning", reclaimable: true }), about())).toBeUndefined()
    expect(reclaimNoteOf(repository({ reclaimable: true }), about())).toEqual({
      installUrl: "https://github.com/apps/smithers/installations/new",
    })
    expect(reclaimNoteOf(repository({ reclaimable: true }), undefined)).toEqual({ installUrl: null })
  })
})

describe("generated files", () => {
  const text = (contents: string): BlobRow => ({ key: "k", state: "text", contents, size: contents.length, message: null })
  const tree: TreeRow = {
    key: "t",
    state: "ready",
    paths: ["docs/api.md", "src/api.ts", ".smithers/flows/docs/build/flow.ts"],
    truncated: false,
    message: null,
  }
  const view = { owner: "octocat", name: "Spoon-Knife", revision: "main", manifestPath: ".smithers/generated.json" }
  const manifest = text(JSON.stringify({
    outputs: { "docs/api.md": { flow: "docs/build", inputs: ["src/api.ts", "src/gone.ts"], cacheKey: "abc", run: "r-1" } },
  }))

  test("a file the manifest lists links its flow, its last run and its sources at the view's revision", () => {
    expect(generatedLinksFor(view, repository(), "docs/api.md", "# API", manifest, tree)).toEqual({
      flow: { label: "docs/build", href: "/octocat/Spoon-Knife/blob/main/.smithers/flows/docs/build/flow.ts" },
      run: { label: "r-1", href: "/app/runs/r-1" },
      sources: [{ label: "src/api.ts", href: "/octocat/Spoon-Knife/blob/main/src/api.ts" }, { label: "src/gone.ts" }],
    })
  })

  test("a header marker marks a file with no links; a person's file, or no repository, has none", () => {
    expect(generatedLinksFor(view, repository(), "gen.go", "// Code generated by x. DO NOT EDIT.\npackage x", undefined, tree))
      .toEqual({ sources: [] })
    expect(generatedLinksFor(view, repository(), "src/api.ts", "export {}", manifest, tree)).toBeUndefined()
    expect(generatedLinksFor(view, undefined, "docs/api.md", "# API", manifest, tree)).toBeUndefined()
    // The default branch stands in for a revision the view hasn't resolved; a list not loaded links nothing.
    expect(generatedLinksFor({ ...view, revision: null }, repository(), "docs/api.md", undefined, manifest, undefined))
      .toMatchObject({ flow: { label: "docs/build" }, sources: [{ label: "src/api.ts" }, { label: "src/gone.ts" }] })
    expect(generatedLinksFor({ ...view, revision: null }, repository({ defaultBranch: null }), "x", "@generated", undefined, tree))
      .toEqual({ sources: [] })
    // A manifest still loading, or read without its text, marks nothing yet.
    const loading: BlobRow = { key: "k", state: "loading", contents: null, size: null, message: null }
    expect(generatedLinksFor(view, repository(), "docs/api.md", "# API", loading, tree)).toBeUndefined()
    expect(generatedLinksFor(view, repository(), "docs/api.md", "# API", { ...manifest, contents: null }, tree)).toBeUndefined()
  })

  test("a project's manifest marks only files in its folder, by their paths from it", () => {
    const nested = { ...view, manifestPath: "tools/docgen/.smithers/generated.json" }
    const projectManifest = text(JSON.stringify({ outputs: { "out/a.md": { flow: "docs/generate", inputs: ["project.ts"] } } }))
    const files: TreeRow = { ...tree, paths: ["tools/docgen/project.ts", "tools/docgen/out/a.md"] }
    expect(generatedLinksFor(nested, repository(), "tools/docgen/out/a.md", "# A", projectManifest, files)).toEqual({
      flow: { label: "docs/generate" },
      sources: [{ label: "project.ts", href: "/octocat/Spoon-Knife/blob/main/tools/docgen/project.ts" }],
    })
    // A file outside its folder, though a path inside it reads the same, isn't the manifest's.
    expect(generatedLinksFor(nested, repository(), "out/a.md", "# A", projectManifest, files)).toBeUndefined()
    // No manifest near the view: header markers alone.
    expect(generatedLinksFor({ ...view, manifestPath: null }, repository(), "out/a.md", "# A", projectManifest, files))
      .toBeUndefined()
  })
})

describe("what the page shows", () => {
  /** The view at Spoon-Knife's `path`, a `kind`, with `fields` resolved. */
  const at = (kind: "tree" | "blob", path: string, fields: Partial<ViewRow> = {}): ViewRow => ({
    ...emptyView,
    owner: "octocat",
    name: "Spoon-Knife",
    repoId: "github/octocat/spoon-knife",
    kind,
    path,
    splat: path,
    missing: false,
    ...fields,
  })
  const state = (view: ViewRow, fields: Partial<ViewState> = {}): ViewState => ({
    view,
    repository: undefined,
    clone: undefined,
    about: undefined,
    ...fields,
  })
  /** The view's load found the clone ready through RepoApi's refs, before Electric delivered its row. */
  const resolved = { revision: "main", sha: SHA, defaultBranch: "main" } as const

  test("the repository shown: its ready row, else the view's own resolution, else none", () => {
    expect(shownOf(repository(), at("blob", "README.md"))).toEqual(repository())
    expect(shownOf(undefined, at("blob", "README.md", resolved)))
      .toEqual({ owner: "octocat", name: "Spoon-Knife", defaultBranch: "main" })
    // A row that isn't ready gives way to a resolution that found the clone ready, and says nothing without one.
    expect(shownOf(repository({ status: "cloning" }), at("blob", "README.md", resolved))?.defaultBranch).toBe("main")
    expect(shownOf(repository({ status: "cloning" }), at("blob", "README.md"))).toBeUndefined()
    expect(shownOf(undefined, at("blob", "README.md"))).toBeUndefined()
  })

  test("files once the clone is ready, from its row or from the view's resolution before Electric delivers it", () => {
    expect(pageOf(state(at("blob", "README.md", resolved)))).toEqual({
      kind: "files",
      repository: { owner: "octocat", name: "Spoon-Knife", defaultBranch: "main" },
    })
    expect(pageOf(state(at("blob", "README.md"), { repository: repository() }))).toEqual({
      kind: "files",
      repository: repository(),
    })
    // A root shows its files too, never GitHub's preview, once the clone is ready.
    expect(pageOf(state(at("tree", "", resolved), { about: aboutRow("ready", about()) })).kind).toBe("files")
    // A private repository a visitor can't see on GitHub still shows its clone.
    expect(pageOf(state(at("blob", "a.md", resolved), { about: aboutRow("missing") })).kind).toBe("files")
  })

  test("a skeleton until the live query reads, and while the device can't tell", () => {
    expect(pageOf(undefined)).toEqual({ kind: "loading" })
    expect(pageOf(state(at("blob", "README.md")))).toEqual({ kind: "loading" })
  })

  test("Not found for a URL naming nothing, or a repository GitHub doesn't have with no clone here", () => {
    expect(pageOf(state(at("blob", "README.md", { missing: true })))).toEqual({ kind: "missing" })
    expect(pageOf(state(at("blob", "README.md"), { about: aboutRow("missing") }))).toEqual({ kind: "missing" })
  })

  test("a location that couldn't resolve says why", () => {
    expect(pageOf(state(at("blob", "a.md", { failure: READING_PAUSED })))).toEqual({ kind: "failure", text: READING_PAUSED })
  })

  test("a public root whose About read ended refused offers Try again, with its message or Couldn't load", () => {
    const answered = { answered: true, signedIn: false }
    expect(pageOf(state(at("tree", "", answered), { about: { ...aboutRow("failed"), message: READING_PAUSED } })))
      .toEqual({ kind: "retry", text: READING_PAUSED })
    expect(pageOf(state(at("tree", "", answered), { about: aboutRow("failed") }))).toEqual({ kind: "retry", text: COULDNT_LOAD })
  })

  test("before a clone the top level is GitHub's: loading, then its folder; deeper, Not cloned or Cloning", () => {
    expect(pageOf(state(at("tree", "")))).toEqual({ kind: "preview-loading" })
    expect(pageOf(state(at("tree", ""), { about: aboutRow("loading") }))).toEqual({ kind: "preview-loading" })
    expect(pageOf(state(at("tree", ""), { about: aboutRow("ready", about()) }))).toEqual({ kind: "preview", about: about() })
    // GitHub's answer without a folder: the root says what the header does, as a deeper page.
    expect(pageOf(state(at("tree", "", { answered: true }), { about: aboutRow("ready", about({ root: null })) })))
      .toEqual({ kind: "empty", text: NOT_CLONED })
    expect(pageOf(state(at("blob", "README.md", { answered: true })))).toEqual({ kind: "empty", text: NOT_CLONED })
    expect(pageOf(state(at("blob", "README.md"), { repository: repository({ status: "cloning" }) })))
      .toEqual({ kind: "empty", text: CLONING })
  })

  test("the head commit: the row's, else GitHub's newest when it is the view's commit", () => {
    const head = "d".repeat(40)
    expect(headCommitOf(repository(), SHA, about())).toEqual(commitOf(repository(), SHA))
    expect(headCommitOf(undefined, head, about())).toEqual(previewCommitOf(about()))
    expect(headCommitOf(undefined, SHA, about())).toBeUndefined()
    expect(headCommitOf(undefined, null, about({ head: null }))).toBeUndefined()
    expect(headCommitOf(undefined, head, undefined)).toBeUndefined()
  })
})

 test("only a confirmed absent file shows the missing-file recovery", () => {
  const row: BlobRow = { key: "file", state: "failed", contents: null, size: null, message: "Not found" }
  expect(missingFileOf("blob", row)).toBe(true)
  expect(missingFileOf("tree", row)).toBe(false)
  expect(missingFileOf("blob", undefined)).toBe(false)
  expect(missingFileOf("blob", { ...row, state: "loading" })).toBe(false)
  expect(missingFileOf("blob", { ...row, message: "Reading paused" })).toBe(false)
})

 test("a missing ref is distinct from an unresolved or missing repository", () => {
  const missing = { ...emptyView, missing: true, ref: "no-such-branch", refsKey: "refs" }
  expect(missingRefOf(missing)).toBe(true)
  expect(missingRefOf({ ...missing, missing: false })).toBe(false)
  expect(missingRefOf({ ...missing, ref: null })).toBe(false)
  expect(missingRefOf({ ...missing, refsKey: null })).toBe(false)
})

 test("a tree URL naming a confirmed file redirects without guessing absent paths", () => {
  const tree: TreeRow = { key: "tree", state: "ready", paths: ["README.md", "docs/a b.md"], truncated: false, message: null }
  expect(directoryFileOf("tree", "README.md", tree)).toBe(true)
  expect(directoryFileOf("tree", "docs/a b.md", { ...tree, truncated: true })).toBe(true)
  expect(directoryFileOf("tree", "docs", tree)).toBe(false)
  expect(directoryFileOf("tree", "absent.md", tree)).toBe(false)
  expect(directoryFileOf("tree", "", tree)).toBe(false)
  expect(directoryFileOf("blob", "README.md", tree)).toBe(false)
  expect(directoryFileOf("tree", "README.md", undefined)).toBe(false)
  expect(directoryFileOf("tree", "README.md", { ...tree, state: "loading" })).toBe(false)
  expect(directoryFileOf("tree", "README.md", { ...tree, state: "failed" })).toBe(false)
})
