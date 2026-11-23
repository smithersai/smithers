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

/** What marks a run as failed, for a commit that names no failed step. */
const counted = { ok: false } as const

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
  const { fast: _fast, model: _model, skipped: _skipped, ...first } = green
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
      "5.5× faster over 1 of 2 commits",
      "",
      "baseline  ████████████████████████  22m 00s",
      "normal    ████▍                      4m 00s   5.5×",
      "fast      █▋                         1m 30s  14.7×",
      "",
      "2 commits · 1 mismatch",
      "",
      "what the steps read was recorded by smthrs-observe",
      "",
      "the steps used 1h 10m of CPU time as the baseline, 10m 00s in normal mode (7.0× less) and 3m 30s in fast mode (20.0× less)",
      "",
      "the first run, with an empty cache, took 23m 10s as the baseline, 24m 30s in normal mode and 24m 40s in fast mode; it happens once and is in none of these times",
      "",
      "2 failed steps ran again, which took 43m 20s and is in none of these times",
      "",
      "fast mode",
      "test recall      0%  0 of 1 failure",
      "change recall    0%  0 of 1 failed change",
      "selection rate  42%  5 of 12 targets",
      "the model answered 9 questions in 33.0s, which is in fast mode's times",
      "over the commits these times cover, fast mode's runs took 2m 51s less than normal mode's and asking the model took 21.0s",
      "",
      "commit   files  baseline      normal       fast",
      "0000000      3  pass 22m 00s  pass 4m 00s  pass 1m 30s",
      "0000000      1  fail 21m 40s  fail 3m 20s  pass 1m 00s",
      "",
      "failed steps",
      "0000000  baseline, normal  //packages/core:test  exit 1: expected 2, got 3",
      "",
      "skipped, predicted-safe",
      "0000000  3 steps  Nothing in its history or in the change points to a failure.  //apps/web:lint, //apps/web:test, //packages/core:lint",
      "0000000  1 step  The changed files have changed often lately.  //packages/ui:test",
      "0000000  3 steps  Nothing in its history or in the change points to a failure.  //apps/web:lint, //packages/core:test, //packages/ui:test",
      "",
      "0000000  fast    //packages/core:test  fail → skipped"
    ].join("\n"))
  })

  it("says under a mismatch which tool read a file Smithers CI wrote", () => {
    const cause =
      "tsc read .smithers/WORKSPACE.smithers, which Smithers CI wrote. Add .smithers to \"exclude\" in the tsconfig.json it reads."
    const seen: ReplayReport = {
      ...example,
      commits: [green, {
        ...red,
        mismatches: [{ label: "//:check", mode: "normal", baseline: "pass", got: "fail", cause: `${cause}\nmore` }]
      }]
    }
    const lines = text(seen).split("\n")
    expect(lines.slice(-2)).toEqual(["0000000  normal  //:check  pass → fail", `  ${cause}`])
    // The mismatch still leads the report.
    expect(lines[0]).toBe("✗ 1 mismatch")
    const page = html({
      ...seen,
      commits: [green, { ...red, mismatches: [{ ...seen.commits[1]!.mismatches[0]!, cause: "<b>tsc</b> read x" }] }]
    })
    expect(page).toContain("normal: pass → fail</span><br>&lt;b&gt;tsc&lt;/b&gt; read x</li>")
    expect(html(example)).not.toContain("<br>")
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
    const { fast: _fast, model: _model, skipped: _skipped, ...plain } = red
    const unnamed = { ...plain, baseline: { ...green.baseline, ...counted }, normal: { ...green.normal, ...counted } }
    expect(text({ ...clean, commits: [green, { ...unnamed, mismatches: [] }] }).split("\n")).toContain(
      "0000000      1  fail 22m 00s  fail 4m 00s"
    )
  })

  it("leads with the speedup when nothing mismatched", () => {
    const lines = text(clean).split("\n")
    expect(lines[0]).toBe("5.5× faster over 1 of 2 commits")
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
    expect(lines.filter((line) => line.includes("fail → skipped"))).toHaveLength(2)
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
      "ci.yml:handoff    builds a variable from a secret, which a replay never has; runs only when a condition holds that a replay cannot check",
      "ci.yml:<e2e>\uFFFD[2J  needs a job, which is not replayed",
      "ci.yml:plain"
    ])
    expect(text({ ...partial, notReplayed: [partial.notReplayed![2]!] })).toContain("· 1 job not replayed")
  })

  it("does the same on the page, escaped", () => {
    const page = html(partial)
    expect(page).toContain("<p class=\"summary\">2 commits · 0 mismatches · 3 jobs not replayed</p>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code>ci.yml:handoff</code></th><td class=\"sub\">builds a variable from a secret, which a replay never has; runs only when a condition holds that a replay cannot check</td></tr>"
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

describe("a replay asked for some jobs only", () => {
  const asked: ReplayReport = {
    ...clean,
    jobs: { replayed: 2, total: 2 },
    asked: { jobs: ["ci.yml:test"], needed: [{ job: "ci.yml:build", for: ["ci.yml:test"] }], notAsked: 47 }
  }

  it("counts the jobs asked for, never a share of the CI's jobs, in the terminal", () => {
    const lines = text(asked).split("\n")
    expect(lines).toContain("5.5× faster over 1 of 2 commits and 1 job asked for")
    expect(lines).toContain("2 commits · 1 job asked for · 0 mismatches")
    expect(lines).toContain(
      "asked for ci.yml:test · with ci.yml:build, which ci.yml:test needs · 47 other jobs of the CI not asked for"
    )
    expect(text(asked)).not.toContain("of 49")
  })

  it("does the same on the page, escaped", () => {
    const page = html({
      ...asked,
      asked: { jobs: ["ci.yml:<a>", "ci.yml:b"], needed: [], notAsked: 1 }
    })
    expect(page).toContain("<p class=\"summary\">over 1 of 2 commits and 2 jobs asked for</p>")
    expect(page).toContain("<p class=\"summary\">2 commits · 2 jobs asked for · 0 mismatches</p>")
    expect(page).toContain(
      "<p class=\"summary\">asked for ci.yml:&lt;a&gt;, ci.yml:b · 1 other job of the CI not asked for</p>"
    )
  })

  it("counts a job asked for that could not be replayed as left out", () => {
    const left: ReplayReport = {
      ...asked,
      jobs: { replayed: 1, total: 2 },
      notReplayed: [{ job: "ci.yml:build", reasons: [] }]
    }
    expect(text(left).split("\n")).toContain("2 commits · 1 job asked for · 0 mismatches · 1 job not replayed")
  })

  it("says nothing of it when every job was asked for", () => {
    expect(text(clean)).not.toContain("asked for")
    expect(html(clean)).not.toContain("asked for")
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
      "ci.yml:package  has no command to run: all its steps only prepare the CI machine",
      "",
      "not read",
      ".github/workflows/<tests>.yml: BAD_INDENT at line 3\uFFFD[2J",
      "is in a package whose Turborepo settings were not read"
    ])
  })

  it("does the same on the page, escaped", () => {
    const page = html(unread)
    expect(page).toContain(
      "<p class=\"summary\">2 commits · 0 mismatches · 1 flaky · 1 job not replayed · 2 not read</p>"
    )
    expect(page).toContain(
      "<tr><td class=\"sub\">.github/workflows/&lt;tests&gt;.yml: BAD_INDENT at line 3\u001b[2J</td></tr>"
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
    expect(text(missing).split("\n").at(-1)).toBe(
      "linux.yml:build  needs go 1.23, ruby 3.4.6, which this machine does not have; install it and run smithers-ci again; needs a job, which is not replayed"
    )
    expect(html(missing)).toContain(
      "<td class=\"sub\">needs go 1.23, ruby 3.4.6, which this machine does not have; install it and run smithers-ci again; needs a job, which is not replayed</td>"
    )
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
    expect(page).toContain("<p class=\"hero\">5.5× faster</p>")
    expect(page).toContain("aria-label=\"baseline 22m 00s, normal 4m 00s, fast 1m 30s\"")
    expect(page).toContain("<p class=\"summary\">2 commits · 1 mismatch</p>")
    expect(page.indexOf("role=\"alert\"")).toBeLessThan(page.indexOf("class=\"hero\""))
  })

  it("draws each bar as a share of the longest time", () => {
    const widths = [...html(example).matchAll(/class="fill (\w+)" style="width:([\d.]+)%"/g)].map((m) => [m[1], m[2]])
    expect(widths).toEqual([["baseline", "100.00"], ["normal", "18.18"], ["fast", "6.82"]])
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
      "<tr class=\"bad\"><td colspan=\"4\"><ul><li><code>//packages/core:test</code> <span class=\"sub\">fast: fail → skipped</span></li><li><code>//packages/core:test</code> <span class=\"sub\">baseline, normal: exit 1: expected 2, got 3</span></li></ul></td></tr>"
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
    const { fast: _fast, model: _model, skipped: _skipped, ...plain } = red
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

describe("the disk a replay held", () => {
  const line = "the replay stopped before the disk filled: the disk that holds /tmp/x has 2 GB free"

  it("says the most the replay held at once, and the flag that holds less, in both renderers", () => {
    const report: ReplayReport = { ...normalOnly(), diskHeldBytes: 47_400_000_000 }
    const said = "The replay held at most 47 GB of disk at once; fewer jobs at once (--jobs) hold less"
    expect(text(report)).toContain(said)
    expect(html(report)).toContain(said)
    expect(text(normalOnly())).not.toContain("of disk at once")
    expect(html(normalOnly())).not.toContain("of disk at once")
  })

  it("says why a replay stopped before its last commit, above what it replayed", () => {
    const report: ReplayReport = { ...normalOnly(), stopped: line }
    const printed = text(report)
    expect(printed.startsWith(`The replay stopped before the disk filled: the disk that holds /tmp/x has 2 GB free.`))
      .toBe(true)
    expect(printed).toContain("1 commit · 0 mismatches")
    expect(html(report)).toContain(`<p class="alert" role="alert">The replay stopped before the disk filled`)
    expect(text(normalOnly())).not.toContain("stopped before")
  })
})

describe("steps not reused", () => {
  const { fast: _fast, ...plain } = green
  const network = {
    step: "install",
    reason: "it opened a network connection (npm to 104.16.4.34 port 443)",
    kept: false
  }
  const changed = { step: "test (node 22)", reason: "src/a.ts changed", kept: true }
  const docs = { step: "lint", reason: "readme.md changed", kept: true }
  const at = (commit: string, notReused: ReplayCommit["normal"]["notReused"]): ReplayCommit => ({
    ...plain,
    commit: commit.repeat(40),
    normal: { ...plain.normal, ...(notReused === undefined ? {} : { notReused }) }
  })
  const reused: ReplayReport = {
    ...normalOnly(),
    commits: [
      // A step split into two targets that give one reason is one line.
      at("a", [docs, changed, changed, network]),
      at("b", [network, changed]),
      at("c", [network]),
      at("d", undefined)
    ]
  }

  it("lists each step with the build's reason and the commits it ran at, the never reused first", () => {
    expect(text(reused)).toContain([
      "steps not reused",
      "3 of 4 commits  install  never reused: it opened a network connection (npm to 104.16.4.34 port 443)",
      "2 of 4 commits  test (node 22)  src/a.ts changed",
      "1 of 4 commits  lint  readme.md changed"
    ].join("\n"))
  })

  it("ends the line of a step that wants a lockfile with what a person does", () => {
    const fix = "commit Cargo.lock and this step and the 2 after it can be reused"
    const shown = text({ ...reused, commits: [at("a", [{ ...network, fix }, changed])] })
    expect(shown).toContain(
      `1 of 1 commit  install  never reused: ${network.reason}; ${fix}\n1 of 1 commit  test (node 22)  src/a.ts changed`
    )
  })

  it("puts a step's command on its line, and the variants of one step that ran for one reason on one line", () => {
    const build = (variant: string, reason = network.reason) => ({
      step: `ci.yml:test:1 (rust=${variant})`,
      reason,
      kept: false,
      command: "cargo build --verbose",
      variantOf: "ci.yml:test:1"
    })
    const shown = text({
      ...reused,
      commits: [
        at("a", [build("stable"), build("beta"), build("nightly", "it changed its root directory")]),
        at("b", [build("stable"), build("beta"), { ...changed, command: "npm test" }])
      ]
    })
    expect(shown).toContain([
      "steps not reused",
      `2 of 2 commits  ci.yml:test:1 (2 variants)  cargo build --verbose  never reused: ${network.reason}`,
      // One variant alone is called by its own name.
      "1 of 2 commits  ci.yml:test:1 (rust=nightly)  cargo build --verbose  never reused: it changed its root directory",
      "1 of 2 commits  test (node 22)  npm test  src/a.ts changed"
    ].join("\n"))
  })

  it("has no such section when every step was reused or gave no reason", () => {
    expect(text({ ...reused, commits: [at("d", undefined)] })).not.toContain("steps not reused")
    expect(text(example)).not.toContain("steps not reused")
  })

  it("replaces a control character of a step's name before it reaches a terminal", () => {
    const shown = text({ ...reused, commits: [at("a", [{ ...changed, step: "te\u001bst" }])] })
    expect(shown).toContain("1 of 1 commit  te\uFFFDst  src/a.ts changed")
  })
})

describe("failed steps", () => {
  const failure = { step: "lint <job>", reason: "`docker` is not installed on this machine", exitCode: 127 }
  const failedTotals = { ...green.baseline, ok: false, failures: [failure] }
  const { fast: _fast, model: _model, skipped: _skipped, ...plainGreen } = green
  const failing: ReplayCommit = {
    ...plainGreen,
    commit: "b".repeat(40),
    // A step split into two targets that fail alike is one failure.
    baseline: { ...failedTotals, failures: [failure, failure] },
    normal: { ...green.normal, ok: false, failures: [failure, { step: "other", reason: "no exit code" }] }
  }
  const partly: ReplayReport = {
    ...normalOnly(),
    commits: [{ ...plainGreen, commit: "a".repeat(40) }, failing],
    speedupCommits: 1
  }
  const none: ReplayReport = {
    ...partly,
    commits: [failing],
    baselineWallMs: 0,
    normalWallMs: 0,
    speedup: 0,
    speedupCommits: 0
  }

  it("says in the text how many commits the speedup covers, and lists each failure once", () => {
    const shown = text(partly)
    expect(shown).toContain("5.5× faster over 1 of 2 commits\n")
    expect(shown).toContain([
      "failed steps",
      "bbbbbbb  baseline, normal  lint <job>  exit 127: `docker` is not installed on this machine",
      "bbbbbbb  normal  other  no exit code"
    ].join("\n"))
  })

  it("puts what to do about a failed step under it, in the text and on the page", () => {
    const fixed = { ...failure, fix: "Install docker, then run smithers-ci again.\nIt needs a running daemon." }
    const withFix: ReplayReport = {
      ...partly,
      commits: [{ ...failing, baseline: { ...failedTotals, failures: [fixed] }, normal: green.normal }]
    }
    expect(text(withFix)).toContain([
      "bbbbbbb  baseline  lint <job>  exit 127: `docker` is not installed on this machine",
      "  Install docker, then run smithers-ci again."
    ].join("\n"))
    expect(html(withFix)).toContain("<br>Install docker, then run smithers-ci again.")
  })

  it("lists a step once when the baseline and a mode took its reason from different lines of its output", () => {
    // A step that writes no error output: the baseline reports the last line it printed, and a mode the first.
    const quiet = { step: "build: test", exitCode: 6, command: "sh test.sh" }
    const silent = { step: "build: wait" }
    const twoLines: ReplayReport = {
      ...partly,
      commits: [{
        ...plainGreen,
        commit: "c".repeat(40),
        baseline: {
          ...failedTotals,
          failures: [{ ...quiet, reason: "two failed" }, { ...silent, reason: "it made no progress for 10 minutes" }]
        },
        normal: {
          ...green.normal,
          ok: false,
          failures: [{ ...quiet, reason: "one" }, { ...silent, reason: "could not start: no such directory" }]
        }
      }]
    }
    const lines = text(twoLines).split("\n")
    expect(lines.slice(lines.indexOf("failed steps"), lines.indexOf("failed steps") + 4)).toEqual([
      "failed steps",
      "ccccccc  baseline, normal  build: test  exit 6: two failed",
      // With no exit code, another reason is another failure.
      "ccccccc  baseline  build: wait  it made no progress for 10 minutes",
      "ccccccc  normal  build: wait  could not start: no such directory"
    ])
    expect(html(twoLines).match(/build: test/g)).toHaveLength(1)
  })

  it("prints no speedup when normal mode gave another result than the CI, and says what to do", () => {
    const mismatch = { label: "//:check", mode: "normal", baseline: "pass", got: "fail" } as const
    const differing: ReplayReport = {
      ...none,
      mismatches: 1,
      commits: [{ ...plainGreen, commit: "d".repeat(40), mismatches: [mismatch] }]
    }
    const sentence =
      "no speedup: normal mode gave another result than your CI, so its time measures nothing. Each mismatch is listed below with its commit; fix what it names, or report it, and run this again."
    expect(text(differing).split("\n").slice(0, 3)).toEqual(["✗ 1 mismatch", "", sentence])
    expect(text(differing)).not.toMatch(/faster|slower|█/)
    expect(text(differing)).toContain("ddddddd  normal  //:check  pass → fail")
    const page = body(html(differing))
    expect(page).toContain(`<p class="alert" role="alert">${sentence}</p>`)
    expect(page).not.toContain("class=\"hero\"")
  })

  it("keeps the speedup when the one mismatch is a step that fails with the files apply writes", () => {
    const cause = "cspell read .smithers/WORKSPACE.smithers, which Smithers CI wrote."
    const mismatch = { label: "//:check", mode: "normal", baseline: "pass", got: "fail", cause } as const
    const measured = normalOnly()
    const report: ReplayReport = {
      ...measured,
      mismatches: 1,
      commits: measured.commits.map((commit) => ({ ...commit, mismatches: [mismatch] }))
    }
    const shown = text(report)
    expect(shown.split("\n").slice(0, 3)).toEqual(["✗ 1 mismatch", "", "5.5× faster"])
    expect(shown).toContain(`normal  //:check  pass → fail\n  ${cause}`)
    expect(body(html(report))).toContain("<p class=\"hero\">5.5× faster</p>")
    // With no baseline that passed there is no speedup, and the reason given is that one: normal mode's result
    // differs from no CI result.
    const failed: ReplayReport = {
      ...none,
      mismatches: 1,
      commits: [{ ...plainGreen, commit: "d".repeat(40), mismatches: [mismatch] }]
    }
    expect(text(failed)).not.toContain("normal mode gave another result")
    expect(body(html(failed))).not.toContain("normal mode gave another result")
  })

  it("prints no speedup and no bars in the text when no commit's baseline passed", () => {
    const shown = text(none)
    expect(shown).toContain("no speedup: the CI failed at every replayed commit")
    expect(shown).not.toContain("faster")
    expect(shown).not.toContain("█")
  })

  it("says what the run with the files apply writes took, on a line of its own", () => {
    const report: ReplayReport = { ...normalOnly(), appliedMs: 62_000 }
    const line =
      "ran the newest commit once more with the files apply writes in 1m 02s, which is in none of these times"
    expect(text(report)).toContain(`\n${line}\n`)
    expect(body(html(report))).toContain(`<p class="summary">${line}</p>`)
    // A replay asked to leave that run out says nothing of it.
    expect(text(normalOnly())).not.toContain("with the files apply writes")
    expect(body(html(normalOnly()))).not.toContain("with the files apply writes")
  })

  it("says how many jobs the numbers cover, beside the commits, and what finding them took", () => {
    const report: ReplayReport = { ...normalOnly(), jobs: { replayed: 3, total: 5 }, trialMs: 62_000 }
    const shown = text(report)
    expect(shown).toContain("5.5× faster over 3 of 5 jobs\n")
    expect(shown).toContain("1 commit · 3 of 5 jobs · 0 mismatches")
    expect(shown).toContain("found the jobs that pass on this machine in 1m 02s, which is in none of these times")
    const page = body(html(report))
    expect(page).toContain("<p class=\"summary\">over 3 of 5 jobs</p>")
    expect(page).toContain("1 commit · 3 of 5 jobs · 0 mismatches")
    expect(page).toContain("found the jobs that pass on this machine in 1m 02s")
  })

  it("gives the time of each way's first run on one line, in the text and on the page", () => {
    const firstRun = { commit: "f0f0f0f0f0f0", baselineMs: 250_000, normalMs: 302_000 }
    const line =
      "the first run, with an empty cache, took 4m 10s as the baseline and 5m 02s in normal mode; it happens once and is in none of these times"
    expect(text({ ...normalOnly(), firstRun }).split("\n")).toContain(line)
    expect(body(html({ ...normalOnly(), firstRun }))).toContain(`<p class="summary">${line}</p>`)
    // A mode whose first run did not finish has no time.
    expect(text({ ...normalOnly(), firstRun: { commit: "f0f0f0f0f0f0", baselineMs: 250_000 } }).split("\n")).toContain(
      "the first run, with an empty cache, took 4m 10s as the baseline; it happens once and is in none of these times"
    )
    expect(body(html(example))).toContain(
      "took 23m 10s as the baseline, 24m 30s in normal mode and 24m 40s in fast mode; it happens once"
    )
    expect(text(normalOnly())).not.toContain("the first run")
    expect(html(normalOnly())).not.toContain("the first run")
  })

  it("says on one line when starting is more than a twentieth of the CI, in the text and on the page", () => {
    const report: ReplayReport = { ...normalOnly(), startCost: { commitMs: 5800, startMs: 3200 } }
    const line =
      "your CI takes 5.8s for a commit and Smithers CI takes 3.2s to start, so only a commit that reuses results is faster here"
    expect(text(report).split("\n")).toContain(line)
    expect(body(html(report))).toContain(`<p class="summary">${line}</p>`)
    // A CI the start is small beside has no such line.
    expect(text(normalOnly())).not.toContain("to start")
    expect(html(normalOnly())).not.toContain("to start")
  })

  it("says there is nothing to gain when no commit was faster and the start or a reused commit takes the CI's time", () => {
    const [commit] = normalOnly().commits as [ReplayCommit]
    // rec3c: eleven one-line jobs, about a second a commit, and the commit where all eleven steps were reused.
    const at = (sha: string, baselineMs: number, normalMs: number, ran: number): ReplayCommit => ({
      ...commit,
      commit: sha,
      baseline: { ...commit.baseline, wallMs: baselineMs },
      normal: { ...commit.normal, wallMs: normalMs, counts: { hit: 11 - ran, ran, failed: 0, skipped: 0 } }
    })
    const slower = [at("35bae0d1", 1100, 1900, 11), at("cb5e4c0a", 1100, 1700, 0)]
    const short = (commits: ReadonlyArray<ReplayCommit>, startMs: number): ReplayReport => ({
      ...normalOnly(),
      commits: [...commits],
      startCost: { commitMs: 1100, startMs }
    })
    const startLonger =
      "your CI takes 1.1s for a commit and Smithers CI takes 1.4s to start, so your CI is already shorter than Smithers CI's start and there is nothing to gain here"
    expect(text(short(slower, 1400)).split("\n")).toContain(startLonger)
    expect(body(html(short(slower, 1400)))).toContain(`<p class="summary">${startLonger}</p>`)
    // A start shorter than the CI, and the commit that reused every step still took longer.
    expect(text(short(slower, 900)).split("\n")).toContain(
      "your CI takes 1.1s for a commit and Smithers CI takes 900ms to start; at cb5e4c0, where it reused every step, it took 1.7s against your CI's 1.1s, so there is nothing to gain here"
    )
    // One commit faster than the CI: only reuse is faster, whatever the start.
    const reuse = "so only a commit that reuses results is faster here"
    expect(text(short([...slower, at("d00d00d0", 1100, 1000, 0)], 1400))).toContain(reuse)
    // No commit reused every step and the start is shorter than the CI: reuse may still be faster.
    expect(text(short([at("35bae0d1", 1100, 1900, 11)], 900))).toContain(reuse)
    // A commit whose baseline failed says nothing about the CI's time.
    const failed = { ...at("e0e0e0e0", 1100, 100, 0), baseline: { ...commit.baseline, ok: false, wallMs: 1100 } }
    expect(text(short([...slower, failed], 1400))).toContain(startLonger)
  })

  it("gives the CPU time each way's steps used on one line, in the text and on the page", () => {
    const report: ReplayReport = { ...normalOnly(), baselineCpuMs: 1_570_000, normalCpuMs: 242_000 }
    const line = "the steps used 26m 10s of CPU time as the baseline and 4m 02s in normal mode (6.5× less)"
    expect(text(report).split("\n")).toContain(line)
    expect(body(html(report))).toContain(`<p class="summary">${line}</p>`)
    // A mode that used more says so, and one that used none is not compared.
    expect(text({ ...report, normalCpuMs: 3_140_000 })).toContain("52m 20s in normal mode (2.0× more)")
    expect(text({ ...report, normalCpuMs: 0 }).split("\n")).toContain(
      "the steps used 26m 10s of CPU time as the baseline and 0ms in normal mode"
    )
    expect(text({ ...report, baselineCpuMs: 0, normalCpuMs: 500 }).split("\n")).toContain(
      "the steps used 0ms of CPU time as the baseline and 500ms in normal mode"
    )
    expect(body(html(example))).toContain("10m 00s in normal mode (7.0× less) and 3m 30s in fast mode (20.0× less)")
    // On a machine whose processes could not be read there is no such line.
    for (const unread of [normalOnly(), { ...normalOnly(), baselineCpuMs: 1 }, { ...normalOnly(), normalCpuMs: 1 }]) {
      expect(text(unread)).not.toContain("CPU time")
      expect(html(unread)).not.toContain("CPU time")
    }
  })

  it("says how many failed steps ran again and what that took, in the text and on the page", () => {
    const line = "1 failed step ran again, which took 25m 03s and is in none of these times"
    const report: ReplayReport = { ...normalOnly(), reruns: { count: 1, ms: 1_503_000 } }
    expect(text(report).split("\n")).toContain(line)
    expect(body(html(report))).toContain(`<p class="summary">${line}</p>`)
    expect(body(html(example))).toContain("2 failed steps ran again, which took 43m 20s")
    expect(text(normalOnly())).not.toContain("ran again")
    expect(html(normalOnly())).not.toContain("ran again")
  })

  it("says why the first commit started with an empty cache, in the text and on the page", () => {
    const cold = "no commit comes before <a1b2c3d>\u001b[31m in this repository"
    const shown = text({ ...normalOnly(), cold })
    expect(shown.split("\n")).toContain(
      "started with an empty cache: no commit comes before <a1b2c3d>\uFFFD[31m in this repository"
    )
    expect(body(html({ ...normalOnly(), cold }))).toContain(
      "<p class=\"summary\">started with an empty cache: no commit comes before &lt;a1b2c3d&gt;"
    )
    expect(text(normalOnly())).not.toContain("started with an empty cache")
    expect(html(normalOnly())).not.toContain("started with an empty cache")
  })

  it("names commits and jobs together when the speedup leaves out both", () => {
    const [first] = normalOnly().commits as [ReplayCommit]
    const report: ReplayReport = {
      ...normalOnly(),
      commits: [first, { ...first, commit: "b2c3d4e5f6a1" }],
      speedupCommits: 1,
      jobs: { replayed: 1, total: 2 }
    }
    expect(text(report)).toContain("5.5× faster over 1 of 2 commits and 1 of 2 jobs\n")
  })

  it("keeps what it says of jobs and of the first run in the document", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport)({
      ...normalOnly(),
      jobs: { replayed: 1, total: 2 },
      trialMs: 5
    })
    expect(decoded).toMatchObject({ jobs: { replayed: 1, total: 2 }, trialMs: 5 })
  })

  it("does not count a job that was replayed with one variant left out as not replayed", () => {
    const report: ReplayReport = {
      ...normalOnly(),
      jobs: { replayed: 1, total: 2 },
      notReplayed: [
        { job: "docker", reasons: [{ feature: "fails-here", detail: "no docker" }] },
        { job: "test", reasons: [{ feature: "other-system", detail: "test (os=macos) runs on darwin" }] }
      ]
    }
    expect(text(report)).toContain("1 commit · 1 of 2 jobs · 0 mismatches · 1 job not replayed")
    expect(body(html(report))).toContain("1 of 2 jobs · 0 mismatches · 1 job not replayed")
  })

  it("says nothing of jobs when every job was replayed", () => {
    const shown = text({ ...normalOnly(), jobs: { replayed: 2, total: 2 } })
    expect(shown).toContain("5.5× faster\n")
    expect(shown).toContain("1 commit · 0 mismatches")
    expect(shown).not.toContain("found the jobs")
  })

  it("keeps a report that says nothing about coverage as it was", () => {
    expect(text(normalOnly())).toContain("5.5× faster\n")
  })

  it("shows the same on the page, escaped", () => {
    const page = body(html(partly))
    expect(page).toContain("<p class=\"hero\">5.5× faster</p>\n<p class=\"summary\">over 1 of 2 commits</p>")
    expect(page).toContain(
      "<li><code>lint &lt;job&gt;</code> <span class=\"sub\">baseline, normal: exit 127: `docker` is not installed on this machine</span></li>"
    )
    expect(page).toContain("<span class=\"sub\">normal: no exit code</span>")
    const nothing = body(html(none))
    expect(nothing).toContain(
      "<p class=\"alert\" role=\"alert\">no speedup: the CI failed at every replayed commit</p>"
    )
    expect(nothing).not.toContain("class=\"hero\"")
    expect(nothing).not.toContain("class=\"bars\"")
  })

  it("replaces control characters a failure holds in the text", () => {
    const hostileFailure = { step: "a\u001b[31m", reason: "b\u0007" }
    const shown = text({
      ...none,
      commits: [{ ...failing, baseline: { ...failedTotals, failures: [hostileFailure] } }]
    })
    expect(shown).not.toMatch(/[\u0007\u001b]/u)
  })
})

describe("what fast mode did, in both renderers", () => {
  const section = (report: ReplayReport, heading: string): ReadonlyArray<string> =>
    text(report).split("\n\n").find((part) => part.startsWith(heading))?.split("\n") ?? []

  it("gives the three numbers with their counts, and no recall when nothing failed", () => {
    expect(section(clean, "fast mode").slice(0, 4)).toEqual([
      "fast mode",
      "test recall     100%  1 of 1 failure",
      "change recall   100%  1 of 1 failed change",
      "selection rate   50%  6 of 12 targets"
    ])
    const { testRecall: _t, changeRecall: _c, ...metrics } = example.selection!
    const passed = section({ ...example, selection: { ...metrics, failures: 0, failedChanges: 0 } }, "fast mode")
    expect(passed.slice(0, 2)).toEqual(["fast mode", "selection rate  42%  5 of 12 targets"])
    expect(passed.join("\n")).not.toContain("recall")
    // A report with no fast mode has no such section.
    expect(section(normalOnly(), "fast mode")).toEqual([])
  })

  it("says how many questions the model answered and how long that took, or the time alone", () => {
    expect(section(example, "fast mode")[4]).toBe(
      "the model answered 9 questions in 33.0s, which is in fast mode's times"
    )
    const timed = { ...example, model: { ms: 1500 } }
    expect(section(timed, "fast mode")[4]).toBe("the model answered in 1.5s, which is in fast mode's times")
    expect(html(timed)).toContain("<p class=\"summary\">the model answered in 1.5s, which is in fast mode's times</p>")
    const one = { ...example, model: { ms: 800, questions: 1 } }
    expect(section(one, "fast mode")[4]).toBe("the model answered 1 question in 800ms, which is in fast mode's times")
    // A report that does not say what the model cost has no such line.
    const { model: _model, ...silent } = example
    expect(section(silent, "fast mode").join("\n")).not.toContain("the model answered")
    expect(html(silent)).not.toContain("the model answered")
  })

  it("sets what skipping saved against what asking cost, over the commits the times cover", () => {
    const saved =
      "over the commits these times cover, fast mode's runs took 2m 51s less than normal mode's and asking the model took 21.0s"
    expect(section(example, "fast mode")[5]).toBe(saved)
    expect(html(example)).toContain(`<p class="summary">${saved}</p>`)
    // Fast mode's runs can take longer than normal mode's: the line says so.
    const slower: ReplayReport = {
      ...example,
      commits: [{ ...green, fast: { ...green.fast!, wallMs: 300_000 }, model: { ms: 40_000 } }, red]
    }
    expect(section(slower, "fast mode")[5]).toBe(
      "over the commits these times cover, fast mode's runs took 20.0s more than normal mode's and asking the model took 40.0s"
    )
    // No commit the times cover was asked about: a failed baseline, a commit with no model time, a normal-mode mismatch.
    const { model: _model, ...unasked } = green
    for (
      const uncovered of [
        { ...example, commits: [red] },
        { ...example, commits: [unasked, red] },
        {
          ...example,
          commits: [
            {
              ...green,
              mismatches: [{ label: "//:a", mode: "normal" as const, baseline: "pass" as const, got: "fail" as const }]
            },
            red
          ]
        }
      ]
    ) {
      expect(section(uncovered, "fast mode").join("\n")).not.toContain("over the commits these times cover")
      expect(html(uncovered)).not.toContain("over the commits these times cover")
    }
  })

  it("lists every skipped target with its commit and the model's reason, five to a line and how many more", () => {
    const skip = (label: string, reason?: string) => ({
      label,
      skipReason: "predicted-safe" as const,
      score: 0.01,
      ...(reason === undefined ? {} : { reason })
    })
    const many: ReplayReport = {
      ...example,
      commits: [
        {
          ...green,
          commit: "aaaaaaa1",
          skipped: ["a", "b", "c", "d", "e", "f", "g"].map((name) => skip(`//${name}:test`))
        },
        { ...red, commit: "bbbbbbb2", skipped: [skip("//x:test", "why")] }
      ]
    }
    expect(section(many, "skipped, predicted-safe")).toEqual([
      "skipped, predicted-safe",
      "aaaaaaa  7 steps  //a:test, //b:test, //c:test, //d:test, //e:test and 2 more",
      "bbbbbbb  1 step  why  //x:test"
    ])
    const page = html(many)
    expect(page).toContain("<h2>skipped, predicted-safe</h2>")
    expect(page).toContain(
      "<tr><th scope=\"row\"><code title=\"aaaaaaa1\">aaaaaaa</code></th><td class=\"num\">7</td><td class=\"sub\"></td><td><code>//a:test, //b:test, //c:test, //d:test, //e:test and 2 more</code></td></tr>"
    )
    expect(page).toContain(
      "<td class=\"num\">1</td><td class=\"sub\">why</td><td><code>//x:test</code></td></tr>"
    )
    // A report with no skip has no such list.
    const none: ReplayReport = { ...example, commits: [{ ...green, skipped: [] }, { ...red, skipped: [] }] }
    expect(section(none, "skipped, predicted-safe")).toEqual([])
    expect(html(none)).not.toContain("skipped, predicted-safe")
  })

  it("names what recorded the files the steps read, and why, in the terminal and on the page", () => {
    const line = (report: ReplayReport): ReadonlyArray<string> =>
      text(report).split("\n").filter((each) => each.startsWith("what the steps read"))
    const page = (report: ReplayReport): ReadonlyArray<string> =>
      [...html(report).matchAll(/<p class="summary">(what the steps read[^<]*)<\/p>/g)].map((match) => match[1]!)
    const cases: ReadonlyArray<readonly [NonNullable<ReplayReport["recorder"]>, string]> = [
      [{ name: "smthrs-observe" }, "what the steps read was recorded by smthrs-observe"],
      [{ name: "strace" }, "what the steps read was recorded by strace"],
      [
        { name: "strace", why: "SMTHRS_OBSERVE_WITH=strace asks for strace" },
        "what the steps read was recorded by strace: SMTHRS_OBSERVE_WITH=strace asks for strace"
      ],
      [
        { name: "strace", why: "smthrs-observe cannot run here: this machine refuses pidfd_getfd." },
        "what the steps read was recorded by strace: smthrs-observe cannot run here: this machine refuses pidfd_getfd"
      ],
      [
        { name: "none", why: "reads cannot be observed on darwin" },
        "what the steps read was not recorded: reads cannot be observed on macOS"
      ],
      [{ name: "none" }, "what the steps read was not recorded"]
    ]
    for (const [recorder, said] of cases) {
      expect(line({ ...example, recorder })).toEqual([said])
      expect(page({ ...example, recorder })).toEqual([said])
    }
    // It stands under the counts, before the CPU time.
    const lines = text(example).split("\n")
    expect(lines.indexOf("what the steps read was recorded by smthrs-observe")).toBe(
      lines.indexOf("2 commits · 1 mismatch") + 2
    )
    // A replay that observed no step names no recorder.
    const { recorder: _recorder, ...unnamed } = example
    expect(line(unnamed)).toEqual([])
    expect(page(unnamed)).toEqual([])
    // What the recorder said is the machine's, so it is cleaned for the terminal and escaped for the page.
    const hostile: ReplayReport = { ...example, recorder: { name: "strace", why: "<b>x</b>\u001b[31m" } }
    expect(line(hostile)).toEqual(["what the steps read was recorded by strace: <b>x</b>\uFFFD[31m"])
    expect(html(hostile)).toContain("recorded by strace: &lt;b&gt;x&lt;/b&gt;")
  })

  it("never lets a skipped target's label or reason reach the terminal or the page as it came", () => {
    const hostileSkip: ReplayReport = {
      ...example,
      commits: [{
        ...green,
        skipped: [{ label: "//<b>x</b>:test\u001b[31m", skipReason: "predicted-safe", reason: "<i>why</i>\u0007" }]
      }, red]
    }
    const lines = section(hostileSkip, "skipped, predicted-safe")
    expect(lines[1]).toBe("0000000  1 step  <i>why</i>\uFFFD  //<b>x</b>:test\uFFFD[31m")
    const page = html(hostileSkip)
    expect(page).toContain("&lt;i&gt;why&lt;/i&gt;")
    expect(page).toContain("//&lt;b&gt;x&lt;/b&gt;:test")
    expect(page).not.toContain("<b>x</b>")
  })
})
