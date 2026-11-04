import { describe, expect, it } from "@effect/vitest"
import { projectFlowsDirectory } from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Scan from "../src/Scan.ts"
import * as Units from "../src/Units.vibe"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

const scan = (root: string, options: Scan.Options = {}) => Scan.scan(root, options).pipe(Effect.provide(nodeLayer))

describe("Units.defaultFlowsDir", () => {
  it("is the registry's project flows directory", () => {
    expect(Units.defaultFlowsDir).toBe(projectFlowsDirectory)
  })
})

describe("Units.flowName", () => {
  it("keeps a pack workflow's position and drops the extension", () => {
    expect(Units.flowName(".smithers/workflows/pipelines/ci-fast.tsx")).toBe("pipelines/ci-fast")
    expect(Units.flowName(".smithers/workflows/ralph.tsx")).toBe("ralph")
    expect(Units.flowName("simple-workflow.jsx")).toBe("simple-workflow")
  })
})

describe("Units.plan over jsx-single", () => {
  it.effect("plans dependencies, one workflow, and the project, in that order", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("jsx-single"))

      expect(result.units.map((unit) => unit.id)).toEqual([
        "dependencies",
        "workflow:simple-workflow",
        "project"
      ])
      expect(result.units.map((unit) => unit.kind)).toEqual(["dependencies", "workflow", "project"])
    }))

  it.effect("attaches the shared library and both prompts to the workflow that uses them", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("jsx-single"))
      const workflow = result.units.find((unit) => unit.id === "workflow:simple-workflow")

      expect(workflow?.sources).toEqual([
        "simple-workflow.jsx",
        "_example-kit.js",
        "prompts/simple-workflow/research.mdx",
        "prompts/simple-workflow/write.mdx"
      ])
      expect(workflow?.targets).toEqual([".smithers/flows/simple-workflow/flow.ts"])
      expect(workflow?.hints.prompt.map((hint) => hint.file)).toEqual([
        "prompts/simple-workflow/research.mdx",
        "prompts/simple-workflow/write.mdx"
      ])
      expect(workflow?.hints.zod.map((hint) => hint.name).sort()).toEqual([
        "approvalSchema",
        "outputSchema",
        "researchSchema"
      ])
    }))

  it.effect("derives the test command from the package script and typechecks every tsconfig", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("jsx-single"))
      const commands = result.units[0]!.verification

      expect(commands.install).toBeUndefined()
      // Derived commands are argv, never a line: the tsconfig path the scanner
      // read off the disk is one argument, whatever characters it carries.
      expect(commands.typecheck).toEqual([Units.argv("tsc", "--noEmit", "-p", "tsconfig.json")])
      expect(commands.test).toEqual(Units.argv("npm", "run", "test"))
      expect(commands.discovery).toEqual({ flowsDir: ".smithers/flows" })
      expect(commands.notes).toEqual([])
    }))

  it.effect("prefers an override over everything it derived", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("jsx-single"), {
        commands: { install: "bun install", test: "bun test tests", typecheck: ["tsc -b"] },
        flowsDir: "workflows"
      })
      const commands = result.units[0]!.verification

      expect(commands.install).toBe("bun install")
      expect(commands.test).toBe("bun test tests")
      expect(commands.typecheck).toEqual(["tsc -b"])
      expect(result.units[1]?.targets).toEqual(["workflows/simple-workflow/flow.ts"])
    }))

  it.effect("reads the install command from a bun packageManager with no lockfile", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>
      manifest["packageManager"] = "bun@1.2.0"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const result = yield* scan(root)

      expect(result.units[0]!.verification.install).toEqual(Units.argv("bun", "install"))
      expect(result.units[0]!.verification.test).toEqual(Units.argv("bun", "run", "test"))
    }))

  it.effect("reads the install command from the lockfile the project has", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      writeFileSync(join(root, "bun.lock"), "{}\n")
      const result = yield* scan(root)

      expect(result.units[0]!.verification.install).toEqual(Units.argv("bun", "install"))
      expect(result.units[0]!.verification.test).toEqual(Units.argv("bun", "run", "test"))
    }))
})

