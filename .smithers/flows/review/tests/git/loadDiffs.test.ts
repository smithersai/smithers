import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effectivePath } from "../../src/git/effectivePath.ts"
import { loadDiffs as loadDiffsImpl } from "../../src/git/loadDiffs.ts"
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts"
import { reviewOwnPaths } from "../../src/review/reviewOwnPaths.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import { testIo } from "../io.ts"
import { tempRepos } from "../support/tempRepos.ts"

const { git, jj, write, track, initRepo, initJjRepo } = tempRepos()

const at = (dir: string, rev: string, field: "commit_id" | "change_id") =>
  jj(dir, ["--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", field])

describe("loadDiffs", () => {
  test("workspace mode renders untracked symlinks as their target, never the linked file", async () => {
    const dir = initRepo()
    write(join(dir, "src/app.ts"), "export const v = 1;\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])

    // A readable file outside the repository, reachable only through a link.
    const outside = mkdtempSync(join(tmpdir(), "ocr-outside-"))
    track(outside)
    const secretPath = join(outside, "credentials.txt")
    writeFileSync(secretPath, "DUMMY_SECRET_OUTSIDE_REPO\n")
    symlinkSync(secretPath, join(dir, "src/leak.ts"))
    symlinkSync(join(outside, "absent.txt"), join(dir, "src/broken.ts"))
    symlinkSync(outside, join(dir, "src/linkdir.ts"))
    write(join(dir, "src/plain.ts"), "export const plain = 1;\n")

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir })
    const whole = diffs.map((d) => d.diff).join("\n")
    expect(whole).not.toContain("DUMMY_SECRET_OUTSIDE_REPO")

    const leak = diffs.find((d) => effectivePath(d) === "src/leak.ts")
    expect(leak?.diff).toContain("new file mode 120000")
    expect(leak?.diff).toContain(`+${secretPath}`)
    // A dangling link still renders; it must not throw or read anything.
    const broken = diffs.find((d) => effectivePath(d) === "src/broken.ts")
    expect(broken?.diff).toContain("new file mode 120000")
    expect(broken?.diff).toContain(`+${join(outside, "absent.txt")}`)
    // A link to a directory is not walked into.
    const linkDir = diffs.find((d) => effectivePath(d) === "src/linkdir.ts")
    expect(linkDir?.diff).toContain("new file mode 120000")
    // Ordinary untracked files still contribute their contents.
    const plain = diffs.find((d) => effectivePath(d) === "src/plain.ts")
    expect(plain?.diff).toContain("+export const plain = 1;")
    expect(plain?.diff).not.toContain("new file mode 120000")
  })
  test("workspace mode leaves out the review's own state dir and the output paths it is handed", async () => {
    const dir = initRepo()
    write(join(dir, "src/app.ts"), "export const v = 1;\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    // No .gitignore: everything below is untracked.
    write(join(dir, "src/app.ts"), "export const v = 2;\n")
    write(join(dir, ".smithers-review/review.db"), "db")
    write(join(dir, ".smithers-review/walkthrough.html"), "<html></html>")
    write(join(dir, ".smithers-review/.smithers-review-artifacts/a.html"), "<html></html>")
    write(join(dir, "docs/walk.html"), "<html></html>")
    write(join(dir, "docs/.smithers-review-artifacts/b.html"), "<html></html>")
    write(join(dir, "state/r.db"), "db")
    write(join(dir, "state/r.db-wal"), "wal")
    // Neighbours of the excluded paths stay in the review.
    write(join(dir, ".smithers-reviewer/keep.ts"), "export const keep = 1;\n")
    write(join(dir, "docs/walk.html.ts"), "export const keep = 2;\n")
    write(join(dir, "state/r.dbx.ts"), "export const keep = 3;\n")

    const paths = async (own: ReadonlyArray<string>) =>
      (await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir }, own)).map(effectivePath).sort()
    const always = ["src/app.ts", ".smithers-reviewer/keep.ts", "docs/walk.html.ts", "state/r.dbx.ts"]

    expect(await paths([])).toEqual(
      [...always, "docs/.smithers-review-artifacts/b.html", "docs/walk.html", "state/r.db", "state/r.db-wal"].sort()
    )
    expect(await paths(reviewOwnPaths(dir, { out: "docs/walk.html", db: join(dir, "state/r.db") }))).toEqual(
      always.sort()
    )
  })
  test("workspace mode keeps every untracked name exactly, spaces, delimiters and quotes included", async () => {
    const dir = initRepo()
    write(join(dir, "base.txt"), "base\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    const names = [
      "plain.txt",
      " leading.txt ",
      "trailing.txt  ",
      "   ",
      "dir/ spaced/inner .txt",
      "new\nline.txt",
      "tab\tfile.txt",
      "q\"uo\\te.txt",
      "bell\u0007.txt",
      "x b/y.txt",
      "café 🎉.txt"
    ]
    for (const name of names) write(join(dir, name), `after ${JSON.stringify(name)}\n`)

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir })
    expect(diffs.map(effectivePath).sort()).toEqual([...names].sort())
    for (const name of names) {
      const record = diffs.find((d) => effectivePath(d) === name)!
      expect(record).toMatchObject({ isNew: true, isDeleted: false, insertions: 1, deletions: 0 })
      expect(record.diff).toContain(`+after ${JSON.stringify(name)}`)
    }
  })
})

