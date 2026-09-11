/*
 * The runner's status discipline: what makes a row pass, fail, or honestly
 * decline — and the fact that a dry run touches nothing.
 */
import { describe, expect, test } from "bun:test"
import { buildReport, exitCodeFor, renderMarkdown, runChecklist, totalsOf } from "./Runner.ts"
import { BrowserUnavailableError, type ChecklistRow, type ProbeContext } from "./Types.ts"

const context = (env: Record<string, string | undefined> = {}): ProbeContext => {
  let clock = 0
  return {
    target: "https://example.test",
    env,
    page: () => Promise.reject(new BrowserUnavailableError("no browser here")),
    fetch: () => Promise.reject(new Error("no network in this test")),
    now: () => (clock += 1),
    sleep: () => Promise.resolve()
  }
}

const row = (overrides: Partial<ChecklistRow> & Pick<ChecklistRow, "probe">): ChecklistRow => ({
  id: "X-1",
  section: "A",
  title: "a row",
  ...overrides
})

describe("runChecklist", () => {
  test("a dry run skips every row without calling any probe", async () => {
    let called = false
    const results = await runChecklist({
      rows: [
        row({
          probe: async () => {
            called = true
            return { status: "pass", detail: "should never run" }
          }
        })
      ],
      mode: "dry-run",
      context: context()
    })
    expect(called).toBe(false)
    expect(results[0]?.status).toBe("skipped-dry-run")
  })

  test("a missing auth env var reports not-testable-yet naming the variable", async () => {
    const results = await runChecklist({
      rows: [row({ requiredEnv: ["CHECKLIST_SESSION_COOKIE"], probe: async () => ({ status: "pass", detail: "" }) })],
      mode: "run",
      context: context({})
    })
    expect(results[0]?.status).toBe("not-testable-yet")
    expect(results[0]?.reasons[0]).toContain("CHECKLIST_SESSION_COOKIE")
  })

  test("a machine with no browser reports not-testable-yet, never a product failure", async () => {
    const results = await runChecklist({
      rows: [
        row({
          browser: true,
          probe: async (ctx) => ({ status: "pass", detail: await ctx.page(undefined).then(() => "") })
        })
      ],
      mode: "run",
      context: context()
    })
    expect(results[0]?.status).toBe("not-testable-yet")
    expect(results[0]?.reasons[0]).toContain("no browser here")
  })

  test("any other throw from a probe is a real failure, not a deferral", async () => {
    const results = await runChecklist({
      rows: [
        row({
          probe: async () => {
            throw new Error("the composer textarea never mounted")
          }
        })
      ],
      mode: "run",
      context: context()
    })
    expect(results[0]?.status).toBe("fail")
    expect(results[0]?.reasons[0]).toContain("never mounted")
  })

  test("a probe's own verdict carries through, with its detail as evidence", async () => {
    const results = await runChecklist({
      rows: [row({ probe: async () => ({ status: "fail", detail: "rating prompt rendered: was this helpful" }) })],
      mode: "run",
      context: context()
    })
    expect(results[0]?.status).toBe("fail")
    expect(results[0]?.evidence[0]).toContain("was this helpful")
  })
})

describe("report shaping", () => {
  test("only a real fail fails the command", () => {
    expect(exitCodeFor(totalsOf([]))).toBe(0)
    expect(
      exitCodeFor({ pass: 3, fail: 0, notTestableYet: 9, probeUndecided: 0, skippedDryRun: 0 })
    ).toBe(0)
    expect(exitCodeFor({ pass: 3, fail: 1, notTestableYet: 0, probeUndecided: 0, skippedDryRun: 0 })).toBe(1)
  })

  test("a probe that ran and still decided nothing fails a real run, never a dry run", async () => {
    const results = await runChecklist({
      rows: [row({ probe: async () => ({ status: "not-testable-yet", detail: "nothing rendered to check" }) })],
      mode: "run",
      context: context()
    })
    const totals = totalsOf(results)
    expect(totals.probeUndecided).toBe(1)
    expect(exitCodeFor(totals, "run")).toBe(2)
    expect(exitCodeFor(totals, "dry-run")).toBe(0)
    // A capability gap (missing env) is not a punt: it stays green.
    const missingEnv = totalsOf(
      await runChecklist({
        rows: [row({ requiredEnv: ["SMITHERS_TEST_MISSING"], probe: async () => ({ status: "pass", detail: "ok" }) })],
        mode: "run",
        context: context()
      })
    )
    expect(missingEnv.probeUndecided).toBe(0)
    expect(exitCodeFor(missingEnv, "run")).toBe(0)
  })

  test("the report keeps the historical shape and renders every row", async () => {
    const results = await runChecklist({
      rows: [row({ probe: async () => ({ status: "pass", detail: "ok" }) })],
      mode: "run",
      context: context()
    })
    const report = buildReport("run", "https://example.test", "2026-08-16T00:00:00.000Z", results)
    expect(report.target).toBe("https://example.test")
    expect(report.totals).toEqual({ pass: 1, fail: 0, notTestableYet: 0, probeUndecided: 0, skippedDryRun: 0 })
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("| X-1 | A | pass | a row |")
    expect(markdown).toContain("Evidence:")
  })
})

describe("row deadlines", () => {
  test("a never-settling probe fails within the deadline and retains progress", async () => {
    const saved: string[][] = []
    let signal: AbortSignal | undefined
    let probeCalled = false
    const running = runChecklist({
      rows: [
        row({ probe: async () => ({ status: "pass", detail: "first" }) }),
        row({ id: "X-2", probe: (ctx: ProbeContext) => {
          probeCalled = true
          signal = ctx.signal
          return new Promise<never>(() => {})
        } }),
        row({ id: "X-3", probe: async () => ({ status: "pass", detail: "last" }) })
      ], mode: "run", context: context(), rowTimeoutMs: 20,
      onProgress: (rows) => { saved.push(rows.map((row) => row.status)) }
    })
    const results = await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runner hung")), 200))])
    expect(results.map((row) => row.status)).toEqual(["pass", "fail", "pass"])
    expect(results[1]?.reasons[0]).toContain("X-2 timed out after 20ms")
    expect(signal?.aborted).toBe(true)
    expect(probeCalled).toBe(true)
    expect(saved).toEqual([["pass"], ["pass", "fail"], ["pass", "fail", "pass"]])
  })

  test("the deadline reaches fetch bodies, page creation, page calls and sleeps", async () => {
    const signals: AbortSignal[] = []
    const results = await runChecklist({
      rows: [row({ probe: async (ctx) => {
        await ctx.sleep(1)
        await (await ctx.page(undefined)).evaluate("1")
        await (await ctx.fetch("https://example.test/stream")).text()
        return { status: "pass", detail: "unreachable" }
      } })], mode: "run", rowTimeoutMs: 20,
      context: { ...context(),
        sleep: async (_ms, signal) => { signals.push(signal!) },
        page: async (_cookie, signal) => {
          signals.push(signal!)
          return { text: async () => "", press: async () => {}, type: async () => {}, reload: async () => {},
            evaluate: async <T>(_expression: string, signal?: AbortSignal) => { signals.push(signal!); return 1 as T }
          }
        },
        fetch: async (_url, init) => {
          signals.push(init!.signal!)
          return new Response(new ReadableStream({ start(controller) {
            init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true })
          } }))
        }
      }
    })
    expect(results[0]?.status).toBe("fail")
    expect(signals).toHaveLength(4)
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
  })
})
