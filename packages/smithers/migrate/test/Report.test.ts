import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Report from "../src/Report.ts"
import * as Scan from "../src/Scan.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

const generatedAt = "2026-08-28T00:00:00.000Z"

const scanned = (name: string, mode: Report.Mode = "plan") =>
  Effect.gen(function*() {
    const result = yield* Scan.scan(copyFixture(name))
    return Scan.toReport(result, mode, generatedAt)
  }).pipe(Effect.provide(nodeLayer))

describe("Report schema", () => {
  it.effect("round trips through encode and decode without losing a field", () =>
    Effect.gen(function*() {
      const report = yield* scanned("plue-pack")
      const encoded = Schema.encodeUnknownSync(Report.MigrationReport)(report)
      const decoded = Schema.decodeUnknownSync(Report.MigrationReport)(encoded)

      expect(Schema.encodeUnknownSync(Report.MigrationReport)(decoded)).toEqual(encoded)
      expect(decoded.units.map((unit) => unit.id)).toEqual(report.units.map((unit) => unit.id))
    }))

  it.effect("emits JSON that parses and ends with a newline", () =>
    Effect.gen(function*() {
      const report = yield* scanned("jsx-single")
      const json = Report.toJson(report)

      expect(json.endsWith("\n")).toBe(true)
      expect(JSON.parse(json).version).toBe(1)
    }))
})

describe("Report.toMarkdown", () => {
  it.effect("renders the same bytes twice for the same report", () =>
    Effect.gen(function*() {
      const report = yield* scanned("plue-pack")

      expect(Report.toMarkdown(report)).toBe(Report.toMarkdown(report))
    }))

  it.effect("keeps the section order fixed", () =>
    Effect.gen(function*() {
      const report = yield* scanned("plue-pack")
      const sections = Report.toMarkdown(report)
        .split("\n")
        .filter((line) => line.startsWith("## "))

      expect(sections).toEqual([
        "## Summary",
        "## Run state and operator instructions",
        "## Project detection",
        "## Construct inventory",
        "## Mapping decisions",
        "## Units",
        "## Verification",
        "## Manual follow-ups",
        "## Appendix: restoring a checkpoint"
      ])
    }))

  it.effect("prints the operator instructions in the order they must be acted on", () =>
    Effect.gen(function*() {
      const report = yield* scanned("persisted-db")
      const markdown = Report.toMarkdown(report)

      expect(markdown).toContain("1. archive the database")
      expect(markdown).toContain("Run state | history-only")
    }))

  it.effect("says so plainly when there is no run state", () =>
    Effect.gen(function*() {
      const report = yield* scanned("jsx-single")

      expect(Report.toMarkdown(report)).toContain("No Smithers 0.x run state found.")
    }))

  it.effect("escapes a pipe in a cell so the table survives", () =>
    Effect.gen(function*() {
      const base = yield* scanned("jsx-single")
      const report = Report.withUnit(base, {
        id: "workflow:piped",
        kind: "workflow",
        sources: ["a.tsx"],
        targets: ["flows/a/flow.ts"],
        status: "planned",
        changedFiles: [],
        decisions: [{ construct: "Task", choice: "a | b", reason: "either", file: "a.tsx", line: 1 }],
        unresolved: [],
        unsupported: [],
        repairRounds: 0,
        durationMs: 0
      })

      expect(Report.toMarkdown(report)).toContain("a \\| b")
    }))
})

