import { beforeEach, describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Session from "../src/session.ts"

beforeEach(() => {
  process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
})

describe("session files", () => {
  it("drops a torn last line instead of failing the load", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "fix add" })
    appendFileSync(writer.file, '{"type":"user","at":2,"te')
    expect(Session.load(writer.file).map((record) => record.type)).toEqual(["session", "user"])
  })

  it("refuses a record damaged before the last line with its line number", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "one" })
    appendFileSync(writer.file, "{oops\n")
    writer.append({ type: "user", at: 2, text: "two" })
    expect(() => Session.load(writer.file)).toThrow(/line 3/)
  })

  it("quarantines a damaged file so the listing moves on", () => {
    const damaged = Session.create("/work/repo")
    damaged.append({ type: "user", at: 1, text: "one" })
    appendFileSync(damaged.file, "{oops\n")
    damaged.append({ type: "user", at: 2, text: "two" })
    const error = (() => {
      try {
        Session.load(damaged.file)
      } catch (error) {
        return error
      }
    })()
    expect(Session.quarantine(damaged.file, error)).toContain(".damaged")
    expect(existsSync(damaged.file)).toBe(false)
    expect(Session.list("/work/repo")).toEqual([])
  })

  it("lists every other session when one holds garbage", () => {
    const good = Session.create("/work/repo")
    good.append({ type: "user", at: 1, text: "good" })
    const folder = Session.directory("/work/repo")
    writeFileSync(join(folder, "bad.jsonl"), "\u0000garbage\n{nope")
    expect(Session.list("/work/repo").map((row) => row.firstPrompt)).toContain("good")
  })

  it("keeps distinct paths whose slugs match in distinct folders", () => {
    expect(Session.directory("/tmp/foo-bar")).not.toBe(Session.directory("/tmp/foo/bar"))
    Session.create("/tmp/foo-bar").append({ type: "user", at: 1, text: "dash" })
    Session.create("/tmp/foo/bar").append({ type: "user", at: 1, text: "slash" })
    expect(Session.list("/tmp/foo-bar").map((row) => row.firstPrompt)).toEqual(["dash"])
    expect(Session.list("/tmp/foo/bar").map((row) => row.firstPrompt)).toEqual(["slash"])
  })

  it("still lists a session in the pre-hash folder when its header names this cwd", () => {
    const legacy = join(process.env.SMITHERS_TUI_SESSION_DIR!, "--tmp-foo-bar--")
    mkdirSync(legacy, { recursive: true })
    const line = (record: Session.Record) => JSON.stringify(record) + "\n"
    const header = (cwd: string): Session.Record => ({ type: "session", version: 1, id: cwd, cwd, createdAt: 1 })
    writeFileSync(join(legacy, "a.jsonl"), line(header("/tmp/foo-bar")) + line({ type: "user", at: 1, text: "mine" }))
    writeFileSync(join(legacy, "b.jsonl"), line(header("/tmp/foo/bar")) + line({ type: "user", at: 1, text: "other" }))
    expect(Session.list("/tmp/foo-bar").map((row) => row.firstPrompt)).toEqual(["mine"])
    expect(Session.list("/tmp/foo/bar").map((row) => row.firstPrompt)).toEqual(["other"])
  })

  it("writes owner-only folders and files, repairing a reopened file", () => {
    const writer = Session.create("/work/repo", "worker")
    writer.append({ type: "user", at: 1, text: "secret" })
    expect(statSync(writer.file).mode & 0o777).toBe(0o600)
    expect(statSync(Session.directory("/work/repo")).mode & 0o777).toBe(0o700)
    expect(statSync(join(Session.directory("/work/repo"), "workers")).mode & 0o777).toBe(0o700)
    const loose = join(Session.directory("/work/repo"), "loose.jsonl")
    writeFileSync(loose, "", { mode: 0o644 })
    Session.reopen(loose).append({ type: "name", name: "n" })
    expect(statSync(loose).mode & 0o777).toBe(0o600)
  })

  it("names a session from its last name record and its first prompt", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "name", name: "first name" })
    writer.append({ type: "user", at: 1, text: "one" })
    writer.append({ type: "user", at: 2, text: "two" })
    writer.append({ type: "name", name: "second name" })
    expect(Session.list("/work/repo")).toMatchObject([{ name: "second name", firstPrompt: "one" }])
  })
})
