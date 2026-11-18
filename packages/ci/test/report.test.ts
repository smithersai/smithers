import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type ReplayCommit, ReplayReport } from "../src/contract/ReplayReport.ts"
import { bar, duration, speedup, times } from "../src/report/Format.ts"
import { html, text } from "../src/report/index.ts"

const example: ReplayReport = Schema.decodeUnknownSync(ReplayReport)(
  JSON.parse(readFileSync(new URL("./fixtures/replay-report.example.json", import.meta.url), "utf8"))
)

const [green, red] = example.commits as [ReplayCommit, ReplayCommit]

/** The example with every mismatch removed: fast mode caught the failure. */
const clean: ReplayReport = {
  ...example,
  commits: [green, { ...red, mismatches: [] }],
  mismatches: 0,
  selection: {
    rows: 12,
    selected: 6,
    failures: 1,
    failedChanges: 1,
    selectionRate: 0.5,
    testRecall: 1,
    changeRecall: 1
  }
}

/** No fast mode at all. */
const normalOnly = (): ReplayReport => {
  const { fast: _fast, ...first } = green
  return {
    version: 1,
    repository: "refcell/needlefish",
    commits: [{ ...first, commit: "a1b2c3d4e5f6" }],
    baselineWallMs: 1_320_000,
    normalWallMs: 240_000,
    speedup: 5.5,
    mismatches: 0
  }
}

/** The page after its stylesheet. */
const body = (page: string): string => page.slice(page.indexOf("<body>"))

const empty: ReplayReport = {
  version: 1,
  repository: "elizaOS/eliza",
  commits: [],
  baselineWallMs: 0,
  normalWallMs: 0,
  speedup: 0,
  mismatches: 0
}

/** Every string a repository controls carries HTML and terminal control characters. */
const hostile: ReplayReport = {
  ...example,
  repository: "<script>alert(\"x\")</script>&'repo'",
  commits: [
    green,
    {
      ...red,
      commit: "<b>c0ffee</b>",
      mismatches: [{
        label: "//<img src=x onerror=alert(1)>:test\u001b[31m",
        mode: "fast",
        baseline: "fail",
        got: "skipped"
      }]
    }
  ]
}

