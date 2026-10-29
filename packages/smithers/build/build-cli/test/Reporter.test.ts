/**
 * The three renderers over one scripted run: `plain` prints the historical
 * lines byte for byte, `stream` colours and aligns without touching the
 * cursor, and `tty` keeps running targets pinned below the settled ones.
 * Renderer selection follows the flag, the environment, and the streams.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Audience from "../src/Audience.ts"
import type * as Executor from "../src/Executor.ts"
import * as Reporter from "../src/Reporter.ts"

/** An in-memory terminal; `columns` is fixed so alignment is deterministic. */
const terminal = (isTTY = true, columns = 80): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY,
    columns,
    text: () => out
  }
}

const report = (
  label: string,
  status: Executor.TargetReport["status"],
  durationMs: number,
  error?: string
): Executor.TargetReport => ({
  label,
  target: "Shell.Test",
  status,
  durationMs,
  key: "k",
  ...(error === undefined ? {} : { error })
})

const results = [
  report("//:alpha", "ran", 12_345),
  report("//:beta", "hit", 0),
  report(
    "//:gamma",
    "failed",
    23_000,
    "the agent reported 2 finding(s)\n  src/a.ts:1 warning: x\n  src/b.ts:2 error: y"
  ),
  report("//:delta", "skipped", 0, "dependency //:gamma did not succeed")
]

const summary: Executor.Summary = {
  verb: "lint",
  pattern: "//...",
  jobs: 2,
  durationMs: 23_000,
  counts: { hit: 1, ran: 1, failed: 1, skipped: 1 },
  ok: false,
  results
}

const run: Reporter.RunStart = {
  verb: "lint",
  pattern: "//...",
  jobs: 2,
  targets: results.map((entry) => ({ label: entry.label, target: entry.target }))
}

/** Replays the scripted run through one reporter. */
const replay = (reporter: Reporter.Reporter): void => {
  reporter.begin(run)
  for (const entry of results) {
    if (entry.status !== "skipped") reporter.targetStarted(entry.label)
    reporter.targetFinished(entry)
  }
  reporter.note("//:alpha  cache miss: inputs changed")
  reporter.warn("smthrs: could not store //:alpha in the cache: disk full")
  reporter.summary(summary)
  reporter.close()
}

const collapse = (line: string): string => Ansi.strip(line).replace(/\s+/g, " ").trim()

describe("audience-aware progress", () => {
  it("keeps an agent on a PTY quiet even with an explicit tty renderer", () => {
    const term = terminal(true)
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      presentation: Audience.resolve({ env: { CLAUDECODE: "1" }, stdout: true, stderr: true })
    })
    replay(reporter)
    expect(term.text()).toContain("//:gamma  failed")
    expect(term.text()).toContain("disk full")
    expect(term.text()).not.toContain("//:alpha  ran")
    expect(term.text()).not.toContain("4 targets:")
    expect(term.text()).not.toContain("\u001b[")
  })

  it("uses Clack framing and eager task starts for humans without color or cursor motion", () => {
    const term = terminal(true)
    const env = { NO_COLOR: "1" }
    replay(Reporter.make({
      renderer: "tty",
      terminal: term,
      env,
      presentation: Audience.resolve({ env, audience: "human", stdout: true, stderr: true })
    }))
    expect(term.text()).toContain("lint //...")
    expect(term.text()).toContain("Running //:alpha")
    expect(term.text()).toContain("4 targets:")
    expect(term.text()).not.toContain("\u001b[")
  })

  it("never emits cursor motion on redirected or dumb human terminals", () => {
    for (const [isTTY, env] of [[false, {}], [true, { TERM: "dumb" }]] as const) {
      const term = terminal(isTTY)
      replay(Reporter.make({
        renderer: "tty",
        terminal: term,
        env,
        presentation: Audience.resolve({ env, audience: "human", stdout: isTTY, stderr: isTTY })
      }))
      expect(term.text()).toContain("Running //:alpha")
      expect(term.text()).not.toContain("\u001b[")
    }
  })

  it("keeps the last 40 diagnostic lines after progress and warning limits", () => {
    const term = terminal(false)
    const reporter = Reporter.silent(term)
    for (let index = 0; index < 20; index++) reporter.warn("warning")
    const tail = Array.from({ length: 40 }, (_, index) => `error ${index}: ${"detail ".repeat(30)}`)
    reporter.targetFinished(
      report(
        "//:bundle",
        "failed",
        1000,
        ["command failed (exit 1): compiler", ...Array.from({ length: 100 }, () => "Downloading crates"), ...tail].join(
          "\n"
        )
      )
    )
    expect(term.text()).toContain("//:bundle  failed")
    for (const line of tail) expect(term.text()).toContain(line)
    reporter.targetFinished(report("//:other", "failed", 1, "another cause"))
    expect(term.text()).toContain("//:other  failed")
    expect(term.text()).toContain("another cause")
  })

  it("honors human silence and bounds repeated diagnostics", () => {
    const term = terminal(true)
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      presentation: Audience.resolve({ env: {}, audience: "human", silent: true, stdout: true, stderr: true })
    })
    reporter.begin(run)
    reporter.targetStarted("//:alpha")
    reporter.toolOutput("//:alpha", "stdout", "chatty output")
    expect(term.text()).toBe("")
    for (let index = 0; index < 100; index++) reporter.warn("x".repeat(1000))
    expect(term.text().length).toBeLessThan(9000)
    expect(term.text()).toContain("omitted")
  })
})

