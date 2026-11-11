/**
 * `pause` is gone from the control plane, and this is the gate that keeps it
 * gone.
 *
 * Attributed pause is absent from `1.0.0-rc.0` rather than
 * shipping it half-working: `SqlControlRuntime.pause` flipped the control row
 * to `parked` and released ownership, but it interrupted no fiber and parked no
 * engine run, so the body kept executing until its next fenced write failed.
 * The release scope forbids exactly that appearance, and the ruling was removal
 * rather than an `Unavailable` stub because the consumer inventory found no
 * caller.
 *
 * A removal is only real while nothing puts it back, so the assertions here are
 * negative on purpose: the verb is absent from the RPC group, from the `Control`
 * vtable every transport projects, from both `ControlRuntime` implementations,
 * and from the package's own source. The source scan is the one that catches a
 * re-introduction through a new file, which a type check would happily accept.
 *
 * The prose scan is the same guard one layer out. The vocs page
 * `docs/pages/api/control.md` once carried a `Control.pause` sentence while the
 * member was already gone, and the generated `llms` bundles copied it four more
 * times, so a reader learned a verb the binary refuses. That page was generated
 * from this package. `docs/` and the per-package generators were deleted at
 * rc.0 and the site's pages are hand-authored under `apps/site` now, so the
 * scan covers the prose this package still owns: its `README.md` and its
 * colocated `docs/`. Re-add the published page here the day one is generated
 * from this package again.
 */
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Control, layerNoop } from "../src/Control.vibe"
import { ControlRpcs } from "../src/ControlRpcs.vibe"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import { memoryRuntime } from "./TestStack.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const sourceRoot = join(packageRoot, "src")

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
      ? [join(directory, entry.name)]
      : []
  )

const repositoryRoot = join(packageRoot, "..", "..")

/** The prose this package writes. */
const proseFiles = (): ReadonlyArray<string> => [
  join(packageRoot, "README.md"),
  ...readdirSync(join(packageRoot, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(packageRoot, "docs", entry.name))
]

/**
 * A pause the prose OFFERS, which is the regression. Saying the verb is gone is
 * the opposite of advertising it, so a bare `pause` scan would fail the very
 * sentences that record the removal.
 */
const offeredPause = /\b(?:Control|ControlRuntime|SqlControlRuntime)\.pause\b|\bcontrol\.run\.pause\b/

describe("attributed pause is not part of 1.0.0-rc.0", () => {
  it("serves no Pause procedure", () => {
    expect([...ControlRpcs.requests.keys()]).toEqual([
      "Plan",
      "Run",
      "Approve",
      "Deny",
      "Steer",
      "Signal",
      "Cancel",
      "Resume",
      "List",
      "Watch"
    ])
  })

  it("exposes no pause member on the Control vtable", async () => {
    const members = await Effect.runPromise(
      Effect.map(Effect.service(Control), Object.keys).pipe(Effect.provide(layerNoop))
    )
    expect(members).toEqual([
      "plan",
      "run",
      "approve",
      "deny",
      "steer",
      "signal",
      "cancel",
      "resume",
      "list",
      "watch"
    ])
  })

  it("exposes no pause member on the in-memory control runtime", async () => {
    const members = await Effect.runPromise(
      Effect.map(Effect.service(ControlRuntime), Object.keys).pipe(
        Effect.provide(memoryRuntime()),
        Effect.scoped
      )
    )
    expect(members).not.toContain("pause")
  })

  it("mentions pause nowhere in the published source", () => {
    const offenders = sourceFiles(sourceRoot).filter((file) => /\bpause/i.test(readFileSync(file, "utf8")))
    expect(offenders.map((file) => file.slice(sourceRoot.length + 1))).toEqual([])
  })

  it("offers pause nowhere in the package's prose or its generated API page", () => {
    const offenders = proseFiles().filter((file) => offeredPause.test(readFileSync(file, "utf8")))
    expect(offenders.map((file) => relative(repositoryRoot, file))).toEqual([])
  })
})