describe("text", () => {
  it("leads with the mismatch, then the speedup, the bars, the counts and every mismatch", () => {
    expect(text(example)).toBe([
      "✗ 1 mismatch",
      "",
      "6.0× faster",
      "",
      "baseline  ████████████████████████  43m 40s",
      "normal    ████                       7m 20s   6.0×",
      "fast      █▍                         2m 30s  17.5×",
      "",
      "2 commits · 1 mismatch",
      "",
      "commit   files  baseline      normal       fast",
      "0000000      3  pass 22m 00s  pass 4m 00s  pass 1m 30s",
      "0000000      1  fail 21m 40s  fail 3m 20s  pass 1m 00s",
      "",
      "0000000  fast    //packages/core:test  fail → skipped"
    ].join("\n"))
  })

  it("says for each commit whether the CI passed or failed, in the baseline and in each mode", () => {
    // Review finding 24: a replay whose baseline failed at every commit printed the same block as a passing one.
    const failing = {
      ...normalOnly(),
      commits: [1, 22].map((changedFiles) => ({
        ...normalOnly().commits[0]!,
        changedFiles,
        baseline: { ...green.baseline, ok: false },
        normal: { ...green.normal, ok: false }
      }))
    }
    expect(text(failing).split("\n").slice(-3)).toEqual([
      "commit   files  baseline      normal",
      "a1b2c3d      1  fail 22m 00s  fail 4m 00s",
      "a1b2c3d     22  fail 22m 00s  fail 4m 00s"
    ])
    expect(text(normalOnly()).split("\n").at(-1)).toBe("a1b2c3d      3  pass 22m 00s  pass 4m 00s")
    // A commit fast mode did not run has an empty cell.
    const { fast: _fast, ...plain } = red
    expect(text({ ...clean, commits: [green, { ...plain, mismatches: [] }] }).split("\n").at(-1)).toBe(
      "0000000      1  fail 21m 40s  fail 3m 20s"
    )
  })

  it("leads with the speedup when nothing mismatched", () => {
    const lines = text(clean).split("\n")
    expect(lines[0]).toBe("6.0× faster")
    expect(lines).toContain("2 commits · 0 mismatches")
    expect(text(clean)).not.toContain("✗")
  })

  it("draws no fast bar without fast mode", () => {
    expect(text(normalOnly())).toBe([
      "5.5× faster",
      "",
      "baseline  ████████████████████████  22m 00s",
      "normal    ████▍                      4m 00s  5.5×",
      "",
      "1 commit · 0 mismatches",
      "",
      "commit   files  baseline      normal",
      "a1b2c3d      3  pass 22m 00s  pass 4m 00s"
    ].join("\n"))
  })

  it("says only that nothing was replayed for zero commits", () => {
    expect(text(empty)).toBe("0 commits")
  })

  it("never hides a mismatch the report counts", () => {
    expect(text({ ...empty, mismatches: 2 })).toBe("✗ 2 mismatches\n\n0 commits")
    expect(text({ ...clean, mismatches: 1 }).split("\n")[0]).toBe("✗ 1 mismatch")
  })

  it("lists every mismatch, one line each", () => {
    const twice = {
      ...example,
      mismatches: 2,
      commits: [green, { ...red, mismatches: [...red.mismatches, ...red.mismatches] }]
    }
    const lines = text(twice).split("\n")
    expect(lines[0]).toBe("✗ 2 mismatches")
    expect(lines.filter((line) => line.includes("//packages/core:test"))).toHaveLength(2)
  })

  it("says slower when normal mode took longer than the baseline", () => {
    const slow = { ...normalOnly(), normalWallMs: 1_650_000, speedup: 0.8 }
    expect(text(slow).split("\n")[0]).toBe("1.3× slower")
    // Much slower: the row's ratio agrees with the headline; it read `0.0×` under "26.1× slower".
    const slower = { ...normalOnly(), baselineWallMs: 1000, normalWallMs: 26_100, speedup: 1000 / 26_100 }
    expect(text(slower).split("\n").slice(0, 4)).toEqual([
      "26.1× slower",
      "",
      "baseline  ▉                          1.0s",
      "normal    ████████████████████████  26.1s  0.038×"
    ])
  })

  it("omits fast mode's ratio when fast mode took no time", () => {
    const instant = { ...example, fastWallMs: 0 }
    expect(text(instant).split("\n").find((line) => line.startsWith("fast"))).toBe(
      "fast                                    0ms"
    )
  })

  it("replaces terminal control characters in labels and commit ids", () => {
    const output = text({ ...hostile, commits: [{ ...hostile.commits[1]!, commit: "\u001b]0;x\u0007" }] })
    expect(output).not.toMatch(/\p{Cc}(?<!\n)/u)
    expect(output).toContain("//<img src=x onerror=alert(1)>:test�[31m")
    expect(output).toContain("�]0;x�")
  })
})

