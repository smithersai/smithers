import { describe, expect, it } from "vitest"
import * as Workflow from "../src/GithubWorkflow.ts"

const job = "on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"

describe("workflow boundary defaults", () => {
  it("refuses an empty YAML document with the missing trigger diagnostic", () => {
    expect(() => Workflow.parseWorkflow("")).toThrow("missing the required top-level `on` trigger")
  })

  it("omits an explicitly empty workflow name", () => {
    expect(Workflow.parseWorkflow(`name: ""\n${job}`).name).toBeUndefined()
  })

  it("distinguishes an absent required job from one gated by a condition", () => {
    const workflow = Workflow.parseWorkflow(job)
    expect(Workflow.missingRequiredJobs(workflow, ["check", "absent"])).toEqual(["absent"])
  })

  it("includes quoted arguments in the command span without inventing a command", () => {
    const script = `echo 'pnpm run check'`
    expect(Workflow.commandSpans(script)).toEqual([{ start: 0, end: script.length }])
    expect(Workflow.runsCommand(script, "pnpm run check")).toBe(false)
  })

  it("does not treat an escaped leading word as a known command", () => {
    expect(Workflow.runsCommand("\\pnpm run check", "pnpm run check")).toBe(false)
  })

  it("skips a function containing an empty case before recognizing the outer command", () => {
    const script = "check() { case x in esac; }; pnpm run check"
    expect(Workflow.runsCommand(script, "pnpm run check")).toBe(true)
    expect(Workflow.commandSpans(script).map((span) => script.slice(span.start, span.end)))
      .toEqual(["pnpm run check"])
  })
})