describe("Reporter.formatDuration", () => {
  it("prints milliseconds below one second and tenths above", () => {
    expect(Reporter.formatDuration(0)).toBe("0ms")
    expect(Reporter.formatDuration(999.4)).toBe("999ms")
    expect(Reporter.formatDuration(1000)).toBe("1.0s")
    expect(Reporter.formatDuration(12_345)).toBe("12.3s")
  })
})

describe("plain renderer", () => {
  it("prints the historical status lines and summary, byte for byte", () => {
    const lines: Array<string> = []
    replay(Reporter.plain((line) => lines.push(line)))
    expect(lines).toEqual([
      "//:alpha  ran  12.3s",
      "//:beta  hit  0ms",
      "//:gamma  failed  23.0s  the agent reported 2 finding(s)\n  src/a.ts:1 warning: x\n  src/b.ts:2 error: y",
      "//:delta  skipped  0ms  dependency //:gamma did not succeed",
      "//:alpha  cache miss: inputs changed",
      "smthrs: could not store //:alpha in the cache: disk full",
      "4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (23.0s)"
    ])
  })

  it("prefixes streamed tool output with its label", () => {
    const lines: Array<string> = []
    Reporter.plain((line) => lines.push(line)).toolOutput("//:alpha", "stdout", "one\ntwo\n")
    expect(lines).toEqual(["//:alpha: one", "//:alpha: two"])
  })

  it("is what Reporter.of builds over a log sink, and yields to a given reporter", () => {
    const lines: Array<string> = []
    const overLog = Reporter.of({ log: (line) => lines.push(line) })
    overLog.targetFinished(results[0]!)
    expect(overLog.renderer).toBe("plain")
    expect(lines).toEqual(["//:alpha  ran  12.3s"])
    const given = Reporter.plain(() => {})
    expect(Reporter.of({ reporter: given, log: (line) => lines.push(line) })).toBe(given)
  })

  it("writes one line per event through make", () => {
    const term = terminal(false)
    replay(Reporter.make({ renderer: "plain", terminal: term, env: {} }))
    expect(term.text()).toBe(
      "//:alpha  ran  12.3s\n" +
        "//:beta  hit  0ms\n" +
        "//:gamma  failed  23.0s  the agent reported 2 finding(s)\n  src/a.ts:1 warning: x\n  src/b.ts:2 error: y\n" +
        "//:delta  skipped  0ms  dependency //:gamma did not succeed\n" +
        "//:alpha  cache miss: inputs changed\n" +
        "smthrs: could not store //:alpha in the cache: disk full\n" +
        "4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (23.0s)\n"
    )
  })
})