describe("Units.plan over plue-pack", () => {
  it.effect("plans one unit per workflow, in dependency order, then the integrations, then the project", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("plue-pack"))

      expect(result.units.map((unit) => unit.id)).toEqual([
        "dependencies",
        "workflow:implement",
        "workflow:pipelines/ci-fast",
        "workflow:ralph",
        "workflow:release",
        "workflow:review",
        "project"
      ])
    }))

  it.effect("migrates a workflow another one imports before its importer", () =>
    Effect.gen(function*() {
      // Design 5.2 asks for dependency order. `a-first` sorts first by path and
      // imports `z-last`, so path order would rewrite the importer before the
      // flow it points at exists.
      const root = copyFixture("plue-pack")
      writeFileSync(
        join(root, ".smithers/workflows/z-last.tsx"),
        [
          "/** @jsxImportSource smithers-orchestrator */",
          "import { createSmithers } from \"smithers-orchestrator\";",
          "const { Workflow, Task, smithers, outputs } = createSmithers({ value: z.object({ value: z.string() }) });",
          "export const helper = <Task id=\"helper\" output={outputs.value}>{() => ({ value: \"z\" })}</Task>;",
          "export default smithers(() => <Workflow name=\"z-last\">{helper}</Workflow>);"
        ].join("\n")
      )
      writeFileSync(
        join(root, ".smithers/workflows/a-first.tsx"),
        [
          "/** @jsxImportSource smithers-orchestrator */",
          "import { createSmithers } from \"smithers-orchestrator\";",
          "import { helper } from \"./z-last\";",
          "const { Workflow, smithers } = createSmithers({ value: z.object({ value: z.string() }) });",
          "export default smithers(() => <Workflow name=\"a-first\">{helper}</Workflow>);"
        ].join("\n")
      )
      const result = yield* scan(root)
      const ids = result.units.map((unit) => unit.id)

      expect(ids.indexOf("workflow:z-last")).toBeLessThan(ids.indexOf("workflow:a-first"))
      // The walk starts at the lexically first workflow and emits each one
      // after everything it imports, so the order is fixed run to run.
      expect(ids).toEqual([
        "dependencies",
        "workflow:z-last",
        "workflow:a-first",
        "workflow:implement",
        "workflow:pipelines/ci-fast",
        "workflow:ralph",
        "workflow:release",
        "workflow:review",
        "project"
      ])
    }))

  it.effect("reports a workflow import cycle instead of pretending to order it", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      for (const [name, other] of [["cycle-a", "./cycle-b"], ["cycle-b", "./cycle-a"]] as const) {
        writeFileSync(
          join(root, `.smithers/workflows/${name}.tsx`),
          [
            "/** @jsxImportSource smithers-orchestrator */",
            "import { createSmithers } from \"smithers-orchestrator\";",
            `import { helper } from "${other}";`,
            "const { Workflow, Task, smithers, outputs } = createSmithers({ value: z.object({ value: z.string() }) });",
            `export const helper = <Task id="${name}" output={outputs.value}>{() => ({ value: "x" })}</Task>;`,
            `export default smithers(() => <Workflow name="${name}">{helper}</Workflow>);`
          ].join("\n")
        )
      }
      const result = yield* scan(root)
      const ids = result.units.map((unit) => unit.id)
      const notes = result.units.flatMap((unit) => unit.notes)

      // The cycle is broken at the lexically first workflow in it, so the plan
      // is still deterministic, and the operator is told the order is a choice.
      expect(ids.slice(1, 3)).toEqual(["workflow:cycle-b", "workflow:cycle-a"])
      expect(notes.map((note) => note.construct)).toEqual(["workflow import cycle", "workflow import cycle"])
      expect(notes[0]?.reason).toContain("import each other")
      expect(notes[0]?.suggestion).toContain("break the cycle")
    }))

  it.effect("gives a shared component to the first workflow that imports it and to no other", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("plue-pack"))
      const implement = result.units.find((unit) => unit.id === "workflow:implement")
      const review = result.units.find((unit) => unit.id === "workflow:review")

      expect(implement?.sources).toContain(".smithers/components/Review.tsx")
      expect(review?.sources).not.toContain(".smithers/components/Review.tsx")
      expect(review?.sources).toEqual([".smithers/workflows/review.tsx"])
    }))

  it.effect("names the unsafe constructs each unit holds", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("plue-pack"))
      const pipeline = result.units.find((unit) => unit.id === "workflow:pipelines/ci-fast")

      expect(pipeline?.unsafe).toEqual(["UI"])
      expect(result.units.find((unit) => unit.id === "workflow:ralph")?.unsafe).toEqual([])
    }))

  it.effect("reads the test command from smithers.config.ts when it names one", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("persisted-db"))

      expect(result.units[0]!.verification.test).toEqual(Units.argv("bun", "test", "tests"))
      expect(result.units[0]!.notes).toEqual([])
    }))

  it.effect("derives the formatter in check mode, so a verification never rewrites the repository", () =>
    Effect.gen(function*() {
      const dprint = copyFixture("jsx-single")
      writeFileSync(join(dprint, "dprint.json"), "{}\n")
      expect((yield* scan(dprint)).units[0]!.verification.format).toEqual(Units.argv("dprint", "check"))

      const prettier = copyFixture("jsx-single")
      writeFileSync(join(prettier, ".prettierrc"), "{}\n")
      expect((yield* scan(prettier)).units[0]!.verification.format).toEqual(Units.argv("prettier", "--check", "."))

      // The operator's own line is the operator's, shell semantics and all.
      const overridden = yield* scan(dprint, { commands: { format: "dprint fmt" } })
      expect(overridden.units[0]!.verification.format).toBe("dprint fmt")
      expect((yield* scan(copyFixture("jsx-single"))).units[0]!.verification.format).toBeUndefined()
    }))

  it.effect("refuses to run a smithers.config.ts test line that needs a shell, and says what ran instead", () =>
    Effect.gen(function*() {
      // Repository text gets no shell. A configured line that only means
      // something to one is not run as written; the derivation falls back to
      // the package script and the plan says so, with the override that runs
      // the line the operator meant.
      const root = copyFixture("persisted-db")
      writeFileSync(
        join(root, ".smithers", "smithers.config.ts"),
        [
          "export const backend = \"sqlite\";",
          "export const repoCommands = { test: \"bun test tests && rm -rf $HOME\" } as const;",
          "export default { backend, repoCommands };",
          ""
        ].join("\n")
      )
      const result = yield* scan(root)
      const dependencies = result.units[0]!

      expect(dependencies.verification.test).toEqual(Units.argv("npm", "run", "test"))
      expect(dependencies.notes).toHaveLength(1)
      expect(dependencies.notes[0]?.construct).toBe("smithers.config.ts repoCommands.test")
      expect(dependencies.notes[0]?.reason).toContain("needs a shell")
      expect(dependencies.notes[0]?.reason).toContain("`npm run test` ran instead")
      expect(dependencies.notes[0]?.suggestion).toContain("--verify-test")
      // The note is reported once, on the first unit, not on every unit.
      expect(result.units.slice(1).flatMap((unit) => unit.notes)).toEqual([])
    }))

  it.effect("gives the batch-issues pack one workflow unit holding its whole pack", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("batch-issues"))
      const workflow = result.units.find((unit) => unit.kind === "workflow")

      expect(result.units.map((unit) => unit.id)).toEqual([
        "dependencies",
        "workflow:batch-issues/workflow",
        "project"
      ])
      expect(workflow?.targets).toEqual([".smithers/flows/batch-issues/workflow/flow.ts"])
      expect(workflow?.sources.filter((file) => file.includes("/components/"))).toHaveLength(14)
      expect(workflow?.sources.filter((file) => file.endsWith(".mdx"))).toHaveLength(8)
      expect(workflow?.sources).toContain(".smithers/workflows/batch-issues/agents.ts")
      expect(workflow?.sources).toContain(".smithers/workflows/batch-issues/smithers.ts")
    }))

  it.effect("restricts the plan to the unit ids it is given", () =>
    Effect.gen(function*() {
      const result = yield* scan(copyFixture("plue-pack"), { units: ["dependencies", "workflow:ralph"] })

      expect(result.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:ralph"])
    }))
})

