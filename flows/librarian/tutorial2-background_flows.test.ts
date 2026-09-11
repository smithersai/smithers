import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateWiki, Wiki, registration as wikiRegistration } from "./wiki/flow.ts"
import { Effect, Layer } from "effect"
import * as NodeRuntime from "@smthrs/flows/BunRuntime"
import { generateHistory, History, registration as historyRegistration } from "./history/flow.ts"
import { git } from "./tutorial2-background_flows-git.ts"

const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), "tutorial2-background_flows-"))
  await git(root, ["init", "-b", "main"])
  await git(root, ["config", "user.name", "Test"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(root, "README.md"), "# A real repository\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "-m", "Initial source"])
  return root
}

describe("Librarian generation against real Git", () => {
  test("linked Markdown pages have exact source revision provenance", async () => {
    const root = await repository()
    try {
      const receipt = await generateWiki(root, "will/demo")
      expect(receipt.sourceHead).toBe(await git(root, ["rev-parse", "HEAD"]))
      expect(receipt.pages).toHaveLength(2)
      expect(receipt.pages[1]!.body).toContain("README.md")
      expect(receipt.pages[1]!.sources).toEqual([`git:will/demo@${receipt.sourceHead}:README.md`])
      expect(receipt.pages[0]!.links).toEqual([receipt.pages[1]!.path])
      expect(await generateWiki(root, "will/demo")).toEqual(receipt)
      expect(await git(root, ["status", "--porcelain"])).toBe("")
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30000)
  test("mythical and notes are real refs, source tree/main/dirty worktree are unchanged, replay is idempotent", async () => {
    const root = await repository()
    try {
      const before = await git(root, ["rev-parse", "HEAD"])
      await writeFile(join(root, "README.md"), "Uncommitted human edit\n")
      const dirty = await git(root, ["diff"])
      const receipt = await generateHistory(root, "will/demo")
      expect(receipt.treeEqual).toBe(true)
      expect(await git(root, ["rev-parse", "mythical^{tree}"])).toBe(await git(root, ["rev-parse", "main^{tree}"]))
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(before)
      expect(await git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main")
      expect(await git(root, ["diff"])).toBe(dirty)
      const note = await git(root, ["notes", "--ref=mythical", "show", receipt.mythicalHead])
      expect(note).toContain(`Source commit: ${before}`)
      expect(note).toContain("## Evidence")
      expect(await generateHistory(root, "will/demo")).toEqual(receipt)
      await git(root, ["add", "README.md"])
      await git(root, ["commit", "-m", "Human change"])
      await expect(generateHistory(root, "will/demo")).rejects.toThrow("already exists")
      expect(await git(root, ["rev-parse", "mythical"])).toBe(receipt.mythicalHead)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30000)
})


test("two durable engine executions replay their recorded outputs after the host is recreated", async () => {
  const root = await repository()
  try {
    const saved: unknown[] = []
    const host = () => NodeRuntime.layerHost({ filename: join(root, "engine.db"), workspaceRoot: root,
      owner: { hostId: "tutorial2-background_flows" }, signals: [] }, Layer.mergeAll(
        wikiRegistration(root, async receipt => { saved.push(receipt) }), historyRegistration(root)))
    const wikiId = crypto.randomUUID(), historyId = crypto.randomUUID()
    const invocation = { flow: "librarian/wiki", input: { repo: "will/demo" }, prompt: "", model: null,
      placement: null, placementOptions: null, capabilities: [], flows: [] }
    const wiki = () => Effect.runPromise(Effect.scoped(Wiki.execute(invocation, { executionId: wikiId }).pipe(Effect.provide(host()))))
    const first = await wiki()
    const history = await Effect.runPromise(Effect.scoped(History.execute({ ...invocation, flow: "librarian/history" }, { executionId: historyId }).pipe(Effect.provide(host()))))
    expect(wikiId).not.toBe(historyId)
    expect(history.sourceHead).toBe(first.sourceHead)
    expect(await wiki()).toEqual(first)
    expect(saved).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
