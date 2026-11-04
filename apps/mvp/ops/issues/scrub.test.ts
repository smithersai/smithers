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

  test("keeps repository-relative paths and name@version files, while absolute paths and emails beside them go", () => {
    for (const kept of ["packages/website/src/page/home/notePlayerDemo.ts", "patches/knip@6.38.0.patch", "src/Users/list.ts", "pkg@1.2.3", "@alchemy.run/aws"]) {
      expect(clean(kept)).toMatchObject({ ok: true, text: kept, rules: [] })
      expect(clean(kept, { kind: "exact" })).toMatchObject({ ok: true })
    }
    const out = clean("packages/website/src/page/home/notePlayerDemo.ts from /home/lane/x, patches/knip@6.38.0.patch, mail ops@example.com")
    expect(out.text).toBe("packages/website/src/page/home/notePlayerDemo.ts from [path], patches/knip@6.38.0.patch, mail [email]")
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

  test("a machine token never posts: a canonical one is named, refused, and gone from the text", () => {
    const token = `smm_${Buffer.alloc(32, 7).toString("base64url")}`
    for (const value of [token, `leaked ${token} here`, `smm_a-b_c-d_e-f_g-h-${"x".repeat(8)}`]) {
      const out = clean(value)
      expect(out.ok).toBe(false)
      expect(out.refused).toContain("machine-token")
      expect(out.text).not.toContain("smm_")
    }
    expect(clean("smm_ is the prefix")).toMatchObject({ ok: true })
  })

  test("a machine token behind Markdown, encoded in a URL, as entities or in other case is still refused", () => {
    const rest = "a".repeat(43)
    for (const value of [`_smm_${rest}_`, `*smm_${rest}*`, `xsmm_${rest}`, `SMM_${rest}`, `https://x.test/?a=%73mm%5f${rest}`, `https://x.test/?a=%2573mm%255f${rest}`, `&#115;mm_${rest}`, `&#x73;mm_${rest}`]) {
      expect(clean(value).ok, value).toBe(false)
      expect(clean(value).refused, value).toContain("machine-token")
    }
    expect(clean(`https://x.test/?a=%67hp_0123456789abcdefABCDEF0123`).refused).toContain("credential")
    expect(clean("100%25 of the smm_ prefix")).toMatchObject({ ok: true })
  })

  test("a credential or home path written plainly, encoded or escaped is refused; Markdown and HTML are not", () => {
    const tail = "a".repeat(43)
    for (const text of [`smm\\_${tail}`, `smm\\_\\-${tail}`, "see %2FUsers%2Fsomeone%2Fx", "&#47;home&#47;someone&#47;x",
      `%65yJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`]) {
      expect(clean(text).ok, text).toBe(false)
    }
    for (const text of ["\\/Users\\/someone/private.txt", "~\\/notes", "x\\~%2fnotes", "password&#58; abcdefghijklmnop", "&#126;/confidential/notes",
      "%24HOME/confidential/notes", "&#36;HOME/private.txt", "%7E%2Flane%2Fprivate.txt", "xsk-abcdefghijklmnop x%73k-abcdefghijklmnop",
      `&#00000000115;mm_${tail}`, `&#x0000000073;mm_${tail}`,
      // Invisible characters show nothing, so the page shows the credential or path whole: written or encoded.
      `smm_\u2060${tail}`, `s\u00admm_${tail}`, `smm_&#8288;${tail}`, "/Us\u2060ers/alice/private.txt", "~\u200b/notes"]) {
      expect(clean(text).ok, text).toBe(false)
    }
    // A file URL names a home path on any host, whatever the scheme's case.
    for (const text of ["file:///Users/alice/private.txt", "file://localhost/home/alice/x", "FILE://build-host/home/alice/x"]) {
      expect(clean(text).text, text).not.toMatch(/\/(?:Users|home)\/alice/)
    }
    // A route is not a home path: `/users/` in lower case stays.
    expect(clean("GET /users/me returns the caller").text).toBe("GET /users/me returns the caller")
    // A home path beside emphasis marks is redacted like any other.
    expect(clean("_/Users/someone/private.txt_").text).not.toContain("/Users/")
    // The server files a body escaped, so Markdown and HTML show as written and never join into a token: these pass.
    for (const text of [`**smm**_${tail}`, `smm_**${tail}**`, `sm**m**_${tail}`, `smm<!--x-->_${tail}`, `<div>smm&lowbar;aaaaaaaaaaaaaaaa</div>`, "<b>bold</b>", "We use **token** initialization."]) {
      expect(clean(text).ok, text).toBe(true)
    }
    for (const text of ["100%25 of the smm_ prefix, _emphasis_ and repo/path.ts", "token_initialization and token*initialization", "packages/foo_/home/x.ts", "R&D and A & B"]) {
      expect(clean(text).ok, text).toBe(true)
    }
  })

  test("reads any body in linear time: patterns start once per run", () => {
    const started = performance.now()
    for (const text of ["a".repeat(65_000), "eyJ".repeat(21_666), "%25".repeat(21_666), "-a".repeat(32_500), "a.".repeat(32_500), "nyc-".repeat(16_000), "\\_".repeat(32_500), `x@${"a".repeat(64_000)}`, "eyJ-".repeat(16_250)]) clean(text)
    expect(performance.now() - started).toBeLessThan(2_000)
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

describe("the importer's confirmed-repository policy", () => {
  test("denies an unconfirmed reference beside Markdown underscore punctuation", () => {
    const result = clean("See _outside/hidden_ here.", { repositoryVerdicts: new Map() })
    expect(result.text).not.toContain("outside/hidden")
    expect(result.rules).toContain("private-repo")
  })
})


describe("strict repository redaction ordering", () => {
  test.each(["nyc-01/secret-vault", "mini/secret-vault", "https://github.com/nyc-01/secret-vault"])("does not leave a private basename after another rule masks its owner: %s", (text) => {
    const result = clean(text, { repositoryVerdicts: new Map() })
    expect(result.ok).toBe(true)
    expect(result.text).toBe("[repo]")
  })
})