describe("Units.plan over a project that is already on 1.0", () => {
  it.effect("plans no workflow unit for the tool's own output", () =>
    Effect.gen(function*() {
      // Running the tool twice has to be safe. The second run plans the two
      // units that are still idempotent work — the dependency edit and the
      // project cleanup — and no workflow unit at all.
      const result = yield* scan(copyFixture("jsx-single.migrated"))

      expect(result.units.map((unit) => unit.id)).toEqual(["dependencies", "project"])
      expect(result.units.some((unit) => unit.kind === "workflow")).toBe(false)
    }))

  it.effect("plans no unit for a 1.0 file sitting beside the 0.x files it was migrated from", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers/workflows"), { recursive: true })
      writeFileSync(
        join(root, ".smithers/workflows/done.tsx"),
        [
          `import { Flow } from "@smthrs/flow"`,
          `import * as Schema from "effect/Schema"`,
          ``,
          `export default Flow.make("done", { payload: Schema.Struct({}), success: Schema.String })`,
          ``
        ].join("\n")
      )

      const result = yield* scan(root)

      // The 0.x workflow still gets its unit; the finished one does not.
      expect(result.units.map((unit) => unit.id)).toEqual([
        "dependencies",
        "workflow:simple-workflow",
        "project"
      ])
    }))
})