describe("a repository's own targets", () => {
  const own = (targets: ReadonlyArray<string>): ReplayReport => ({ ...normalOnly(), targets })

  it("stand above the speedup in the text and in the page", () => {
    const lines = text(own(["//packages/ci/..."])).split("\n")
    expect(lines[0]).toBe("own targets  //packages/ci/...")
    expect(lines[2]).toBe("5.5× faster")
    const page = html(own(["//packages/ci/..."]))
    expect(page).toContain("<p class=\"summary\"><code>own targets  //packages/ci/...</code></p>")
    expect(page.indexOf("own targets")).toBeLessThan(page.indexOf("class=\"hero\""))
  })

  it("names the first three patterns and counts the rest", () => {
    const many = ["//a:*", "//b:*", "//c:*", "//d:*", "//e:*"]
    expect(text(own(many)).split("\n")[0]).toBe("own targets  //a:* //b:* //c:* +2")
    expect(text(own(many.slice(0, 3))).split("\n")[0]).toBe("own targets  //a:* //b:* //c:*")
  })

  it("are escaped in the page and cleaned for a terminal", () => {
    expect(html(own(["//<b>:x"]))).toContain("own targets  //&lt;b&gt;:x")
    expect(text(own(["//a\u001b[2J:x"])).split("\n")[0]).toBe("own targets  //a\uFFFD[2J:x")
  })

  it("are not shown for a repository whose CI was converted", () => {
    expect(text(normalOnly())).not.toContain("own targets")
    expect(html(normalOnly())).not.toContain("own targets")
  })
})

describe("jobs that were not replayed", () => {
  const partial: ReplayReport = {
    ...clean,
    notReplayed: [
      {
        job: "ci.yml:handoff",
        reasons: [
          { feature: "secret-env", detail: "sets GH_TOKEN from a secret" },
          { feature: "condition", detail: "runs only on main" },
          { feature: "secret-env", detail: "sets NPM_TOKEN from a secret" }
        ]
      },
      { job: "ci.yml:<e2e>\u001b[2J", reasons: [{ feature: "needs", detail: "needs ci.yml:handoff" }] },
      { job: "ci.yml:plain", reasons: [] }
    ]
  }

  it("counts them beside the commits and lists each with its reasons, in the terminal", () => {
    const lines = text(partial).split("\n")
    expect(lines).toContain("2 commits · 0 mismatches · 3 jobs not replayed")
    expect(lines.slice(-3)).toEqual([
      "ci.yml:handoff    secret-env, condition",
      "ci.yml:<e2e>\uFFFD[2J  needs",
      "ci.yml:plain"
    ])
    expect(text({ ...partial, notReplayed: [partial.notReplayed![2]!] })).toContain("· 1 job not replayed")
  })

  it("does the same on the page, escaped", () => {
    const page = html(partial)
    expect(page).toContain("<p class=\"summary\">2 commits · 0 mismatches · 3 jobs not replayed</p>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code>ci.yml:handoff</code></th><td class=\"sub\">secret-env, condition</td></tr>"
    )
    expect(page).toContain("<code>ci.yml:&lt;e2e&gt;")
    expect(page.indexOf("<h2>Not replayed</h2>")).toBeGreaterThan(page.indexOf("<h2>Commits</h2>"))
  })

  it("says nothing when every job was replayed", () => {
    for (const report of [clean, { ...clean, notReplayed: [] }]) {
      expect(text(report)).not.toContain("not replayed")
      expect(html(report)).not.toContain("Not replayed")
      expect(text(report).split("\n")).toContain("2 commits · 0 mismatches")
    }
  })
})

