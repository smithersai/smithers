/**
 * Trusted review edges: the shapes a pinned policy may take, the bounds a
 * snapshot is held to, and the refusals for Git answers the review cannot
 * trust. Policy and source come from memory where a host would supply its own
 * immutable revisions, and from real Git repositories where the review command
 * reads them itself.
 */
import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Label from "../src/Label.ts"
import { prepare, prepareSource, reviewPrepared, type ReviewSource, type SourceEntry } from "../src/TrustedReview.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string) => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const indexPath = ".smithers/target-index.json"
const all = [Label.parse("//...", "")]
const selection = { policyRevision: "base", revision: "head", patterns: all }

/** A trusted policy's attrs as the index stores them, with `overrides` applied. */
const policy = (rubric: string, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...Target.metadata(LlmLint.LlmLint({
      changes: Input.gitDiff("HEAD"),
      include: [Input.glob("//src/**")],
      deps: [],
      prompt: "Inspect selected source.",
      rubric,
      model: "review-test-model",
      batchSize: 1
    })).attrs as LlmLint.Attrs,
    ...overrides
  })

const row = (label: string, rule: string, reviewPolicy?: string) => ({
  label,
  package: label.slice(2, label.indexOf(":")),
  name: label.slice(label.indexOf(":") + 1),
  rule,
  ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
  kinds: ["review"],
  cacheable: false,
  inputs: [],
  outputs: [],
  dependencies: [],
  source: { file: "PACKAGE.ts" }
})

const index = (...rows: ReadonlyArray<ReturnType<typeof row>>) => JSON.stringify(rows)

/** Revisions held in memory; `contents` may be generated so large files need not be stored. */
const memorySource = (revisions: Record<string, Record<string, string | (() => string)>>) => {
  const reads: Array<string> = []
  const text = (value: string | (() => string)) => typeof value === "string" ? value : value()
  const source: ReviewSource = {
    tree: async (revision) =>
      new Map(
        Object.entries(revisions[revision]!).map(([path, contents]): [string, SourceEntry] => [
          path,
          { id: typeof contents === "string" ? `file:${contents}` : `generated:${path}`, regular: true }
        ])
      ),
    read: async (revision, path) => {
      reads.push(`${revision}:${path}`)
      return text(revisions[revision]![path]!)
    },
    grep: async () => []
  }
  return { source, reads }
}

const literal = (path: string) => ({ _tag: "File", path })
const pattern = (glob: string, exclude: ReadonlyArray<string> = []) => ({ _tag: "Glob", pattern: glob, exclude })

describe("the inputs a trusted policy declares", () => {
  it("matches file inputs literally, honours glob exclusions, and always carries context", async () => {
    const trusted = index(row(
      "//:security",
      "LlmLint",
      policy("trusted rubric", {
        include: [literal("src/[id].ts"), pattern("//lib/**", ["//lib/generated/**"])],
        context: [literal("docs/guide.md"), pattern("//notes/*.md")],
        contextTokens: 64_000
      })
    ))
    const base = {
      [indexPath]: trusted,
      "src/[id].ts": "export const id = 1\n",
      "src/i.ts": "export const i = 1\n",
      "lib/a.ts": "export const a = 1\n",
      "lib/generated/b.ts": "export const b = 1\n",
      "docs/guide.md": "guide\n",
      "notes/style.md": "style\n"
    }
    const head = {
      ...base,
      "src/[id].ts": "export const id = 2\n",
      "src/i.ts": "export const i = 2\n",
      "lib/a.ts": "export const a = 2\n",
      "lib/generated/b.ts": "export const b = 2\n"
    }
    const prepared = await prepareSource(memorySource({ base, head }).source, selection)
    expect(prepared.policies).toHaveLength(1)
    expect(prepared.policies[0]!.payload.contextTokens).toBe(64_000)
    // `[id]` is a file name, not a character class matching `src/i.ts`; generated output is excluded.
    expect(prepared.snapshot.map(({ path, changed }) => [path, changed]).sort()).toEqual([
      ["docs/guide.md", false],
      ["lib/a.ts", true],
      ["notes/style.md", false],
      ["src/[id].ts", true]
    ])
  })
})

describe("index rows that are not review policies", () => {
  it("skips non-review rows in the trusted and proposed indexes", async () => {
    const trusted = index(row("//:security", "LlmLint", policy("trusted rubric")), row("//:build", "Command"))
    const proposed = index(
      row("//:security", "LlmLint", policy("trusted rubric")),
      row("//:build", "Command"),
      row("//:test", "Command")
    )
    const base = { [indexPath]: trusted, "src/service.ts": "export const value = 1\n" }
    const head = { ...base, [indexPath]: proposed, "src/service.ts": "export const value = 2\n" }
    const prepared = await prepareSource(memorySource({ base, head }).source, selection)
    expect(prepared.policyChanges).toEqual([indexPath])
    // The review policies did not change, so neither a projection nor proposed checks join.
    expect(prepared.policies.map(({ label }) => label)).toEqual(["//:security"])
  })
})

