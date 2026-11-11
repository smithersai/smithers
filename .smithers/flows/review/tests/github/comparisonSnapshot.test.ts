import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseGitDiff } from "../../src/git/parseGitDiff.ts"
import { type ComparedFile, comparisonSnapshot } from "../../src/github/comparisonSnapshot.ts"
import { preparedReviewOf } from "../../src/review/preparedReviewOf.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"

const fixture = JSON.parse(readFileSync(new URL("fixtures/compare-files.json", import.meta.url), "utf8")) as {
  readonly files: ReadonlyArray<ComparedFile>
}
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const input = normalizeOpenCodeReviewInput({ repo: ".", from: "main", concurrency: 4 })
const snapshotOf = (files: ReadonlyArray<ComparedFile>, truncated = false) =>
  comparisonSnapshot({ input, repository: "acme/widgets", base: BASE, head: HEAD, files, truncated })
const recordOf = (filename: string) =>
  snapshotOf(fixture.files).diffs.find((diff) => diff.diff.includes(` b/${filename}`))

describe("a GitHub comparison as the review's change set", () => {
  test("reviews base..head of the repository, keeping the request's other settings", () => {
    const snapshot = snapshotOf(fixture.files)
    expect(snapshot.target).toEqual({ repoDir: "acme/widgets", mode: "range", ref: `${BASE}..${HEAD}` })
    expect(snapshot.input).toEqual({ ...input, repo: "acme/widgets", from: BASE, to: HEAD, commit: "" })
    expect(snapshot.filter).toBeNull()
    expect(snapshot.warnings).toEqual([])
  })

  test("reads every shape GitHub lists into the record git's diff gives", () => {
    const rows = snapshotOf(fixture.files).diffs.map((diff) => ({
      oldPath: diff.oldPath,
      newPath: diff.newPath,
      insertions: diff.insertions,
      deletions: diff.deletions,
      isNew: diff.isNew,
      isDeleted: diff.isDeleted,
      isBinary: diff.isBinary,
      withheld: diff.patchWithheld ?? false
    }))
    const row = (oldPath: string, newPath: string, insertions: number, deletions: number, flags = "") => ({
      oldPath,
      newPath,
      insertions,
      deletions,
      isNew: flags.includes("new"),
      isDeleted: flags.includes("deleted"),
      isBinary: flags.includes("binary"),
      withheld: flags.includes("withheld")
    })
    expect(rows).toEqual([
      row("src/modified.ts", "src/modified.ts", 1, 1),
      row("/dev/null", "src/added.ts", 2, 0, "new"),
      row("src/removed.ts", "/dev/null", 0, 1, "deleted"),
      row("src/renamed-old.ts", "src/renamed-new.ts", 1, 1),
      row("lib/moved.ts", "src/moved.ts", 0, 0),
      row("assets/logo.png", "assets/logo.png", 0, 0, "binary"),
      row("src/generated.ts", "src/generated.ts", 5200, 4100, "withheld"),
      row("scripts/run.sh", "scripts/run.sh", 0, 0),
      row("src/cut.ts", "src/cut.ts", 3, 1)
    ])
  })

  test("writes each file's header as git does, then GitHub's patch as it came", () => {
    expect(recordOf("src/renamed-new.ts")?.diff).toBe([
      "diff --git a/src/renamed-old.ts b/src/renamed-new.ts",
      "rename from src/renamed-old.ts",
      "rename to src/renamed-new.ts",
      "--- a/src/renamed-old.ts",
      "+++ b/src/renamed-new.ts",
      "@@ -1,4 +1,4 @@",
      "-export const name = \"old\"",
      "+export const name = \"new\"",
      " export const same = 1",
      " export const also = 2",
      " export const more = 3"
    ].join("\n"))
    expect(recordOf("src/moved.ts")?.diff).toBe(
      "diff --git a/lib/moved.ts b/src/moved.ts\nrename from lib/moved.ts\nrename to src/moved.ts"
    )
    expect(recordOf("assets/logo.png")?.diff).toBe(
      "diff --git a/assets/logo.png b/assets/logo.png\nBinary files a/assets/logo.png and b/assets/logo.png differ"
    )
    expect(recordOf("src/generated.ts")?.diff).toBe("diff --git a/src/generated.ts b/src/generated.ts")
    // A patch cut inside its hunk is kept as it came: the reviewer sees what GitHub showed.
    expect(recordOf("src/cut.ts")?.diff.endsWith("+  const two = 22\n+  const three = 3")).toBe(true)
  })

  test("reviews the text it was shown and names why it skips the rest", () => {
    const prepared = preparedReviewOf(snapshotOf(fixture.files))
    const reasons = Object.fromEntries(prepared.preview.entries.map((entry) => [entry.path, entry.excludeReason]))
    expect(reasons).toEqual({
      "src/modified.ts": "",
      "src/added.ts": "",
      "src/removed.ts": "",
      "src/renamed-new.ts": "",
      "src/moved.ts": "",
      "assets/logo.png": "binary",
      "src/generated.ts": "patch_withheld",
      "scripts/run.sh": "",
      "src/cut.ts": ""
    })
    expect(prepared.prompt.shouldReview).toBe(true)
    expect(prepared.prompt.files.map((file) => file.path)).toEqual([
      "src/modified.ts",
      "src/added.ts",
      "src/removed.ts",
      "src/renamed-new.ts",
      "src/moved.ts",
      "scripts/run.sh",
      "src/cut.ts"
    ])
    const modified = prepared.prompt.files.find((file) => file.path === "src/modified.ts")
    expect(modified?.prompt).toContain("Repository: acme/widgets")
    expect(modified?.prompt).toContain("+export const b = 3")
    expect(prepared.changes.files.find((file) => file.path === "assets/logo.png")?.diff).toBe("")
  })

  test("a comparison GitHub cut short says the rest were not reviewed", () => {
    expect(snapshotOf(fixture.files.slice(0, 2), true).warnings).toEqual([{
      file: "",
      type: "comparison_truncated",
      message: "GitHub listed only the first 2 changed files; the rest were not reviewed."
    }])
  })
})