describe("flaky verdicts and what was not read", () => {
  it("counts flaky verdicts beside the mismatches, never among them", () => {
    expect(text({ ...clean, flaky: 2 }).split("\n")).toContain("2 commits · 0 mismatches · 2 flaky")
    expect(text({ ...clean, flaky: 2 })).not.toContain("✗")
    expect(html({ ...clean, flaky: 2 })).toContain("<p class=\"summary\">2 commits · 0 mismatches · 2 flaky</p>")
    expect(html({ ...clean, flaky: 2 })).not.toContain("role=\"alert\"")
    for (const report of [clean, { ...clean, flaky: 0 }]) {
      expect(text(report)).not.toContain("flaky")
      expect(html(report)).not.toContain("flaky")
    }
  })

  const unread: ReplayReport = {
    ...clean,
    flaky: 1,
    notReplayed: [{ job: "ci.yml:package", reasons: [{ feature: "no-command", detail: "it has no command" }] }],
    notRead: [
      { feature: "malformed-file", detail: ".github/workflows/<tests>.yml: BAD_INDENT at line 3\u001b[2J" },
      { feature: "package-turbo", detail: "" }
    ]
  }

  it("lists what the inventory could not read under the jobs not replayed, in the terminal", () => {
    expect(text(unread).split("\n")).toContain("2 commits · 0 mismatches · 1 flaky · 1 job not replayed · 2 not read")
    expect(text(unread).split("\n").slice(-5)).toEqual([
      "ci.yml:package  no-command",
      "",
      "not read",
      "malformed-file  .github/workflows/<tests>.yml: BAD_INDENT at line 3\uFFFD[2J",
      "package-turbo"
    ])
  })

  it("does the same on the page, escaped", () => {
    const page = html(unread)
    expect(page).toContain(
      "<p class=\"summary\">2 commits · 0 mismatches · 1 flaky · 1 job not replayed · 2 not read</p>"
    )
    expect(page).toContain(
      "<tr><th scope=\"row\"><code>malformed-file</code></th><td class=\"sub\">.github/workflows/&lt;tests&gt;.yml: BAD_INDENT at line 3\u001b[2J</td></tr>"
    )
    expect(page.indexOf("<h2>Not read</h2>")).toBeGreaterThan(page.indexOf("<h2>Not replayed</h2>"))
  })

  it("lists the commits whose own CI could not be replayed, with the first line of the reason", () => {
    const older: ReplayReport = {
      ...clean,
      notReplayedCommits: [
        {
          commit: "0123456789abcdef",
          reason: "0 of 1 CI job can be reproduced on this machine\n  ci.yml:<deploy>  secret"
        },
        { commit: "fedcba9876543210", reason: "" }
      ]
    }
    const lines = text(older).split("\n")
    expect(lines).toContain("2 commits · 0 mismatches · 2 commits not replayed")
    expect(lines.slice(-3)).toEqual([
      "commits not replayed",
      "0123456  0 of 1 CI job can be reproduced on this machine",
      "fedcba9"
    ])
    const page = html(older)
    expect(page).toContain("<p class=\"summary\">2 commits · 0 mismatches · 2 commits not replayed</p>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code title=\"0123456789abcdef\">0123456</code></th><td class=\"sub\">0 of 1 CI job can be reproduced on this machine</td></tr>"
    )
    expect(text({ ...older, notReplayedCommits: [older.notReplayedCommits![1]!] })).toContain("· 1 commit not replayed")
    for (const report of [clean, { ...clean, notReplayedCommits: [] }]) {
      expect(text(report)).not.toContain("not replayed")
      expect(html(report)).not.toContain("not replayed")
    }
  })

  it("lists each tool this machine has at another version than a job asks for, with both versions", () => {
    const versions: ReplayReport = {
      ...clean,
      toolVersions: [
        { job: "tests.yml:test", tool: "node", asked: "22.x", found: "26.5.0" },
        { job: "ci.yml:<lint>", tool: "go", asked: "1.23", found: "1.25.4\u001b[2J" }
      ]
    }
    expect(text(versions).split("\n").slice(-3)).toEqual([
      "tool versions",
      "tests.yml:test  asks for node 22.x; this machine has node 26.5.0",
      "ci.yml:<lint>   asks for go 1.23; this machine has go 1.25.4\uFFFD[2J"
    ])
    const page = html(versions)
    expect(page).toContain("<h2>Tool versions</h2>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code>ci.yml:&lt;lint&gt;</code></th><td class=\"sub\">asks for go 1.23; this machine has go 1.25.4\u001b[2J</td></tr>"
    )
    for (const report of [clean, { ...clean, toolVersions: [] }]) {
      expect(text(report)).not.toContain("tool versions")
      expect(html(report)).not.toContain("Tool versions")
    }
  })

  it("says which cache credentials were left empty, and that the baseline ran without that cache", () => {
    const two: ReplayReport = { ...clean, withheld: ["TURBO_TEAM", "TURBO_TOKEN"] }
    expect(text(two).split("\n").at(-1)).toBe(
      "TURBO_TEAM, TURBO_TOKEN left empty: the baseline ran without the remote cache they open"
    )
    expect(html(two)).toContain(
      "<p class=\"summary\">TURBO_TEAM, TURBO_TOKEN left empty: the baseline ran without the remote cache they open</p>"
    )
    const one: ReplayReport = { ...clean, withheld: ["NX_CLOUD_<ACCESS>\u001b[2J"] }
    expect(text(one).split("\n").at(-1)).toBe(
      "NX_CLOUD_<ACCESS>\uFFFD[2J left empty: the baseline ran without the remote cache it opens"
    )
    expect(html(one)).toContain("NX_CLOUD_&lt;ACCESS&gt;")
    for (const report of [clean, { ...clean, withheld: [] }]) {
      expect(text(report)).not.toContain("left empty")
      expect(html(report)).not.toContain("left empty")
    }
  })

  it("names the tool to install beside a job that was left out for it", () => {
    const missing: ReplayReport = {
      ...clean,
      notReplayed: [{
        job: "linux.yml:build",
        reasons: [
          { feature: "missing-tool", detail: "go 1.23" },
          { feature: "missing-tool", detail: "ruby 3.4.6" },
          { feature: "needs", detail: "it needs a job that is not replayed" }
        ]
      }]
    }
    expect(text(missing).split("\n").at(-1)).toBe("linux.yml:build  missing-tool (go 1.23, ruby 3.4.6), needs")
    expect(html(missing)).toContain("<td class=\"sub\">missing-tool (go 1.23, ruby 3.4.6), needs</td>")
  })

  it("says nothing when everything was read", () => {
    for (const report of [clean, { ...clean, notRead: [] }]) {
      expect(text(report)).not.toContain("not read")
      expect(html(report)).not.toContain("Not read")
    }
  })
})

