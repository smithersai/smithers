// The public-content scrub (ops/issues/scrub.mjs), on synthetic text only.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { clean, cleanRecord } from "./scrub.mjs"

describe("the public-content scrub", () => {
  test("redacts home and internal paths, hosts, accounts, emails and credentials in a body", () => {
    const text = [
      "repro in /Users/someone/work/x and /home/lane/vibe/mq and ~/lanes/fix.REPORT.md and /tmp/run-1/log",
      "ran on nyc-07, onnyc02, build.local, 10.1.2.3, the Mac mini and latitude",
      "as claude-9 and codex-3, mail me at person@example.org",
      "token: abcdefghijklmnopqrstuvwxyz123456 and ghp_0123456789abcdefABCDEF0123",
      "https://user:pa55word@example.test/x?token=zzz",
    ].join("\n")
    const out = clean(text)
    expect(out.ok).toBe(true)
    for (const gone of ["/Users/", "/home/", "~/lanes", "/tmp/", "nyc-07", "nyc02", "build.local", "10.1.2.3", "mini", "latitude", "claude-9", "codex-3", "person@", "abcdefghijklmnop", "ghp_", "pa55word", "zzz"]) {
      expect(out.text).not.toContain(gone)
    }
    expect(out.rules).toEqual(expect.arrayContaining(["home-path", "system-path", "host", "account", "email", "credential", "url-credentials", "query-secret"]))
  })

  test("keeps commit ids, repository paths, spec ids and long hyphenated names", () => {
    const text = "rev 5e0fdb74d901, docs/design/vips/0003-effect-type-shorthand.md:49, r2 OPUS-2 / ASTRA-2, source5-currentSDK-declaration-preflight-3, smithersai/vibelang"
    expect(clean(text)).toMatchObject({ ok: true, text, rules: [] })
  })

  test("redacts a private repository, qualified always and bare when distinctive, from names it is given", () => {
    const out = clean("see smithersai/Secret-Vault, Secret-Vault itself, smithersai/ui, and smithersai/smithers", { privateRepos: ["Secret-Vault", "ui"] })
    expect(out.text).toBe("see [repo], [repo] itself, [repo], and smithersai/smithers")
    expect(out.ok).toBe(true)
  })

  test("fails closed: a title, label or ref must already be clean, and a private key never posts", () => {
    expect(clean("lint panics on nyc-07", { kind: "exact" })).toMatchObject({ ok: false, refused: ["host"] })
    expect(clean("lint panics on save", { kind: "exact" })).toMatchObject({ ok: true })
    expect(clean("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toMatchObject({ ok: false, refused: ["private-key"] })
  })

  test("cleans every field of a record and names each field that failed, never its text", () => {
    const result = cleanRecord({
      title: "Merge queue: fix-1 is queued",
      body: "on nyc-07",
      labels: ["queue", "claude-9"],
      links: [{ kind: "session", ref: "lane:fix-1", label: "lane fix-1" }, { kind: "review", ref: "/home/lane/x" }],
    })
    expect(result.ok).toBe(false)
    expect(result.record.body).toBe("on [host]")
    expect(result.problems).toEqual([
      { field: "labels[1]", rules: ["account"] },
      { field: "links[1].ref", rules: ["home-path"] },
    ])
    expect(JSON.stringify(result.problems)).not.toContain("claude-9")
  })
})
