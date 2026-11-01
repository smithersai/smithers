import { Flow as Durable } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.vibe"
import * as Flow from "../src/Flow.ts"
import * as Markdown from "../src/Markdown.ts"
import * as Placement from "../src/Placement.ts"

const placementOf = (flow: Flow.Any) =>
  Option.getOrUndefined(Annotations.getOption(flow.annotations, Annotations.Placement))

describe("Markdown limits", () => {
  it("keeps a model-invocation restriction on the native flow", () => {
    const flow = Markdown.lowerMarkdown({ name: "hidden", modelInvocable: false }, "Prompt")

    expect(Context.get(flow.annotations, Durable.ModelInvocable)).toBe(false)
    expect(Context.get(flow.flow.annotations, Durable.ModelInvocable)).toBe(false)
  })

  it("leaves an undeclared flow model-invocable", () => {
    const flow = Markdown.lowerMarkdown({ name: "visible" }, "Prompt")

    expect(Context.get(flow.annotations, Durable.ModelInvocable)).toBe(true)
    expect(flow.budget).toBeUndefined()
    expect(flow.sandbox).toBeUndefined()
    expect(flow.flow.deadline).toBeUndefined()
  })

  it("keeps a declared budget", () => {
    const budget = { tokens: 120000, milliseconds: 900000, usd: 2.5, onExceeded: "park" } as const
    const flow = Markdown.lowerMarkdown({ name: "bounded", budget }, "Prompt")

    expect(flow.budget).toEqual(budget)
  })

  it.each(
    [
      ["30 minutes", 1_800_000],
      [1_800_000, 1_800_000]
    ] as const
  )("keeps a declared deadline of %s on the native flow", (deadline, millis) => {
    const flow = Markdown.lowerMarkdown({ name: "timed", deadline }, "Prompt")

    expect(Duration.toMillis(flow.flow.deadline!)).toBe(millis)
  })

  it("keeps a sandbox selection and places the flow in a sandbox", () => {
    const sandbox = {
      provider: "container",
      network: { allow: ["api.github.com"] },
      cpus: 0.5,
      memoryMib: 2048,
      timeoutSecs: 900
    } as const
    const flow = Markdown.lowerMarkdown({ name: "isolated", sandbox }, "Prompt")

    expect(flow.sandbox).toEqual(sandbox)
    expect(placementOf(flow)).toEqual(Placement.sandbox())
  })

  it("accepts a sandbox selection beside an explicit sandbox placement", () => {
    const flow = Markdown.lowerMarkdown({ name: "isolated", placement: "sandbox", sandbox: { provider: "vercel" } }, "")

    expect(flow.sandbox).toEqual({ provider: "vercel" })
    expect(placementOf(flow)).toEqual(Placement.sandbox())
  })

  it("keeps every limit through the combinators that rebuild a flow", () => {
    const lowered = Markdown.lowerMarkdown({
      name: "limited",
      modelInvocable: false,
      budget: { tokens: 10 },
      deadline: "1 hour",
      sandbox: { provider: "directory", network: "none" }
    }, "Prompt")
    const rebuilt = lowered.pipe(
      Flow.within(Placement.sandbox({ image: "node" })),
      Flow.annotate(Annotations.Priority, 3),
      Flow.withFlows(["helper"])
    )

    expect(Context.get(rebuilt.annotations, Durable.ModelInvocable)).toBe(false)
    expect(rebuilt.budget).toEqual({ tokens: 10 })
    expect(Duration.toMillis(rebuilt.flow.deadline!)).toBe(3_600_000)
    expect(rebuilt.sandbox).toEqual({ provider: "directory", network: "none" })
  })

  it("copies the declared budget and sandbox so later edits do not reach the flow", () => {
    const budget = { tokens: 10 }
    const sandbox = { provider: "container" as const, network: { allow: ["example.com"] } }
    const flow = Markdown.lowerMarkdown({ name: "copied", budget, sandbox }, "Prompt")
    budget.tokens = 20
    sandbox.network.allow.push("evil.example")

    expect(flow.budget).toEqual({ tokens: 10 })
    expect(flow.sandbox).toEqual({ provider: "container", network: { allow: ["example.com"] } })
  })

  it.each([
    ["a zero token ceiling", { budget: { tokens: 0 } }, /"refused" budget is invalid/],
    ["a fractional millisecond ceiling", { budget: { milliseconds: 1.5 } }, /"refused" budget is invalid/],
    ["a negative dollar ceiling", { budget: { usd: -1 } }, /"refused" budget is invalid/],
    ["an unknown overrun choice", { budget: { tokens: 1, onExceeded: "ignore" } }, /"refused" budget is invalid/],
    [
      "a budget with no ceiling",
      { budget: { onExceeded: "fail" } },
      /"refused" budget must declare at least one ceiling/
    ],
    ["an unknown sandbox provider", { sandbox: { provider: "docker" } }, /"refused" sandbox is invalid/],
    ["a zero cpu limit", { sandbox: { provider: "container", cpus: 0 } }, /"refused" sandbox is invalid/],
    [
      "a fractional memory limit",
      { sandbox: { provider: "container", memoryMib: 1.5 } },
      /"refused" sandbox is invalid/
    ],
    [
      "a sandbox selection beside another placement",
      { placement: "local", sandbox: { provider: "container" } },
      /"refused" selects a sandbox but is placed local/
    ],
    ["a zero deadline", { deadline: 0 }, /"refused" deadline must be a positive finite duration/]
  ])("refuses %s with a clear error", (_label, fields, message) => {
    expect(() => Markdown.lowerMarkdown({ name: "refused", ...fields } as never, "Prompt")).toThrow(message)
  })
})
