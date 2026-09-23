import { beforeEach, describe, expect, it } from "bun:test"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
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

describe("Session.guarded", () => {
  it("reports the first refused write of each run of failures instead of throwing, and keeps saving once the disk accepts again", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tui-session-")), "chat.jsonl")
    writeFileSync(file, "")
    const reports: Array<Session.WriteFailed> = []
    const writer = Session.guarded(Session.reopen(file), (failure) => reports.push(failure))
    const record = (text: string): Session.Record => ({ type: "user", at: 1, text })

    writer.append(record("saved"))
    chmodSync(file, 0o444)
    expect(() => writer.append(record("refused"))).not.toThrow()
    writer.append(record("refused again"))
    expect(reports).toEqual([{ _tag: "SessionWriteFailed", file, message: expect.stringContaining("EACCES") }])

    chmodSync(file, 0o600)
    writer.append(record("saved again"))
    chmodSync(file, 0o444)
    writer.append(record("refused after recovery"))
    expect(reports).toHaveLength(2)
    expect(Session.load(file).map((each) => (each.type === "user" ? each.text : each.type))).toEqual(["saved", "saved again"])
  })
})

describe("credentials in a saved session", () => {
  const key = "sk-ant-api03-Qx7Lm2Vb9Tz4Rk8Wp1Ns6Hd3"
  const pat = "ghp_R4nD0mT0k3nV4lu3F0rT3st1ngPurp0s3s12"
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----"
  const identity = { session: "tui-1-0", frame: 1, cell: "c", ordinal: 0, declaration: "d", layers: [] }
  const records: ReadonlyArray<Session.Record> = [
    { type: "user", at: 1, text: "why does auth fail" },
    {
      type: "shell",
      at: 2,
      excluded: false,
      result: { command: "cat ~/.config/gh/hosts.yml", output: `github.com:\n  oauth_token: ${pat}\n`, exitCode: 0, cancelled: false }
    },
    { type: "event", at: 3, event: { _tag: "cell-call-started", call: { flowName: "read", input: { path: "~/.ssh/id_ed25519" }, identity } } as never },
    {
      type: "event",
      at: 4,
      event: { _tag: "cell-call-settled", flowName: "read", identity, result: { outcome: "success", value: { content: pem } } } as never
    },
    { type: "event", at: 5, event: { _tag: "cell-printed", cell: "c", text: `ANTHROPIC_API_KEY=${key}\n` } as never },
    { type: "outcome", at: 6, prompt: "why does auth fail", outcome: { _tag: "done", answer: `Your token ${pat} is expired.` } }
  ]

  for (const kind of ["chat", "worker"] as const) {
    it(`a ${kind} file holds no credential the shell or a harness call surfaced, and still restores`, () => {
      const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")), kind)
      for (const record of records) writer.append(record)

      const saved = readFileSync(writer.file, "utf8")
      for (const secret of [key, pat, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"]) expect(saved).not.toContain(secret)

      const restored = Session.restore(Session.load(writer.file))
      expect(restored.prompts).toEqual(["why does auth fail", "!cat ~/.config/gh/hosts.yml"])
      const shell = restored.transcript.items.find((item) => item.kind === "shell")
      expect(shell).toMatchObject({ output: "github.com:\n  oauth_token: [REDACTED]\n" })
      expect(restored.entries).toContainEqual({ kind: "exchange", user: "why does auth fail", answer: "Your token [REDACTED] is expired." })
    })
  }

  it("a fork of a session saved before redaction copies no credential either", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-cwd-"))
    const source = join(mkdtempSync(join(tmpdir(), "tui-old-")), "old.jsonl")
    writeFileSync(source, [...records, { type: "user", at: 7, text: "next" }].map((record) => JSON.stringify(record)).join("\n") + "\n")
    const [turn] = Session.turns(Session.load(source))
    const forked = Session.fork(source, cwd, turn!)
    if (forked._tag !== "Forked") throw new Error(forked._tag)
    const saved = readFileSync(forked.writer.file, "utf8")
    for (const secret of [key, pat]) expect(saved).not.toContain(secret)
  })

  it("keeps the bytes the TUI re-executes: a patch undo applies, a flow input and a worker prompt retry relaunches, a monitor's source", () => {
    const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")))
    const patch: Session.Record = {
      type: "patch",
      receipt: { call: "[]", patches: [{ path: ".env", patch: `-ANTHROPIC_API_KEY=${key}\n+ANTHROPIC_API_KEY=rotated\n` }] }
    }
    const flow: Extract<Session.Record, { type: "flow" }> = {
      type: "flow",
      run: {
        id: "r",
        flow: "deploy",
        by: "user",
        input: { token: pat, message: pat },
        requested: JSON.stringify({ token: pat }),
        status: "failed",
        startedAt: 1,
        message: `401 for ${pat}`
      }
    }
    const tab: Extract<Session.Record, { type: "tab" }> = {
      type: "tab",
      tab: { id: "t", title: "Rotate", prompt: `rotate ${pat}`, seat: "s", file: "/w.jsonl", depth: 1, status: "done", startedAt: 1, answer: `new token ${pat}` }
    }
    const monitor: Extract<Session.Record, { type: "monitor" }> = {
      type: "monitor",
      monitor: {
        id: "m",
        title: "Token",
        watch: "the token changes",
        source: { kind: "shell", command: `curl -H 'Authorization: Bearer ${pat}' https://example.com` },
        trigger: { kind: "interval", seconds: 60 },
        status: "active",
        seen: `token=${pat}`,
        updates: 0,
        createdAt: 1
      }
    }
    for (const record of [patch, flow, tab, monitor]) writer.append(record)
    expect(Session.load(writer.file).slice(1)).toEqual([
      patch,
      { ...flow, run: { ...flow.run, message: "401 for [REDACTED]" } },
      { ...tab, tab: { ...tab.tab, answer: "new token [REDACTED]" } },
      { ...monitor, monitor: { ...monitor.monitor, seen: "token=[REDACTED]" } }
    ])
  })
})

const plan = { id: "release", title: "Release plan", summary: "Two steps left.", rows: [] }

it("restores cards in place, runtime status and keys, and a worker's card placement", () => {
  const records: Session.Record[] = [
    { type: "user", at: 1, text: "Plan the release" },
    { type: "card", at: 2, panel: plan },
    { type: "contribution", owner: "runtime:chat", contribution: { kind: "status", status: { id: "ci", text: "CI ◌" } } },
    { type: "card", at: 3, panel: { ...plan, summary: "One step left." } },
    { type: "contribution", owner: "runtime:chat", contribution: { kind: "status", status: { id: "ci", text: "CI ✓" } } },
    {
      type: "contribution",
      owner: "runtime:fix",
      contribution: { kind: "key", key: { id: "fix/rerun", key: "alt+c", label: "Rerun", action: { kind: "prompt", prompt: "Rerun" } } }
    },
    { type: "panel", panel: { ...plan, id: "fix/plan" }, placement: "card" }
  ]
  const restored = Session.restore(records)
  const cards = restored.transcript.items.filter((item) => item.kind === "card")
  expect(cards).toHaveLength(1)
  expect(cards[0]).toMatchObject({ panel: { summary: "One step left." } })
  expect(restored.workspace.panels.map((panel) => panel.id)).toEqual(["release", "fix/plan"])
  expect(restored.workspace.cards).toEqual(["release", "fix/plan"])
  expect(restored.contributions).toEqual([
    { owner: "runtime:chat", contribution: { kind: "status", status: { id: "ci", text: "CI ✓" } } },
    { owner: "runtime:fix", contribution: (records[5] as Extract<Session.Record, { type: "contribution" }>).contribution }
  ])
})