describe("loadDiffs in a jj workspace with no .git", () => {
  /** A base commit, then one commit that edits, deletes, renames, adds, and changes a binary. */
  function editedCommit() {
    const dir = initJjRepo()
    write(join(dir, "a.txt"), "one\ntwo\nthree\n")
    write(join(dir, "gone.txt"), "gone\n")
    writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2]))
    write(join(dir, "moved.txt"), "a line that stays the same\nand another\nand a third\n")
    jj(dir, ["commit", "-m", "base"])
    write(join(dir, "a.txt"), "one\nTWO\nthree\n")
    rmSync(join(dir, "gone.txt"))
    writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 3]))
    rmSync(join(dir, "moved.txt"))
    write(join(dir, "renamed.txt"), "a line that stays the same\nand another\nand a third\n")
    write(join(dir, "sp ace.txt"), "new\n")
    jj(dir, ["commit", "-m", "change"])
    return dir
  }

  test("commit mode reads one jj commit: edit, deletion, rename, new file and binary", async () => {
    const dir = editedCommit()
    expect(existsSync(join(dir, ".git"))).toBe(false)
    for (const commit of [at(dir, "@-", "commit_id"), at(dir, "@-", "change_id"), "@-"]) {
      const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir, commit })
      const byPath = Object.fromEntries(diffs.map((d) => [effectivePath(d), d]))
      expect(Object.keys(byPath).sort()).toEqual(["a.txt", "b.bin", "gone.txt", "renamed.txt", "sp ace.txt"])
      expect(byPath["a.txt"]).toMatchObject({ insertions: 1, deletions: 1, isBinary: false })
      expect(byPath["a.txt"]!.diff).toContain("+TWO")
      expect(byPath["gone.txt"]).toMatchObject({ isDeleted: true, deletions: 1 })
      expect(byPath["b.bin"]).toMatchObject({ isBinary: true })
      expect(byPath["renamed.txt"]).toMatchObject({ oldPath: "moved.txt", newPath: "renamed.txt", isNew: false })
      expect(byPath["sp ace.txt"]).toMatchObject({ isNew: true, insertions: 1 })
    }
  })

  test("range mode reads from the fork point to the far end, leaving the near side out", async () => {
    const dir = initJjRepo()
    write(join(dir, "base.txt"), "base\n")
    jj(dir, ["commit", "-m", "base"])
    const base = at(dir, "@-", "commit_id")
    write(join(dir, "side.txt"), "only on the side\n")
    jj(dir, ["commit", "-m", "side"])
    const side = at(dir, "@-", "change_id")
    jj(dir, ["new", base])
    write(join(dir, "first.txt"), "first\n")
    jj(dir, ["commit", "-m", "first"])
    write(join(dir, "base.txt"), "base, edited\n")
    jj(dir, ["commit", "-m", "second"])
    const tip = at(dir, "@-", "change_id")
    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir, from: side, to: tip })
    expect(diffs.map(effectivePath).sort()).toEqual(["base.txt", "first.txt"])
  })

  test("a snapshot pins the commit, reads the rule from its parent, and refuses option-shaped or ambiguous refs", async () => {
    const dir = initJjRepo()
    write(join(dir, ".opencodereview/rule.json"), JSON.stringify({ exclude: ["docs/**"] }))
    write(join(dir, "src/a.ts"), "export const a = 1;\n")
    jj(dir, ["commit", "-m", "base with a rule"])
    // The change rewrites the rule to hide itself; the parent's rule still governs.
    write(join(dir, ".opencodereview/rule.json"), JSON.stringify({ exclude: ["src/**"] }))
    write(join(dir, "src/a.ts"), "export const a = 2;\n")
    write(join(dir, "docs/a.md"), "notes\n")
    jj(dir, ["commit", "-m", "change"])
    const commitId = at(dir, "@-", "commit_id")
    const snapshot = await loadReviewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "@-" })
    expect(snapshot.target).toMatchObject({ repoDir: dir, mode: "commit", ref: "@-" })
    expect(snapshot.input.commit).toBe(commitId)
    expect(snapshot.filter).toEqual({ include: [], exclude: ["docs/**"] })
    expect(snapshot.diffs.map(effectivePath).sort()).toEqual([".opencodereview/rule.json", "docs/a.md", "src/a.ts"])

    // The first commit's parent is jj's root commit, which holds no rule.
    const first = await loadReviewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "@--" })
    expect(first.filter).toBeNull()

    const range = await loadReviewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, from: "@--", to: "@-" })
    expect(range.input).toMatchObject({ from: at(dir, "@--", "commit_id"), to: commitId })
    expect(range.filter).toEqual({ include: [], exclude: ["docs/**"] })

    await expect(loadReviewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "--help" }))
      .rejects.toThrow(/--help does not name a commit: .*revset/i)
    await expect(loadReviewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "all()" }))
      .rejects.toThrow(/all\(\) does not name a commit: all\(\) names 4 commits; a review reads one/)
  })
})

const loadDiffs = (...args: Parameters<typeof loadDiffsImpl>) => testIo(() => loadDiffsImpl(...args))
const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) =>
  testIo(() => loadReviewSnapshotImpl(...args))