describe("Reporter.resolveRenderer", () => {
  const both = { stdout: true, stderr: true }
  const neither = { stdout: false, stderr: false }

  it("lets an explicit mode win over everything", () => {
    expect(Reporter.resolveRenderer("plain", {}, both)).toBe("plain")
    expect(Reporter.resolveRenderer("tty", { CI: "1", NO_COLOR: "1" }, neither, true)).toBe("tty")
    expect(Reporter.resolveRenderer("stream", {}, neither)).toBe("stream")
  })

  it("reads SMTHRS_UI before the heuristics", () => {
    expect(Reporter.resolveRenderer("auto", { SMTHRS_UI: "stream" }, both)).toBe("stream")
    expect(Reporter.resolveRenderer("auto", { SMTHRS_UI: "auto" }, both)).toBe("tty")
    expect(Reporter.resolveRenderer("auto", { SMTHRS_UI: "bogus" }, both)).toBe("tty")
  })

  it("goes plain for a program: explicit format, NO_COLOR, a dumb terminal, or CI", () => {
    expect(Reporter.resolveRenderer("auto", {}, both, true)).toBe("plain")
    expect(Reporter.resolveRenderer("auto", { NO_COLOR: "1" }, both)).toBe("plain")
    expect(Reporter.resolveRenderer("auto", { TERM: "dumb" }, both)).toBe("plain")
    expect(Reporter.resolveRenderer("auto", { CI: "true" }, both)).toBe("plain")
    expect(Reporter.resolveRenderer("auto", { CI: "" }, both)).toBe("tty")
  })

  it("streams colour into a CI log only when FORCE_COLOR asks", () => {
    expect(Reporter.resolveRenderer("auto", { CI: "true", FORCE_COLOR: "1" }, neither)).toBe("stream")
    expect(Reporter.resolveRenderer("auto", { CI: "true", FORCE_COLOR: "0" }, both)).toBe("plain")
  })

  it("draws live only with two terminals, streams with one, and stays plain under pipes", () => {
    expect(Reporter.resolveRenderer("auto", {}, both)).toBe("tty")
    expect(Reporter.resolveRenderer("auto", {}, { stdout: false, stderr: true })).toBe("stream")
    expect(Reporter.resolveRenderer("auto", {}, { stdout: true, stderr: false })).toBe("plain")
    expect(Reporter.resolveRenderer("auto", {}, neither)).toBe("plain")
    expect(Reporter.resolveRenderer("auto", { FORCE_COLOR: "1" }, neither)).toBe("stream")
  })
})