describe("the same change read from git", () => {
  const dirs: Array<string> = []
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  test("gives the records the comparison gives, hunks included", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-compare-"))
    dirs.push(dir)
    const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test User")
    git("config", "commit.gpgsign", "false")
    write("src/modified.ts", "export const a = 1\nexport const b = 2\nexport const c = 4\n")
    write("src/removed.ts", "export const removed = 1\n")
    write(
      "src/renamed-old.ts",
      "export const name = \"old\"\nexport const same = 1\nexport const also = 2\nexport const more = 3\n"
    )
    write("lib/moved.ts", "export const moved = 1\nexport const twice = 2\nexport const thrice = 3\n")
    git("add", "-A")
    git("commit", "-qm", "base")
    write("src/modified.ts", "export const a = 1\nexport const b = 3\nexport const c = 4\n")
    write("src/added.ts", "export const added = 1\nexport const more = 2\n")
    rmSync(join(dir, "src/removed.ts"))
    rmSync(join(dir, "src/renamed-old.ts"))
    write(
      "src/renamed-new.ts",
      "export const name = \"new\"\nexport const same = 1\nexport const also = 2\nexport const more = 3\n"
    )
    rmSync(join(dir, "lib/moved.ts"))
    write("src/moved.ts", "export const moved = 1\nexport const twice = 2\nexport const thrice = 3\n")
    git("add", "-A")
    git("commit", "-qm", "head")
    const fromGit = parseGitDiff(git("-c", "core.quotepath=false", "diff", "-M", "--no-color", "HEAD~1", "HEAD"))
    const named = new Set(["src/modified.ts", "src/added.ts", "src/removed.ts", "src/renamed-new.ts", "src/moved.ts"])
    const fromGitHub = snapshotOf(fixture.files.filter((file) => named.has(file.filename))).diffs
    const comparable = (records: typeof fromGit) =>
      records
        .map(({ diff, ...record }) => {
          const at = diff.indexOf("\n@@")
          return { ...record, hunks: at < 0 ? "" : diff.slice(at + 1).trimEnd() }
        })
        .sort((left, right) => left.newPath.localeCompare(right.newPath))
    expect(comparable(fromGitHub)).toEqual(comparable(fromGit))
  })
})
