// The issue-tracking import's pure parts (ops/issue-tracking/records.mjs), on synthetic input only.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { inboxEntries, interleave, recordsOf, scrub } from "./records.mjs"

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