describe("stream renderer", () => {
  const rendered = (): ReadonlyArray<string> => {
    const term = terminal(true)
    replay(Reporter.make({ renderer: "stream", terminal: term, env: {} }))
    return term.text().split("\n")
  }

  it("never moves the cursor", () => {
    const term = terminal(true)
    replay(Reporter.make({ renderer: "stream", terminal: term, env: {} }))
    expect(term.text()).not.toContain(Ansi.eraseDown)
    expect(term.text()).not.toContain(Ansi.hideCursor)
    expect(term.text()).not.toMatch(/\u001b\[\d+A/)
  })

  it("renders the header, started lines, glyph lines, details, notes, and the footer", () => {
    expect(rendered().map(collapse)).toEqual([
      "▸ lint //... 4 targets · 2 jobs",
      "▸ //:alpha",
      "✓ //:alpha 12.3s",
      "▸ //:beta",
      "○ //:beta cached 0ms",
      "▸ //:gamma",
      "✗ //:gamma failed 23.0s",
      "the agent reported 2 finding(s)",
      "• src/a.ts:1 warning: x",
      "• src/b.ts:2 error: y",
      "↷ //:delta skipped 0ms",
      "dependency //:gamma did not succeed",
      "//:alpha cache miss: inputs changed",
      "⚠ could not store //:alpha in the cache: disk full",
      "",
      "Tasks: 1 ran, 1 cached, 1 failed, 1 skipped, 4 total · Time: 23.0s",
      "✗ 1 of 4 targets failed: //:gamma",
      ""
    ])
  })

  it("right-aligns durations across every settled line", () => {
    const glyphLines = rendered().map(Ansi.strip).filter((line) => /^[✓○✗↷] \/\//.test(line))
    expect(glyphLines).toHaveLength(4)
    const widths = new Set(glyphLines.map((line) => Ansi.visibleWidth(line)))
    expect(widths.size).toBe(1)
    for (const line of glyphLines) expect(line).toMatch(/(?:\d+ms|\d+\.\ds)$/)
  })

  it("colours on a terminal and not under NO_COLOR", () => {
    const coloured = terminal(true)
    replay(Reporter.make({ renderer: "stream", terminal: coloured, env: {} }))
    expect(coloured.text()).toContain("\u001b[32m✓\u001b[39m")
    expect(coloured.text()).toContain("\u001b[31m✗\u001b[39m")
    const bare = terminal(true)
    replay(Reporter.make({ renderer: "stream", terminal: bare, env: { NO_COLOR: "1" } }))
    expect(bare.text()).not.toContain("\u001b[")
  })

  it("celebrates a run answered entirely from the cache", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "stream", terminal: term, env: { NO_COLOR: "1" } })
    reporter.begin({ ...run, targets: run.targets.slice(0, 2) })
    reporter.summary({
      ...summary,
      ok: true,
      counts: { hit: 2, ran: 0, failed: 0, skipped: 0 },
      results: [report("//:alpha", "hit", 1), report("//:beta", "hit", 1)]
    })
    expect(term.text()).toContain("Tasks: 2 cached, 2 total · Time: 23.0s >>> FULL CACHE")
    expect(term.text()).not.toContain("targets failed")
  })

  it("prefixes tool output with a coloured label bar", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "stream", terminal: term, env: {} })
    reporter.begin(run)
    reporter.toolOutput("//:alpha", "stdout", "one\ntwo\n")
    reporter.toolOutput("//:beta", "stderr", "three")
    const lines = term.text().split("\n").slice(1).map(Ansi.strip)
    expect(lines).toEqual(["//:alpha │ one", "//:alpha │ two", "//:beta │ three", ""])
    expect(term.text()).toContain("\u001b[36m//:alpha │\u001b[39m")
    expect(term.text()).toContain("\u001b[35m//:beta │\u001b[39m")
  })
})