describe("the proposed checks of a changed policy", () => {
  it("review only usable trusted-scope paths the proposed globs select, on the trusted context window", async () => {
    const trustedPolicy = policy("trusted rubric", { contextTokens: 40_000 })
    const proposedPolicy = policy("narrow rubric", {
      include: [pattern("//src/api/**")],
      context: [pattern("//src/shared.ts")],
      contextTokens: 100_000
    })
    const files = {
      "src/api/handler.ts": "export const handler = 1\n",
      "src/api/route.ts": "export const route = 1\n",
      "src/shared.ts": "export const shared = 1\n",
      "src/other.ts": "export const other = 1\n",
      "/src/absolute.ts": "export const absolute = 1\n"
    }
    const base = { ...files, [indexPath]: index(row("//:security", "LlmLint", trustedPolicy)) }
    const head = { ...files, [indexPath]: index(row("//:security", "LlmLint", proposedPolicy)) }
    const prepared = await prepareSource(memorySource({ base, head }).source, selection)
    const proposed = prepared.policies.find(({ label }) => label === "//:security#proposed-checks")!
    expect(proposed.payload.rubric).toBe("narrow rubric")
    expect(proposed.payload.contextTokens).toBe(40_000)
    expect(proposed.snapshot?.map(({ path }) => path)).toEqual([
      "src/api/handler.ts",
      "src/api/route.ts",
      "src/shared.ts"
    ])
  })
})

describe("the snapshot size limit", () => {
  const mebibyte = () => "x".repeat(LlmLint.maximumReviewFileBytes)
  const many = (count: number, contents: string | (() => string)) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, at) => [`src/file-${String(at).padStart(3, "0")}.ts`, contents])
    )

  it("refuses changed source past 64 MiB at the file that crosses it", async () => {
    const base = { [indexPath]: index(row("//:security", "LlmLint", policy("trusted rubric"))) }
    const head = { ...base, ...many(66, mebibyte) }
    const { source, reads } = memorySource({ base, head })
    await expect(prepareSource(source, selection)).rejects.toThrow("Review snapshot exceeds its size limit")
    // 64 files fill the limit exactly; the 65th crosses it and the 66th is never read.
    expect(reads.filter((read) => read.startsWith("head:src/"))).toHaveLength(65)
  })

  it("refuses unchanged source a changed check would load past 64 MiB", async () => {
    const files = many(66, mebibyte)
    const base = { ...files, [indexPath]: index(row("//:security", "LlmLint", policy("trusted rubric"))) }
    const head = { ...files, [indexPath]: index(row("//:security", "LlmLint", policy("stricter rubric"))) }
    const { source, reads } = memorySource({ base, head })
    await expect(prepareSource(source, selection)).rejects.toThrow("Review snapshot exceeds its size limit")
    expect(reads.filter((read) => read.startsWith("head:src/"))).toHaveLength(65)
  })
})

describe("reviewing a prepared policy-change selection", () => {
  it("labels the index projection and gives the trusted review its context files", async () => {
    const trustedPolicy = policy("trusted rubric", { context: [pattern("//docs/*.md")] })
    const base = {
      [indexPath]: index(row("//:security", "LlmLint", trustedPolicy)),
      "src/service.ts": "export const value = 1\n",
      "docs/threat-model.md": "THREAT MODEL: callers are untrusted\n"
    }
    const head = {
      ...base,
      [indexPath]: index(
        row("//:security", "LlmLint", policy("stricter rubric", { context: [pattern("//docs/*.md")] }))
      ),
      "src/service.ts": "export const value = 2\n"
    }
    const prepared = await prepareSource(memorySource({ base, head }).source, selection)
    const root = await temporary("smithers-review-edges-root-")
    const store = await temporary("smithers-review-edges-store-")
    const prompts: Array<string> = []
    const transport: LlmLint.ReviewTransport = (requested) =>
      Effect.succeed({
        modelId: requested.model,
        model: {
          stream: (request) =>
            Stream.suspend(() => {
              prompts.push(
                request.messages.flatMap((message) =>
                  message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
                ).join("\n")
              )
              return Stream.fromIterable([
                { type: "text-delta" as const, id: "t", text: "[]" },
                { type: "settle" as const, stopReason: "stop" as const }
              ])
            })
        }
      })
    const result = await reviewPrepared(prepared, { root, findingsStore: store, transport })
    expect(result.reviews.map((review) => [review.label, "representation" in review])).toEqual([
      ["//:security", false],
      ["//:proposed-review-index", true],
      ["//:security#proposed-checks", false]
    ])
    expect(result.reviews[1]).toMatchObject({ representation: "review-policy-changes" })
    // The trusted review read its context file from the shared snapshot, though no include selects it.
    expect(result.reviews[0]).toMatchObject({
      status: "completed",
      files: ["src/service.ts"],
      manifest: { context: [{ path: "docs/threat-model.md" }] }
    })
    expect(prompts.some((prompt) => prompt.includes("THREAT MODEL: callers are untrusted"))).toBe(true)
  })
})

