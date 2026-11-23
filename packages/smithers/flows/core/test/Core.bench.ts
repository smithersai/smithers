import { describe, test } from "vitest"
import { Digest, Graph, Markdown } from "../src/index.ts"

const skillDocument = `---
name: release-verify
description: Verify release artifacts, checksums, and migration parity before cutting a tag.
allowed-tools: build test check lint verify-checksums
license: MIT
compatibility: Node >= 22 and Bun >= 1.4
metadata:
  owner: platform
  tier: release
---

# Release Verification

Run the build, verify checksums for every workspace tarball, and confirm that all migration ledgers match head.
`

const markdownMeta: Markdown.MarkdownFrontmatter = {
  name: "triage-pr",
  description: "Inspect a pull request diff and produce structured review findings.",
  model: ["fast", "smart"],
  flows: ["diff-read", "test-run", "lint-check"],
  capabilities: ["fs:read:/workspace/**", "proc:spawn:pnpm"],
  effects: {
    reads: ["src/**", "test/**"],
    writes: ["reports/review.json"],
    mode: "expected",
    onConflict: "lane"
  },
  placement: "sandbox"
}

const markdownBody = "Review every changed file, cite line ranges, and check for regressions."
const lowered = Markdown.lowerMarkdown(markdownMeta, markdownBody)

const digestInput = {
  flow: "triage-pr",
  version: 1,
  files: Array.from({ length: 20 }, (_, i) => ({ path: `src/mod-${i}.ts`, bytes: 1024 + i * 17 }))
}

const opts = { time: 120, warmupTime: 30 }

const parseSkillFn = Markdown.parseSkill
const lowerSkillFn = Markdown.lowerSkill
const lowerMarkdownFn = Markdown.lowerMarkdown
const buildGraph = Graph.build
const graphNodes = Graph.nodes
const canonicalFn = Digest.canonical
const digestFn = Digest.digest

describe("@smthrs/core", () => {
  test("Markdown.parseSkill YAML frontmatter + validation", async ({ bench }) => {
    await bench("Markdown.parseSkill", () => {
      parseSkillFn(skillDocument)
    }).run(opts)
  })

  test("Markdown.lowerSkill end-to-end", async ({ bench }) => {
    await bench("Markdown.lowerSkill", () => {
      lowerSkillFn(skillDocument)
    }).run(opts)
  })

  test("Markdown.lowerMarkdown with effects & capabilities", async ({ bench }) => {
    await bench("Markdown.lowerMarkdown", () => {
      lowerMarkdownFn(markdownMeta, markdownBody)
    }).run(opts)
  })

  test("Graph.build + Graph.nodes on lowered flow call", async ({ bench }) => {
    await bench("Graph.build(lowered.call)", () => {
      graphNodes(buildGraph(lowered.call({ args: "PR #123" })))
    }).run(opts)
  })

  test("Digest.canonical + Digest.digest", async ({ bench }) => {
    await bench("Digest.digest(Digest.canonical)", () => {
      digestFn(canonicalFn(digestInput))
    }).run(opts)
  })
})