describe("tty renderer", () => {
  const live = (
    columns = 80
  ): {
    readonly term: ReturnType<typeof terminal>
    readonly reporter: Reporter.Reporter
    tick: (ms: number) => void
  } => {
    const term = terminal(true, columns)
    let clock = 0
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      env: { NO_COLOR: "1" },
      now: () => clock,
      interval: false
    })
    return {
      term,
      reporter,
      tick: (ms) => {
        clock += ms
      }
    }
  }

  it("hides the cursor, pins running targets below the header, and erases them when they settle", () => {
    const { reporter, term, tick } = live()
    reporter.begin(run)
    expect(term.text()).toBe(`${Ansi.hideCursor}▸ lint //...  4 targets · 2 jobs\n`)
    reporter.targetStarted("//:alpha")
    tick(1500)
    reporter.targetStarted("//:beta")
    const pinned = term.text().slice(term.text().indexOf(Ansi.eraseDown) + Ansi.eraseDown.length)
    expect(pinned.split("\n").map(collapse)).toEqual([
      "⠋ //:alpha 1.5s",
      "⠋ //:beta 0ms",
      "0/4 done · 2 running · 1.5s",
      ""
    ])
    const before = term.text().length
    reporter.targetFinished(results[0]!)
    const frame = term.text().slice(before)
    expect(frame.startsWith(`${Ansi.cursorUp(3)}${Ansi.eraseDown}`)).toBe(true)
    expect(frame.split("\n").map(collapse)).toEqual([
      "✓ //:alpha 12.3s",
      "⠋ //:beta 0ms",
      "1/4 done · 1 running · 1.5s",
      ""
    ])
  })

  it("clears the live region and shows the cursor on close, then prints the footer after the last target", () => {
    const { reporter, term } = live()
    reporter.begin(run)
    reporter.targetStarted("//:alpha")
    reporter.targetFinished(results[0]!)
    expect(term.text().endsWith("✓ //:alpha             12.3s\n")).toBe(true)
    reporter.summary({
      ...summary,
      ok: true,
      counts: { hit: 0, ran: 1, failed: 0, skipped: 0 },
      results: [results[0]!]
    })
    reporter.close()
    expect(term.text().endsWith(`Tasks: 1 ran, 1 total · Time: 23.0s\n${Ansi.showCursor}`)).toBe(true)
  })

  it("erases a still-pinned region when closed mid-run", () => {
    const { reporter, term } = live()
    reporter.begin(run)
    reporter.targetStarted("//:alpha")
    reporter.close()
    expect(term.text().endsWith(`${Ansi.cursorUp(2)}${Ansi.eraseDown}${Ansi.showCursor}`)).toBe(true)
  })

  it("truncates pinned lines to the terminal width so cursor arithmetic holds", () => {
    const { reporter, term } = live(24)
    reporter.begin({ ...run, targets: [{ label: "//packages/very/long:label", target: "Shell.Test" }] })
    reporter.targetStarted("//packages/very/long:label")
    const pinned = term.text().slice(term.text().lastIndexOf("\n", term.text().length - 2) + 1)
    const rows = term.text().split("\n").filter((line) => line.startsWith("⠋"))
    expect(rows).toHaveLength(1)
    expect(Ansi.visibleWidth(rows[0]!)).toBeLessThanOrEqual(23)
    expect(rows[0]!.endsWith("…")).toBe(true)
    expect(Ansi.visibleWidth(pinned.trimEnd())).toBeLessThanOrEqual(23)
  })

  it("advances the spinner on each timer tick", async () => {
    const term = terminal(true)
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      env: { NO_COLOR: "1" },
      now: () => 0,
      interval: 5
    })
    reporter.begin(run)
    reporter.targetStarted("//:alpha")
    await new Promise((resolve) => setTimeout(resolve, 40))
    reporter.close()
    const frames = new Set(
      [...Ansi.strip(term.text()).matchAll(/^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) \/\/:alpha/gmu)].map((match) => match[1])
    )
    expect(frames.size).toBeGreaterThan(1)
  })
})

describe("failure detail", () => {
  it("lists producer-indented findings and shows a tool's own output verbatim", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "stream", terminal: term, env: { NO_COLOR: "1" } })
    reporter.begin({ ...run, targets: [{ label: "//:lint", target: "Shell.Test" }] })
    reporter.targetFinished(
      report(
        "//:lint",
        "failed",
        40,
        "command failed (exit 1): biome lint\nsrc/App.tsx:12:5 error: unused\n  > 4 │ let x\n\n  i Use const."
      )
    )
    expect(term.text().split("\n").slice(1, -1)).toEqual([
      "✗ //:lint  failed      40ms",
      "    command failed (exit 1): biome lint",
      "    src/App.tsx:12:5 error: unused",
      "      • > 4 │ let x",
      "      • i Use const."
    ])
  })

  it("treats a zero column count as an unknown width rather than a narrow one", () => {
    const term = terminal(true, 0)
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      env: { NO_COLOR: "1" },
      now: () => 0,
      interval: false
    })
    reporter.begin({ ...run, targets: [{ label: "//src/Server:__private_ImportClosure_1", target: "ImportClosure" }] })
    reporter.targetStarted("//src/Server:__private_ImportClosure_1")
    expect(term.text()).toContain("⠋ //src/Server:__private_ImportClosure_1")
    reporter.close()
  })
})