const git = (root: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()

const repository = async () => {
  const root = await temporary("smithers-review-edges-git-")
  git(root, "init", "-q")
  git(root, "config", "user.name", "Review Test")
  git(root, "config", "user.email", "review@example.invalid")
  await Fs.writeFile(NodePath.join(root, "WORKSPACE.ts"), "export const Workspace = 1\n")
  await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "export const Package = 1\n")
  await Fs.mkdir(NodePath.join(root, "src"))
  await Fs.writeFile(NodePath.join(root, "src/service.ts"), "export const value = 1\n")
  await Fs.mkdir(NodePath.join(root, ".smithers"))
  await Fs.writeFile(NodePath.join(root, indexPath), index(row("//:security", "LlmLint", policy("trusted rubric"))))
  git(root, "add", ".")
  git(root, "commit", "-qm", "trusted policy")
  return { root, trusted: git(root, "rev-parse", "HEAD") }
}

/** Runs `body` with `PATH` replaced, restoring it afterwards. */
const withPath = async <A>(path: string | undefined, body: () => Promise<A>): Promise<A> => {
  const original = process.env["PATH"]
  if (path === undefined) delete process.env["PATH"]
  else process.env["PATH"] = path
  try {
    return await body()
  } finally {
    process.env["PATH"] = original
  }
}

/** A `git` that answers one subcommand with `output` and delegates the rest to the real Git. */
const faultyGit = async (subcommand: string, output: string) => {
  const directory = await temporary("smithers-review-edges-bin-")
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  await Fs.writeFile(
    NodePath.join(directory, "git"),
    `#!/bin/sh\ncase " $* " in *" ${subcommand} "*) printf '${output}'; exit 0;; esac\nexec ${real} "$@"\n`,
    { mode: 0o755 }
  )
  return `${directory}:${process.env["PATH"]}`
}

describe("the Git answers a review refuses", () => {
  it("refuses a directory outside any workspace before asking Git anything", async () => {
    const outside = await temporary("smithers-review-edges-outside-")
    await expect(
      prepare({ workspace: outside, policyRevision: "a".repeat(40), revision: undefined, patterns: [] })
    ).rejects.toThrow("No workspace found")
  })

  it("refuses a policy pin that names an annotated tag rather than a commit", async () => {
    const { root } = await repository()
    git(root, "tag", "-a", "-m", "trusted", "policy-tag")
    const tag = git(root, "rev-parse", "policy-tag")
    await expect(prepare({ workspace: root, policyRevision: tag, revision: undefined, patterns: [] }))
      .rejects.toThrow("Policy revision must identify a commit directly")
  })

  it("reads every package when no pattern is given, even with no PATH in the environment", async () => {
    const { root, trusted } = await repository()
    const prepared = await withPath(
      undefined,
      () => prepare({ workspace: root, policyRevision: trusted, revision: undefined, patterns: [] })
    )
    expect(prepared.revision).toBe(trusted)
    expect(prepared.policies.map(({ label }) => label)).toEqual(["//:security"])
  })

  it("refuses a reviewed revision Git does not report as an object name", async () => {
    const { root, trusted } = await repository()
    const path = await faultyGit("HEAD^{commit}", "not-a-commit\\n")
    await expect(
      withPath(path, () => prepare({ workspace: root, policyRevision: trusted, revision: "HEAD", patterns: [] }))
    )
      .rejects.toThrow("Git returned an invalid review revision")
  })

  it("refuses a tree listing whose record has no path separator", async () => {
    const { root, trusted } = await repository()
    const path = await faultyGit("ls-tree", "100644 blob 0123456789abcdef0123456789abcdef01234567\\0")
    await expect(
      withPath(path, () => prepare({ workspace: root, policyRevision: trusted, revision: undefined, patterns: [] }))
    )
      .rejects.toThrow("Invalid review snapshot path")
  })

  it("treats a tree record without an object id as no readable target index", async () => {
    const { root, trusted } = await repository()
    const path = await faultyGit("ls-tree", `100644 blob\\t${indexPath}\\0`)
    await expect(
      withPath(path, () => prepare({ workspace: root, policyRevision: trusted, revision: undefined, patterns: [] }))
    )
      .rejects.toThrow("The pinned review revision has no target index")
  })
})
