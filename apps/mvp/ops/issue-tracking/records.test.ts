// The issue-tracking import's pure parts (ops/issue-tracking/records.mjs), on synthetic input only.
import * as fc from "fast-check"
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { inboxEntries, interleave, recordsOf, scrub, scrubRecord } from "./records.mjs"

describe("the issue-tracking import", () => {
  test("scrubs credential-shaped text and shortens home paths, keeping commit ids", () => {
    const text = [
      "token: abcdefghijklmnopqrstuvwxyz123456",
      "ghp_0123456789abcdefABCDEF0123",
      "see /Users/someone/lanes/x and /home/lane/vibe/mq",
      "rev 5e0fdb74d901 and 3772815ae701845ce93f4a5ae33d71c238c19e8b",
    ].join("\n")
    const out = scrub(text)
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123456")
    expect(out).not.toContain("ghp_0123456789")
    expect(out).toContain("~/lanes/x and ~/vibe/mq")
    expect(out).toContain("5e0fdb74d901")
    expect(out).toContain("3772815ae701845ce93f4a5ae33d71c238c19e8b")
  })

  test.each([
    "A".repeat(43),
    Buffer.alloc(32, 255).toString("base64url"),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url"),
  ])("redacts a complete machine token with payload %s", (payload) => {
    const token = `smm_${payload}`
    for (const wrap of [token, `Use ${token}.`, `_${token}_`, `(${token})`, `https://example.test/${token}`]) {
      expect(scrub(wrap)).not.toContain(token)
      expect(scrub(wrap)).toContain("[redacted]")
    }
    expect(scrub(`${token} and ${token}`)).toBe("[redacted] and [redacted]")
    expect(scrub("smm_documentation")).toBe("smm_documentation")
  })

  test("screens every collected field, including record keys and work links", () => {
    const token = `smm_${"A".repeat(43)}`
    const rows = recordsOf({
      inbox: `[${token}] Use ${token}`,
      remote: [
        { kind: "lane", name: token, prompt: `# Use ${token}`, started: 1 },
        { kind: "review", lane: token, report: `# Check ${token}`, at: 2 },
        { kind: "queue", entry: { id: token, lane: token, rev: token, state: "landed", reason: token } },
      ],
    })
    const serialized = JSON.stringify(interleave(rows, 5))
    expect(serialized).not.toContain(token)
    expect(rows).toHaveLength(4)
    expect(rows[1].key).toMatch(/^redacted:[a-f0-9]{64}$/)
    expect(rows[1].links[0]).toEqual({ kind: "assignee", ref: "[redacted]", label: "[redacted]" })
    expect(rows[3].links[0].state).toBe("passed")
    for (const row of rows) {
      expect(row.title).toContain("[redacted]")
      expect(row.body).toContain("[redacted]")
    }
  })

  test("rescreens saved records without mutating them or changing non-text fields", () => {
    const token = `smm_${"A".repeat(43)}`
    const saved = { key: `lane:${token}`, title: token, body: `Use ${token}`, links: [{ ref: token, label: token }], count: 1, active: true, missing: null }
    const screened = scrubRecord(saved)
    expect(screened).toEqual({ key: expect.stringMatching(/^redacted:[a-f0-9]{64}$/), title: "[redacted]", body: "Use [redacted]", links: [{ ref: "[redacted]", label: "[redacted]" }], count: 1, active: true, missing: null })
    expect(saved.title).toBe(token)
    expect(scrubRecord(screened)).toEqual(screened)
  })

  test("keeps redacted identities distinct and recognizes previously saved state keys", () => {
    const keys = ["lane:fix-machine-token-collection-redaction-5256", "lane:fix-machine-token-collection-redaction-5257", `lane:smm_${"A".repeat(43)}`]
    const records = keys.map((key) => scrubRecord({ key, title: "Work" }))
    expect(new Set(records.map((record) => record.key)).size).toBe(keys.length)
    for (const key of keys) {
      // Seed screens both older records and its saved sent-state entries before comparing their keys.
      const record = scrubRecord(JSON.parse(JSON.stringify({ key, title: "Work" })))
      const state = scrubRecord(JSON.parse(JSON.stringify({ key, writeId: "sent", status: 202 })))
      expect(state.key).toBe(record.key)
      expect(scrubRecord(record)).toEqual(record)
    }
    expect(scrubRecord({ title: "No key" })).toEqual({ title: "No key" })
  })

  test("screens tokens from any 32-byte base64url payload throughout records", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
      const token = `smm_${Buffer.from(bytes).toString("base64url")}`
      const saved = { key: `lane:${token}`, title: `Use ${token}`, body: `_${token}_`, links: [{ ref: token, label: token }] }
      const screened = scrubRecord(saved)
      expect(JSON.stringify(screened)).not.toContain(token)
      expect(screened.title).toBe("Use [redacted]")
      expect(scrubRecord(screened)).toEqual(screened)
    }), { numRuns: 500, seed: 5256 })
  })

  test("splits the inbox into entries and makes one record per entry, lane, review and queue entry, with their links", () => {
    expect(inboxEntries("# head\n[platform] one\nmore\n- 2026-11-02T02:55Z [spec] two\n")).toEqual(["[platform] one\nmore", "- 2026-11-02T02:55Z [spec] two"])
    const rows = recordsOf({
      inbox: "[platform] fixed the box\n",
      remote: [
        { kind: "lane", name: "fix-1", prompt: "# Lane fix-1: fix it\nbody", started: 1, exited: 2, exit: null },
        { kind: "review", lane: "fix-1", report: "# fix-1 review\nok", at: 3 },
        { kind: "queue", entry: { id: "q-1", rev: "abc123", lane: "fix-1", commits: "1", at: "t", state: "landed", reason: null } },
      ],
    })
    expect(rows.map((row: { key: string }) => row.key)).toEqual(["inbox:1", "lane:fix-1", "review:fix-1", "queue:q-1"])
    expect(rows[1].title).toBe("Lane fix-1: fix it")
    expect(rows[1].links.map((link: { kind: string; state?: string }) => `${link.kind}:${link.state ?? ""}`))
      .toEqual(["assignee:", "session:done", "queue:passed", "merge:merged"])
    expect(rows[0].links).toEqual([{ kind: "assignee", ref: "platform", label: "platform" }])
  })

  test("interleaves kinds so any prefix holds each, then fills with records that say they are synthetic", () => {
    const rows = interleave([{ kind: "a", key: "a1" }, { kind: "a", key: "a2" }, { kind: "b", key: "b1" }], 5)
    expect(rows.map((row: { key: string }) => row.key)).toEqual(["a1", "b1", "a2", "synthetic:1", "synthetic:2"])
    expect(rows[3].body).toContain("Synthetic")
  })
})