describe("Report.finalize", () => {
  it.effect("exits 0 for a clean plan and 3 for an apply the run state blocks", () =>
    Effect.gen(function*() {
      const clean = yield* scanned("jsx-single", "plan")
      expect(clean.exitCode).toBe(0)

      const blockedPlan = yield* scanned("plue-pack", "plan")
      expect(blockedPlan.exitCode).toBe(0)

      const blockedApply = yield* scanned("plue-pack", "apply")
      expect(blockedApply.exitCode).toBe(3)
    }))

  it.effect("exits 1 when a unit failed", () =>
    Effect.gen(function*() {
      const base = yield* scanned("jsx-single", "apply")
      const failed = Report.finalize(Report.withUnit(base, {
        id: "workflow:simple-workflow",
        kind: "workflow",
        sources: ["simple-workflow.jsx"],
        targets: ["flows/simple-workflow/flow.ts"],
        status: "failed",
        changedFiles: [],
        decisions: [],
        unresolved: [],
        unsupported: [],
        repairRounds: 3,
        durationMs: 10
      }))

      expect(failed.exitCode).toBe(1)
      expect(failed.followUps.some((entry) => entry.text.includes("failed verification"))).toBe(true)
    }))

  it.effect("rolls every unit's unresolved and unsupported entries up", () =>
    Effect.gen(function*() {
      const report = yield* scanned("plue-pack", "apply")

      expect(report.unsupported.map((entry) => entry.construct)).toContain("UI")
      expect(report.followUps.some((entry) => entry.severity === "must" && entry.text.includes("UI"))).toBe(true)
    }))

  it.effect("replaces a unit rather than appending it twice", () =>
    Effect.gen(function*() {
      const base = yield* scanned("jsx-single", "apply")
      const unit = base.units[1]!
      const twice = Report.withUnit(Report.withUnit(base, unit), { ...unit, status: "migrated" })

      expect(twice.units.filter((entry) => entry.id === unit.id)).toHaveLength(1)
      expect(twice.units[1]?.status).toBe("migrated")
    }))
})

describe("Report.write", () => {
  it.effect("writes report.json and report.md into the directory it is given", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const report = yield* scanned("jsx-single")
      const written = yield* Report.write(join(root, ".smithers-migrate"), report).pipe(Effect.provide(nodeLayer))

      expect(written.map((path) => path.split("/").pop())).toEqual(["report.json", "report.md"])
      expect(readFileSync(written[0]!, "utf8")).toBe(Report.toJson(report))
      expect(readFileSync(written[1]!, "utf8")).toBe(Report.toMarkdown(report))
    }))
})

describe("Report.withUnit puts a unit's arrays in a canonical order", () => {
  const entry = (construct: string, file: string, line: number) => ({
    construct,
    reason: "reason",
    file,
    line,
    suggestion: "suggestion"
  })

  const unitWith = (
    sources: ReadonlyArray<string>,
    unresolved: ReadonlyArray<ReturnType<typeof entry>>
  ): Report.UnitReport => ({
    id: "workflow:one",
    kind: "workflow",
    sources,
    targets: [...sources].reverse(),
    status: "migrated",
    changedFiles: sources.map((path) => ({ path, change: "modified" as const, bytes: 1 })),
    decisions: [],
    unresolved,
    unsupported: [],
    repairRounds: 0,
    durationMs: 0
  })

  it("renders the same Markdown for two permutations of the same findings", () => {
    // A report is an audit artifact. Two runs that found the same things have
    // to render the same bytes, whatever order a repair round collected them in.
    const base = Report.empty("/root", "apply", generatedAt)
    const forward = Report.withUnit(
      base,
      unitWith(["b.tsx", "a.tsx"], [entry("Task", "b.tsx", 2), entry("Loop", "a.tsx", 1)])
    )
    const reverse = Report.withUnit(
      base,
      unitWith(["a.tsx", "b.tsx"], [entry("Loop", "a.tsx", 1), entry("Task", "b.tsx", 2)])
    )

    expect(Report.toMarkdown(Report.finalize(forward))).toBe(Report.toMarkdown(Report.finalize(reverse)))
    expect(Report.toJson(Report.finalize(forward))).toBe(Report.toJson(Report.finalize(reverse)))
  })

  it("orders unresolved entries by file, then line, then construct", () => {
    const report = Report.withUnit(
      Report.empty("/root", "apply", generatedAt),
      unitWith([], [
        entry("Zebra", "b.tsx", 1),
        entry("Alpha", "a.tsx", 9),
        entry("Beta", "a.tsx", 9),
        entry("Gamma", "a.tsx", 2)
      ])
    )

    expect(report.units[0]?.unresolved.map((found) => `${found.file}:${found.line}:${found.construct}`)).toEqual([
      "a.tsx:2:Gamma",
      "a.tsx:9:Alpha",
      "a.tsx:9:Beta",
      "b.tsx:1:Zebra"
    ])
  })
})

