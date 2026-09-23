import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { type Tab, Workspace } from "../src/workspace.ts"

const host: Host.Host = {
  cwd: "/work/repo",
  judged: false,
  compaction: async () => undefined,
  dispose: async () => {},
  run: () => ({ done: new Promise(() => {}), cancel: () => {} })
}

/** A chat session whose worker tab was saved as `status`, before a second user turn. */
const session = (status: Tab["status"]) => {
  process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
  const worker = Session.create(host.cwd, "worker")
  worker.append({ type: "outcome", at: 2, prompt: "fix", outcome: { _tag: "done", answer: "fixed" } })
  const chat = Session.create(host.cwd)
  const tab: Tab = { id: "fix", title: "Fix", prompt: "fix", seat: "worker:test", file: worker.file, status, startedAt: 1 }
  chat.append({ type: "user", at: 1, text: "delegate" })
  chat.append({ type: "tab", tab })
  chat.append({ type: "user", at: 3, text: "next" })
  const turn = Session.turns(Session.load(chat.file)).find((each) => each.text === "next")!
  const forked = Session.fork(chat.file, host.cwd, turn)
  if (forked._tag !== "Forked") throw new Error(forked._tag)
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: forked.writer.append,
    restored: Session.restore(forked.records).workspace
  })
  return { chat, worker, forked, workspace }
}

describe("workers across a fork", () => {
  it("recovers a running tab from its worker file and records it in the fork, not the source", () => {
    const { chat, forked, workspace } = session("running")
    const before = readFileSync(chat.file, "utf8")
    expect(workspace.read("fix")).toMatchObject({ status: "done", answer: "fixed" })
    expect(readFileSync(chat.file, "utf8")).toBe(before)
    expect(Session.load(forked.writer.file).at(-1)).toMatchObject({ type: "tab", tab: { status: "done" } })
    workspace.dispose()
  })

  it("retries a failed tab into a new worker file", () => {
    const { worker, workspace } = session("failed")
    workspace.retry("fix")
    expect(workspace.snapshot().tabs[0]?.file).not.toBe(worker.file)
    workspace.dispose()
  })
})