describe("renderer edges", () => {
  it("folds a long run queue into a count and reuses a label's prefix colour", () => {
    const term = terminal(true)
    let clock = 0
    const reporter = Reporter.make({
      renderer: "tty",
      terminal: term,
      env: { NO_COLOR: "1" },
      now: () => clock,
      interval: false
    })
    const labels = Array.from({ length: 14 }, (_, index) => `//:t${index}`)
    reporter.begin({ ...run, targets: labels.map((label) => ({ label, target: "Shell.Test" })) })
    for (const label of labels) reporter.targetStarted(label)
    clock += 10
    reporter.toolOutput("//:t0", "stdout", "")
    reporter.toolOutput("//:t0", "stdout", "a\n")
    reporter.toolOutput("//:t0", "stdout", "b\n")
    const text = Ansi.strip(term.text())
    expect(text).toContain("… 3 more running")
    expect(text).toContain("//:t0 │ a")
    expect(text).toContain("//:t0 │ b")
    reporter.close()
  })

  it("renders plain notes, unprefixed warnings, and an empty tool chunk in stream mode", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "stream", terminal: term })
    reporter.begin(run)
    reporter.note("smthrs: plan-time cache unavailable")
    reporter.note("planning 4 targets")
    reporter.warn("disk is nearly full")
    reporter.toolOutput("//:alpha", "stderr", "")
    expect(Ansi.strip(term.text()).split("\n").slice(1)).toEqual([
      "⚠ plan-time cache unavailable",
      "  planning 4 targets",
      "⚠ disk is nearly full",
      ""
    ])
  })

  it("writes nothing for an empty tool chunk with nothing pinned, and never shows a cursor it did not hide", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "tty", terminal: term, env: { NO_COLOR: "1" }, interval: false })
    reporter.begin(run)
    const before = term.text()
    reporter.toolOutput("//:alpha", "stdout", "")
    expect(term.text()).toBe(before)
    reporter.close()
    expect(term.text().endsWith(Ansi.showCursor)).toBe(true)
    const untouched = terminal(true)
    Reporter.make({ renderer: "tty", terminal: untouched, env: { NO_COLOR: "1" }, interval: false }).close()
    expect(untouched.text()).toBe("")
  })

  it("defaults Reporter.of to a plain renderer over standard error", () => {
    let captured = ""
    const original = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }) as typeof process.stderr.write
    try {
      const reporter = Reporter.of({})
      expect(reporter.renderer).toBe("plain")
      reporter.note("hello")
    } finally {
      process.stderr.write = original
    }
    expect(captured).toBe("hello\n")
  })

  it("wraps a process stream as a terminal that reads its width lazily", () => {
    const fake = { write: () => true, isTTY: true, columns: 120 } as unknown as NodeJS.WriteStream
    const term = Reporter.terminalOf(fake)
    expect(term.isTTY).toBe(true)
    expect(term.columns).toBe(120)
    ;(fake as unknown as { columns: number }).columns = 60
    expect(term.columns).toBe(60)
    let written = ""
    const pipe = {
      write: (text: string) => {
        written += text
        return true
      },
      isTTY: undefined,
      columns: undefined
    } as unknown as NodeJS.WriteStream
    const piped = Reporter.terminalOf(pipe)
    piped.write("x")
    expect(written).toBe("x")
    expect(piped.isTTY).toBe(false)
    expect(piped.columns).toBeUndefined()
  })
})

describe("cancelled targets", () => {
  const cancelled = report(
    "//:epsilon",
    "cancelled",
    1_500,
    "cancelled: --fail-fast stopped the run after //:gamma failed"
  )
  const stopped: Executor.Summary = {
    ...summary,
    counts: { ...summary.counts, cancelled: 1 },
    results: [...results, cancelled]
  }

  it("renders a cancelled row and count in the stream renderer", () => {
    const term = terminal(true)
    const reporter = Reporter.make({ renderer: "stream", terminal: term, env: {} })
    reporter.begin(run)
    reporter.targetFinished(cancelled)
    reporter.summary(stopped)
    reporter.close()
    const lines = term.text().split("\n").map(collapse)
    expect(lines).toContain("⊘ //:epsilon cancelled 1.5s")
    expect(lines).toContain("cancelled: --fail-fast stopped the run after //:gamma failed")
    expect(lines).toContain("Tasks: 1 ran, 1 cached, 1 failed, 1 skipped, 1 cancelled, 5 total · Time: 23.0s")
  })

  it("adds the cancelled count to the plain summary only when present", () => {
    expect(Reporter.plainSummary(stopped)).toBe("5 targets: 1 hit, 1 ran, 1 failed, 1 skipped, 1 cancelled (23.0s)")
    expect(Reporter.plainSummary(summary)).toBe("4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (23.0s)")
  })
})