describe("Report determinism", () => {
  // The bytes, frozen. `Sort` exists because the report is written into a file
  // an operator commits and diffs, so a rendering that moved a line or ordered
  // a list by the machine's locale would show up as a change nobody made. Two
  // runs rendering the same bytes proves repetition, not stability across a
  // change to the renderer; this is the vector that does.
  const report = Report.finalize(
    Report.withUnit(Report.empty("/project", "plan", generatedAt), {
      id: "workflow:hello",
      kind: "workflow",
      sources: ["hello.jsx"],
      targets: ["flows/hello/flow.ts"],
      status: "migrated",
      changedFiles: [{ path: "flows/hello/flow.ts", change: "added", bytes: 42 }],
      decisions: [{ construct: "Task", choice: "Action.make", reason: "the mapping row", file: "hello.jsx", line: 3 }],
      unresolved: [],
      unsupported: [],
      repairRounds: 0,
      durationMs: 1000
    })
  )

  it("renders exactly these Markdown bytes", () => {
    expect(Report.toMarkdown(report)).toBe([
      "# Smithers 0.x to 1.0 migration report",
      "",
      `Generated by @smthrs/migrate ${Report.tool.version} at 2026-08-28T00:00:00.000Z.`,
      "",
      "## Summary",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Project | /project |",
      "| Mode | plan |",
      "| Exit code | 0 |",
      "| Run state | clean |",
      "| Workflow files | 0 |",
      "| Constructs found | 0 |",
      "| Units | 1 |",
      "| Unresolved | 0 |",
      "| Unsupported | 0 |",
      "",
      "## Run state and operator instructions",
      "",
      "No Smithers 0.x run state found. Nothing to finish, archive, or discard.",
      "",
      "None.",
      "",
      "## Project detection",
      "",
      "### Packages",
      "",
      "None.",
      "",
      "### TypeScript configuration",
      "",
      "None.",
      "",
      "### Workflow files",
      "",
      "None.",
      "",
      "### Scripts and configuration",
      "",
      "None.",
      "",
      "### Integrations",
      "",
      "None.",
      "",
      "## Construct inventory",
      "",
      "None.",
      "",
      "## Mapping decisions",
      "",
      "None.",
      "",
      "## Units",
      "",
      "### workflow:hello",
      "",
      "Kind: workflow. Status: migrated. Repair rounds: 0.",
      "",
      "Sources:",
      "",
      "- `hello.jsx`",
      "",
      "Targets:",
      "",
      "- `flows/hello/flow.ts`",
      "",
      "Changed files:",
      "",
      "| Path | Change | Bytes |",
      "| --- | --- | --- |",
      "| flows/hello/flow.ts | added | 42 |",
      "",
      "Decisions:",
      "",
      "| Construct | Choice | Reason | Where |",
      "| --- | --- | --- | --- |",
      "| Task | Action.make | the mapping row | hello.jsx:3 |",
      "",
      "Unresolved:",
      "",
      "None.",
      "",
      "Unsupported:",
      "",
      "None.",
      "",
      "Verification:",
      "",
      "Not run.",
      "",
      "## Verification",
      "",
      "Not run.",
      "",
      "## Manual follow-ups",
      "",
      "None.",
      "",
      "## Appendix: restoring a checkpoint",
      "",
      "None.",
      ""
    ].join("\n"))
  })

  it("writes JSON with a fixed key order, two-space indentation, and a closing newline", () => {
    const json = Report.toJson(report)

    expect(json.startsWith("{\n  \"version\": 1,\n")).toBe(true)
    expect(json.endsWith("\n")).toBe(true)
    expect(Object.keys(JSON.parse(json))).toEqual([
      "version",
      "tool",
      "generatedAt",
      "root",
      "mode",
      "exitCode",
      "project",
      "runState",
      "inventory",
      "mapping",
      "units",
      "unresolved",
      "unsupported",
      "followUps"
    ])
    expect(JSON.parse(json).units).toEqual([{
      id: "workflow:hello",
      kind: "workflow",
      sources: ["hello.jsx"],
      targets: ["flows/hello/flow.ts"],
      status: "migrated",
      changedFiles: [{ path: "flows/hello/flow.ts", change: "added", bytes: 42 }],
      decisions: [{ construct: "Task", choice: "Action.make", reason: "the mapping row", file: "hello.jsx", line: 3 }],
      unresolved: [],
      unsupported: [],
      repairRounds: 0,
      durationMs: 1000
    }])
  })
})
