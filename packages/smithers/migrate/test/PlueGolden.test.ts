/**
 * The coverage proof: the scanners run read only over a real, unsanitized 0.x
 * pack that nobody trimmed for them, and every name they find resolves to a
 * catalog row or is reported as one that does not.
 *
 * The pack is named by `SMITHERS_MIGRATE_PLUE_PACK`, the working tree of an
 * external project. The test never copies it, never writes to it, and skips
 * when the variable is unset or names a directory that is not on this machine,
 * so the suite stays green on a checkout that has no such pack beside it. The
 * variable is the only way in: a default path would be one contributor's home
 * directory shipped in a published package, and a machine that happened to
 * match it would run a different test from everyone else's.
 *
 * The scan runs once for the whole file. A pack this size is the tool's real
 * unit of work, not a per-assertion fixture.
 *
 * @since 0.1.0
 */
import { beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { existsSync } from "node:fs"
import * as Constructs from "../src/Constructs.ts"
import * as Detect from "../src/Detect.ts"
import * as Inventory from "../src/Inventory.vibe"
import * as Mapping from "../src/Mapping.ts"
import { nodeLayer } from "./fixtures/helpers.ts"

const root = process.env["SMITHERS_MIGRATE_PLUE_PACK"] ?? ""
const present = root !== "" && existsSync(root)

let detection: Detect.Detection
let hits: ReadonlyArray<Inventory.InventoryEntry>

beforeAll(async () => {
  if (!present) return
  const scanned = await Effect.runPromise(
    Effect.gen(function*() {
      const found = yield* Detect.scan(root)
      return { detection: found, hits: yield* Inventory.scan(found) }
    }).pipe(Effect.provide(nodeLayer))
  )
  detection = scanned.detection
  hits = scanned.hits
})

describe.skipIf(!present)("golden inventory over the real Plue pack", () => {
  it("reads the pack's source and not its run state", () => {
    // The pack holds 917 MB of execution logs and 81,864 worktree files beside
    // its source. A walk that reads them is a walk that cannot finish.
    expect(detection.files.some((file) => file.startsWith("executions/"))).toBe(false)
    expect(detection.files.some((file) => file.includes("/.worktrees/"))).toBe(false)
    expect(detection.files.length).toBeLessThan(5_000)
  })

  it("has a mapping row for every name the pack imports, or reports it", () => {
    const reported = new Set(
      detection.warnings
        .filter((warning) => warning.code === "uncatalogued-import")
        .map((warning) => warning.message.split("\"")[1])
    )

    const dropped = [
      ...new Set(
        detection.imports
          .filter((hit) => hit.kind === "old" && !hit.typeOnly)
          .flatMap((hit) => hit.names.map((binding) => binding.imported))
          .filter((name) => name !== "default")
      )
    ].filter((name) => Mapping.byImport(name) === undefined && !reported.has(name))

    expect(dropped).toEqual([])
  })

  it("has a mapping row for every construct the inventory records", () => {
    const unmapped = [...new Set(hits.map((hit) => hit.construct))]
      .filter((construct) => Mapping.byConstruct(construct) === undefined)
      .sort()

    expect(unmapped).toEqual([])
  })

  it("has a catalog prop for every prop the pack writes on a catalog component", () => {
    // `key` and `children` are React's, not a component's: React accepts them
    // on every element whether or not the old props file named them.
    const intrinsic = new Set(["key", "children"])
    const unknown = new Set<string>()
    for (const hit of hits) {
      const construct = Constructs.byName(hit.construct)
      if (construct?.kind !== "component") continue
      const declared = construct.props ?? []
      for (const prop of hit.props) {
        if (intrinsic.has(prop) || declared.includes(prop)) continue
        unknown.add(`${hit.construct}.${prop}`)
      }
    }

    // A prop the catalog misses is a prop no class escalation can see, which is
    // how a `skipIf` or a `maxConcurrency` slips through as automatic. The
    // catalog reads its props out of the old `<Name>Props.ts` files, so this
    // list is empty and stays empty.
    expect([...unknown].sort()).toEqual([])
  })

  it("inventories the 0.x half of a mixed file and reports the other half", () => {
    // `workflows/issue-pipeline.tsx` takes `createSmithers`, `Sequence`, and
    // `Parallel` from `@smithers-ai/workflow` and its agents and `Worktree`
    // from `smithers-orchestrator`. The foreign factory's `Workflow` and `Task`
    // are not 0.x components and are not inventoried as such.
    const file = "workflows/issue-pipeline.tsx"
    const mixed = detection.warnings.filter((warning) => warning.code === "mixed-authoring-api")

    expect(mixed.map((warning) => warning.file)).toContain(file)
    expect(hits.some((hit) => hit.file === file && hit.construct === "Workflow")).toBe(false)
    expect(hits.some((hit) => hit.file === file && hit.construct === "Worktree")).toBe(true)
  })

  it("finds real work: workflows, prompts, agents, and constructs", () => {
    expect(detection.workflowFiles.length).toBeGreaterThan(10)
    expect(detection.prompts.length).toBeGreaterThan(5)
    expect(hits.filter((hit) => hit.construct === "Task").length).toBeGreaterThan(20)
    expect(hits.some((hit) => hit.construct.startsWith("ctx."))).toBe(true)
    expect(hits.some((hit) => hit.construct === "outputs.<key>")).toBe(true)
  })
})

describe.skipIf(present)("golden inventory over the real Plue pack", () => {
  it("is skipped because the pack is not on this machine", () => {
    // The suite has to stay green off this machine. `describe.skipIf` above
    // holds the assertions; this states why they did not run.
    expect(existsSync(root)).toBe(false)
  })
})
