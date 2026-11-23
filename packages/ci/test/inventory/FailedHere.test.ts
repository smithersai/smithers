/** What failed here, taken out of an inventory: a job, a variant, or every variant of a job. */
import { describe, expect, it } from "vitest"
import {
  type FailedHere,
  failsHere,
  type Inventory,
  type Job,
  notReplayed,
  reasonsText,
  variantsFailedHere,
  withoutFailedHere
} from "../../src/contract/Inventory.vibe"

const jobOf = (id: string, matrix: ReadonlyArray<Readonly<Record<string, string>>> = []): Job => ({
  id,
  source: "github-actions",
  file: "ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix,
  steps: [{ id: `${id}0`, command: "true", cwd: "", env: {}, secrets: [] }],
  unsupported: []
})

const inventoryOf = (...jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "test/trial",
  commit: "0".repeat(40),
  toolchains: [],
  jobs
})

describe("what failed here, in an inventory", () => {
  const one = { size: "1" }
  const two = { size: "2" }
  const failed = (job: string, reason: string, variant?: Readonly<Record<string, string>>): FailedHere => ({
    job,
    reason,
    ...(variant === undefined ? {} : { variant })
  })

  it("leaves a job that failed whole out, with the first line of its error", () => {
    const left = notReplayed(withoutFailedHere(inventoryOf(jobOf("a"), jobOf("b")), [failed("a", "no docker")]))
    expect(left).toEqual([{ job: "a", reasons: [{ feature: failsHere, detail: "no docker" }] }])
    expect(reasonsText(left[0]?.reasons ?? [])).toBe("fails-here (no docker)")
  })

  it("takes a variant out of the job's matrix and lists it, whatever order its keys are in", () => {
    const inventory = inventoryOf(jobOf("m", [{ a: "1", b: "2" }, { a: "3", b: "4" }]))
    const gone = [failed("m", "(a=3, b=4) broken", { b: "4", a: "3" })]
    expect(withoutFailedHere(inventory, gone).jobs[0]?.matrix).toEqual([{ a: "1", b: "2" }])
    expect(variantsFailedHere(inventory, gone)).toEqual([
      { job: "m", reasons: [{ feature: failsHere, detail: "(a=3, b=4) broken" }] }
    ])
  })

  it("leaves a job out when every variant failed, and lists it once", () => {
    const inventory = inventoryOf(jobOf("m", [one, two]))
    const gone = [failed("m", "first", one), failed("m", "second", two)]
    expect(notReplayed(withoutFailedHere(inventory, gone))).toEqual([
      { job: "m", reasons: [{ feature: failsHere, detail: "first" }] }
    ])
    expect(variantsFailedHere(inventory, gone)).toEqual([])
  })

  it("prefers the reason of a whole-job failure", () => {
    const gone = [failed("m", "variant", one), failed("m", "whole")]
    expect(notReplayed(withoutFailedHere(inventoryOf(jobOf("m", [one, two])), gone))[0]?.reasons).toEqual([
      { feature: failsHere, detail: "whole" }
    ])
  })

  it("ignores what this commit does not hold", () => {
    const inventory = inventoryOf(jobOf("a"))
    expect(withoutFailedHere(inventory, [failed("gone", "x")])).toEqual(inventory)
    expect(withoutFailedHere(inventory, [])).toEqual(inventory)
    expect(variantsFailedHere(inventory, [failed("gone", "x", one)])).toEqual([])
  })
})
