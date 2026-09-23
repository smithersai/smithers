/**
 * The layout is the one place a string turns into a write. Every path here
 * is one the tool would have joined onto the root and written under, and
 * every one has to be refused before a byte is read.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import * as Options from "@smthrs/migrate/flow/Options"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, parse, resolve, sep } from "node:path"
import { copyFixture, fixture, hashTree, nodeLayer } from "../fixtures/helpers.ts"

const decode = Schema.decodeUnknownSync(Options.MigrateOptions)
const exampleRoot = resolve("/w")

const temporaries: Array<string> = []
const scratch = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-options-${name}-`))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

describe("Options.relativePathIssue", () => {
  it("accepts a plain project-relative directory, Unicode included", () => {
    for (const value of ["flows", "src/flows", ".smithers-migrate", "audit/2026", "flüsse", "流れ", "a-b_c.d"]) {
      expect([value, Options.relativePathIssue("x", value)]).toEqual([value, undefined])
    }
  })

  it("refuses every shape that could leave the root or fold into a reserved directory", () => {
    const refused: ReadonlyArray<[string, RegExp]> = [
      ["", /empty/],
      ["/etc", /absolute/],
      ["../outside", /"\." or "\.\."/],
      ["flows/../..", /"\." or "\.\."/],
      [".", /"\." or "\.\."/],
      ["./flows", /"\." or "\.\."/],
      ["flows/", /end with a slash/],
      ["a//b", /empty segment/],
      ["a\0b", /NUL/],
      ["a\\b", /backslash/],
      [".flows", /must not be "\.flows"/],
      [".flows/state", /must not be "\.flows"/],
      [".git", /must not be "\.git"/],
      [".jj/x", /must not be "\.jj"/],
      ["node_modules/flows", /must not be "node_modules"/],
      ["audit/node_modules", /must not be "node_modules"/],
      ["audit/.git", /must not be "\.git"/],
      ["a/.jj/b", /must not be "\.jj"/],
      ["src/.flows/state", /must not be "\.flows"/]
    ]
    for (const [value, pattern] of refused) {
      expect([value, Options.relativePathIssue("x", value)]).toEqual([value, expect.stringMatching(pattern)])
    }
  })
})

describe("Options.layoutIssue", () => {
  it("refuses a layout path with a reserved directory below its first segment", () => {
    expect(Options.layoutIssue({ root: exampleRoot, layout: { flowsDir: "audit/node_modules" } })).toMatch(
      /node_modules/
    )
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "audit/.git" })).toMatch(/\.git/)
  })

  it("requires a normalized absolute root", () => {
    const root = resolve("/work/project")
    expect(Options.layoutIssue({ root: "relative/project" })).toMatch(/absolute/)
    expect(Options.layoutIssue({ root: `${root}${sep}..${sep}project` })).toMatch(/normalized/)
    expect(Options.layoutIssue({ root: `${root}${sep}` })).toMatch(/normalized/)
    expect(Options.layoutIssue({ root: join(root, "pro\0ject") })).toMatch(/NUL/)
    expect(Options.layoutIssue({ root })).toBeUndefined()
    expect(Options.layoutIssue({ root: parse(root).root })).toBeUndefined()
  })

  it("refuses a report directory and a flows directory that overlap, in either direction and in either normalization", () => {
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "flows", layout: { flowsDir: "flows" } })).toMatch(
      /overlap/
    )
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "flows/report" })).toMatch(/overlap/)
    expect(Options.layoutIssue({ root: exampleRoot, layout: { flowsDir: ".smithers-migrate/flows" } })).toMatch(
      /overlap/
    )
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "audit", layout: { flowsDir: ".smithers-migrate" } }))
      .toMatch(/fixed migration state/)
    expect(
      Options.layoutIssue({ root: exampleRoot, reportDir: "audit", layout: { flowsDir: ".smithers-migrate/flows" } })
    )
      .toMatch(/fixed migration state/)
    // The same directory name spelled with a composed and a decomposed é.
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "caf\u00e9", layout: { flowsDir: "cafe\u0301/flows" } }))
      .toMatch(/overlap/)
    expect(Options.layoutIssue({ root: exampleRoot, reportDir: "audit", layout: { flowsDir: "src/flows" } }))
      .toBeUndefined()
  })

  it("is what the schema refuses, so a payload that decodes is one the flow may join paths onto", () => {
    expect(() => decode({ root: exampleRoot, mode: "plan", reportDir: "../out" })).toThrow(/"\." or "\.\."/)
    expect(() => decode({ root: "w", mode: "plan" })).toThrow(/absolute/)
    expect(() => decode({ root: exampleRoot, mode: "plan", layout: { flowsDir: "/flows" } })).toThrow(/absolute/)
    expect(decode({ root: exampleRoot, mode: "plan", reportDir: "audit", layout: { flowsDir: "src/flows" } })).toEqual({
      root: exampleRoot,
      mode: "plan",
      reportDir: "audit",
      layout: { flowsDir: "src/flows" }
    })
  })
})

describe("Options.validateLayout", () => {
  const validate = (options: Options.MigrateOptions) =>
    Options.validateLayout(options).pipe(Effect.provide(NodeServices.layer))

  it.effect("accepts the persistent project lock state left by a completed apply", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers-migrate"))
      writeFileSync(join(root, ".smithers-migrate", "apply.lock.sqlite"), "")
      writeFileSync(join(root, ".smithers-migrate", "apply.lock.sqlite-journal"), "")
      yield* validate({ root, mode: "apply" })
      yield* validate({ root, mode: "apply", reportDir: "audit" })
    }))

  it.effect("accepts a project whose root is itself reached through a symlink", () =>
    Effect.gen(function*() {
      // `/tmp` is a symlink to `/private/tmp` on macOS, and every fixture copy
      // lives under it: the real root is the reference, not the spelled one.
      const root = copyFixture("jsx-single")
      yield* validate({ root, mode: "plan" })
      // A symlinked report directory that stays inside the project is fine.
      mkdirSync(join(root, "inside"), { recursive: true })
      symlinkSync(join(root, "inside"), join(root, ".smithers-migrate"))
      yield* validate({ root, mode: "plan" })
    }))

  it.effect("refuses a report directory that a symlink already on disk leads out of the project", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outside = scratch("outside")
      symlinkSync(outside, join(root, ".smithers-migrate"))

      const failure = yield* Effect.flip(validate({ root, mode: "plan" }))

      expect(failure.code).toBe("invalid-layout")
      expect(failure.message).toContain("resolves outside the project")
      expect(failure.message).toContain("reportDir")
    }))

  it.effect("refuses a flows directory whose existing ancestor is a symlink out of the project", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outside = scratch("elsewhere")
      mkdirSync(join(root, "src"), { recursive: true })
      symlinkSync(outside, join(root, "src", "generated"))

      const failure = yield* Effect.flip(validate({ root, mode: "plan", layout: { flowsDir: "src/generated/flows" } }))

      expect(failure.code).toBe("invalid-layout")
      expect(failure.message).toContain("layout.flowsDir")
    }))

  it.effect("refuses a root that is not a directory, and a lexical escape before touching the disk", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const file = yield* Effect.flip(validate({ root: join(root, "package.json"), mode: "plan" }))
      expect(file.code).toBe("invalid-layout")
      expect(file.message).toContain("not a directory")

      const lexical = yield* Effect.flip(
        validate({ root, mode: "plan", reportDir: "../escape" } as unknown as Options.MigrateOptions)
      )
      expect(lexical.code).toBe("invalid-layout")
    }))
})

describe("MigrateFlow.layoutConflict", () => {
  it.effect("refuses a report directory or a flows directory that sits under run state, or holds it", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const scanned = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))

      expect(MigrateFlow.layoutConflict(scanned, { root, mode: "apply" })).toBeUndefined()
      expect(MigrateFlow.layoutConflict(scanned, { root, mode: "apply", reportDir: ".smithers/executions/out" }))
        .toMatch(/overlaps the 0\.x run-state path/)
      expect(MigrateFlow.layoutConflict(scanned, { root, mode: "apply", layout: { flowsDir: ".smithers" } }))
        .toMatch(/layout\.flowsDir ".smithers" overlaps/)
    }))

  it.effect("is what the flow's own scan refuses, before the report directory exists", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const before = hashTree(root)

      const failure = yield* Effect.flip(
        MigrateFlow.scan({ root, mode: "plan", reportDir: ".smithers/executions/out" }).pipe(
          Effect.provide(nodeLayer)
        )
      )

      expect(failure.code).toBe("invalid-layout")
      expect(hashTree(root)).toEqual(before)
    }))

  it.effect("skips the report directory when it scans, so the archive of a previous run is never planned again", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // What a previous run with `--report-dir audit` leaves behind: the
      // archived 0.x workflow, which is exactly the file a scan would plan.
      mkdirSync(join(root, "audit", "archive"), { recursive: true })
      writeFileSync(join(root, "audit", "archive", "old-workflow.jsx"), "/** @jsxImportSource smthrs */\n")

      const scanned = yield* MigrateFlow.scan({ root, mode: "plan", reportDir: "audit" }).pipe(
        Effect.provide(nodeLayer)
      )

      expect(scanned.detection.files.some((file) => file.startsWith("audit/"))).toBe(false)
      expect(scanned.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:simple-workflow", "project"])
    }))
})

describe("Options.validateLayout over an existing report directory", () => {
  const validate = (options: Options.MigrateOptions) =>
    Options.validateLayout(options).pipe(Effect.provide(NodeServices.layer))

  it.effect("accepts a directory holding only the tool's own files, and refuses one holding anything else", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, "audit", "units"), { recursive: true })
      writeFileSync(join(root, "audit", "report.md"), "# report\n")
      yield* validate({ root, mode: "plan", reportDir: "audit" })

      // A project directory named as the report directory would be skipped by
      // the scan and then receive the archive: `prompts` holds the workflow's
      // own prompt files.
      const prompts = yield* Effect.flip(validate({ root, mode: "plan", reportDir: "prompts" }))
      expect(prompts.code).toBe("invalid-layout")
      expect(prompts.message).toContain("\"simple-workflow\"")

      const file = yield* Effect.flip(validate({ root, mode: "plan", reportDir: "package.json" }))
      expect(file.code).toBe("invalid-layout")
      expect(file.message).toContain("not a directory")
    }))
})

describe("the fixture root", () => {
  it("is a real directory the tests can symlink into", () => {
    writeFileSync(join(scratch("probe"), "probe.txt"), "ok\n")
    expect(fixture("jsx-single")).toContain("fixtures")
  })
})