describe("html", () => {
  it("holds the same facts as the text", () => {
    const page = html(example)
    expect(page).toMatch(/^<!doctype html>/)
    expect(page).toContain("<title>example/bun-turbo-monorepo · Smithers CI</title>")
    expect(page).toContain("<p class=\"alert\" role=\"alert\">1 mismatch</p>")
    expect(page).toContain("<p class=\"hero\">6.0× faster</p>")
    expect(page).toContain("aria-label=\"baseline 43m 40s, normal 7m 20s, fast 2m 30s\"")
    expect(page).toContain("<p class=\"summary\">2 commits · 1 mismatch</p>")
    expect(page.indexOf("role=\"alert\"")).toBeLessThan(page.indexOf("class=\"hero\""))
  })

  it("draws each bar as a share of the longest time", () => {
    const widths = [...html(example).matchAll(/class="fill (\w+)" style="width:([\d.]+)%"/g)].map((m) => [m[1], m[2]])
    expect(widths).toEqual([["baseline", "100.00"], ["normal", "16.79"], ["fast", "5.73"]])
  })

  it("shows fast mode's recall and selection rate with the counts behind them", () => {
    const page = html(example)
    expect(page).toContain(
      "<th scope=\"row\">test recall</th><td class=\"num\">0%</td><td class=\"num sub\">0 of 1 failure</td>"
    )
    expect(page).toContain(
      "<th scope=\"row\">change recall</th><td class=\"num\">0%</td><td class=\"num sub\">0 of 1 failed change</td>"
    )
    expect(page).toContain(
      "<th scope=\"row\">selection rate</th><td class=\"num\">42%</td><td class=\"num sub\">5 of 12 targets</td>"
    )
    const caught = html({
      ...clean,
      selection: { ...clean.selection!, failures: 4, failedChanges: 2, testRecall: 0.75 }
    })
    expect(caught).toContain("<td class=\"num\">75%</td><td class=\"num sub\">3 of 4 failures</td>")
    expect(caught).toContain("<td class=\"num\">100%</td><td class=\"num sub\">2 of 2 failed changes</td>")
  })

  it("leaves out recall when no row failed, since recall is not defined there", () => {
    const { testRecall: _t, changeRecall: _c, ...metrics } = example.selection!
    const page = html({ ...example, selection: { ...metrics, failures: 0, failedChanges: 0 } })
    expect(page).not.toContain("recall")
    expect(page).toContain("selection rate")
  })

  it("writes one row per commit with its three times, and its mismatches on a full-width row under it", () => {
    const tbody = html(example).match(/<tbody>\n([^]*?)\n<\/tbody>/)![1]!.split("\n")
    const time = (value: string) => `<td class="num">${value}</td>`
    const failed = (value: string) => time(`<span class="sub">fail</span> ${value}`)
    expect(tbody).toEqual([
      `<tr><td><code title="${green.commit}">0000000</code></td>${time("22m 00s")}${time("4m 00s")}${
        time("1m 30s")
      }</tr>`,
      // A run that failed says so beside its time.
      `<tr class="bad lead"><td><code title="${red.commit}">0000000</code></td>${failed("21m 40s")}${failed("3m 20s")}${
        time("1m 00s")
      }</tr>`,
      "<tr class=\"bad\"><td colspan=\"4\"><ul><li><code>//packages/core:test</code> <span class=\"sub\">fast: fail → skipped</span></li></ul></td></tr>"
    ])
    expect(html(example)).toContain(
      "<th>commit</th><th class=\"num\">baseline</th><th class=\"num\">normal</th><th class=\"num\">fast</th></tr>"
    )
  })

  it("spans a mismatch across the three columns of a report without fast mode", () => {
    const report = normalOnly()
    const mismatch = { label: "//build:test", mode: "normal", baseline: "fail", got: "pass" } as const
    const page = html({ ...report, mismatches: 1, commits: [{ ...report.commits[0]!, mismatches: [mismatch] }] })
    expect(page).toContain(
      "<td colspan=\"3\"><ul><li><code>//build:test</code> <span class=\"sub\">normal: fail → pass</span></li></ul></td>"
    )
  })

  it("leaves a commit's fast cell empty when only that commit lacks fast mode", () => {
    const { fast: _fast, ...plain } = red
    const page = html({ ...example, commits: [green, plain] })
    expect(page).toContain(
      "<span class=\"sub\">fail</span> 21m 40s</td><td class=\"num\"><span class=\"sub\">fail</span> 3m 20s</td><td class=\"num\"></td>"
    )
  })

  it("has no fast column, bar or section without fast mode", () => {
    const page = body(html(normalOnly()))
    expect(page).not.toMatch(/>fast<|fill fast|Fast mode/)
    expect(page).not.toContain("alert")
    expect(page).toContain("<p class=\"summary\">1 commit · 0 mismatches</p>")
  })

  it("says only that nothing was replayed for zero commits", () => {
    const page = body(html(empty))
    expect(page).toContain("<h1>elizaOS/eliza</h1>\n<p class=\"summary\">0 commits</p>\n</main>")
    expect(page).not.toContain("hero")
    expect(page).not.toContain("<table")
  })

  it("draws empty bars when every time is zero", () => {
    const page = html({ ...normalOnly(), baselineWallMs: 0, normalWallMs: 0 })
    expect(page).toContain("style=\"width:0.00%\"")
  })

  it("escapes the repository name, commit ids and labels", () => {
    const page = html(hostile)
    expect(page).toContain(
      "<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;repo&#39; · Smithers CI</title>"
    )
    expect(page).toContain("<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;repo&#39;</h1>")
    expect(page).toContain("<code title=\"&lt;b&gt;c0ffee&lt;/b&gt;\">&lt;b&gt;c0ff</code>")
    expect(page).toContain("<code>//&lt;img src=x onerror=alert(1)&gt;:test\u001b[31m</code>")
    expect(page).not.toMatch(/<script|<img|<b>/)
  })

  it("loads nothing: no script, no link, no remote URL, and a policy that refuses the network", () => {
    for (const page of [html(example), html(hostile), html(normalOnly()), html(empty)]) {
      expect(page).toContain(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
      )
      expect(page).not.toMatch(/<(script|link|img|iframe|object|embed)|<[a-z][^>]*\s(src|href)=|url\(|@import|https?:/i)
    }
  })

  it("styles light and dark and fits a phone", () => {
    const page = html(example)
    expect(page).toContain("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
    expect(page).toContain("<meta name=\"color-scheme\" content=\"light dark\">")
    expect(page).toContain("@media (prefers-color-scheme:dark)")
    expect(page).toContain(".scroll{overflow-x:auto}")
  })
})

describe("numbers", () => {
  it("prints durations in the largest units that keep them short", () => {
    expect(
      [0, 849.6, 949, 950, 12_340, 59_949, 59_950, 440_000, 3_599_000, 3_600_000, 3_930_000, 90_000_000].map(duration)
    )
      .toEqual([
        "0ms",
        "850ms",
        "949ms",
        "1.0s",
        "12.3s",
        "59.9s",
        "1m 00s",
        "7m 20s",
        "59m 59s",
        "1h 00m",
        "1h 06m",
        "25h 00m"
      ])
  })

  it("prints ratios with one decimal below 100", () => {
    expect([1, 5.954, 99.94, 100, 1234.5].map(times)).toEqual(["1.0×", "6.0×", "99.9×", "100×", "1235×"])
    expect([0, 0.0004, 0.0383, 0.0949, 0.095, 0.5].map(times)).toEqual([
      "0.0×",
      "0.0004×",
      "0.038×",
      "0.095×",
      "0.1×",
      "0.5×"
    ])
    expect([0, 0.5, 1, 2].map(speedup)).toEqual(["0.0× faster", "2.0× slower", "1.0× faster", "2.0× faster"])
  })

  it("draws bars in eighths, with at least one eighth for any time above zero", () => {
    expect(bar(10, 10, 4)).toBe("████")
    expect(bar(5, 10, 4)).toBe("██")
    expect(bar(9, 10, 4)).toBe("███▋")
    expect(bar(1, 1000, 4)).toBe("▏")
    expect(bar(0, 10, 4)).toBe("")
    expect(bar(0, 0, 4)).toBe("")
  })
})

describe("a report whose fast mode could not be measured", () => {
  const reason = "The model <could not> be reached."
  const report: ReplayReport = { ...normalOnly(), fastNotMeasured: reason }

  it("says so and why, beside the whole normal-mode report", () => {
    const printed = text(report)
    expect(printed).toContain(`Fast mode was not measured. ${reason}`)
    expect(printed).toContain("5.5× faster")
    expect(printed).toContain("1 commit · 0 mismatches")
    expect(printed).not.toMatch(/^fast/m)
  })

  it("says so on the page, escaped", () => {
    const page = html(report)
    expect(page).toContain("Fast mode was not measured. The model &lt;could not&gt; be reached.")
    expect(page).toContain("5.5× faster")
  })

  it("says so when no commit was replayed", () => {
    const empty = { ...report, commits: [] }
    expect(text(empty)).toBe(`Fast mode was not measured. ${reason}\n\n0 commits`)
    expect(html(empty)).toContain("Fast mode was not measured.")
  })

  it("says nothing when fast mode was measured or never asked for", () => {
    expect(text(normalOnly())).not.toContain("not measured")
    expect(html(normalOnly())).not.toContain("not measured")
  })
})
