import { expect, it } from "vitest"
import { blockers, generatedWorkflow } from "../../src/contract/Inventory.vibe"
import { evaluate } from "../../src/inventory/Expression.ts"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"
import { setupCache } from "../../src/inventory/SetupCache.vibe"

const file = ".github/workflows/main.yml"
const actionJob = (job: Record<string, unknown>) =>
  readWorkflow(file, JSON.stringify({ on: "push", jobs: { checks: { steps: [{ run: "true" }], ...job } } })).jobs[0]!

it("withholds keyed literals on a result action", () => {
  for (const mapping of ["with", "env"]) {
    const step = { uses: "codecov/codecov-action@v5", [mapping]: { API_TOKEN: "example-opaque" } }
    const job = actionJob({ steps: [step] })
    expect(JSON.stringify(job)).not.toContain("example-opaque")
    expect(job.unkept?.[0]?.why).toContain("secret")
  }
})

it("retains only result actions whose inputs cannot enforce a verdict", () => {
  for (
    const [uses, name, unsafe, safe] of [
      ["Actions/upload-artifact@v4", "IF-NO-FILES-FOUND", "error", "Warn"],
      ["Codecov/codecov-action@v5", "FAIL_CI_IF_ERROR", true, false]
    ] as const
  ) {
    const result = (held: unknown) => actionJob({ steps: [{ run: "true" }, { uses, with: { [name]: held } }] })
    for (const value of [unsafe, "${{ vars.MODE }}", ["maybe"]]) {
      expect(blockers(result(value)).map((entry) => entry.feature)).toContain("uses")
      expect(result(value).kept).toBeUndefined()
    }
    expect(result(safe).kept?.[0]?.uses).toBe(uses)
  }
})

it("checks whole contexts and member reads", () => {
  const result = (name: string) => actionJob({ steps: [{ uses: "actions/upload-artifact@v4", with: { name } }] })
  expect(result("${{ toJSON(steps) }}").unkept?.[0]?.why).toContain("reads steps")
  expect(result("${{ github.check-suite.head.sha }}").kept).toHaveLength(1)
  expect(result("${{ env ~ }}").unkept?.[0]?.why).toContain("unreadable expression")
})

it("withholds matrix fields assigned to a secret under mixed-case and bracket references", () => {
  for (const value of ["${{ MATRIX.Choice }}", "${{ matrix['CHOICE'] }}"]) {
    const job = actionJob({
      strategy: { matrix: { choice: ["private-example"] } },
      steps: [{ uses: "codecov/codecov-action@v5", with: { token: value } }]
    })
    expect(job.matrix).toEqual([])
    expect(JSON.stringify(job)).not.toContain("private-example")
    expect(blockers(job).map((entry) => entry.feature)).toContain("matrix")
  }
})

it("blocks exhausted and ambiguous matrices and preserves surviving nested scalar types", () => {
  const matrix = (raw: unknown) =>
    actionJob({ strategy: { matrix: raw }, "runs-on": "${{ matrix.row.check && 'linux' || 'macOS' }}" })
  expect(blockers(matrix({ os: ["macos"], exclude: [{ os: "macos" }] })).map((x) => x.detail).join()).toContain(
    "no surviving"
  )
  expect(matrix({ os: ["macos"], exclude: [{ os: "macos" }], include: [{ os: "linux" }] }).matrix).toEqual([{
    os: "linux"
  }])
  expect(blockers(matrix({ value: ["false", false] })).map((x) => x.detail).join()).toContain("same printed values")
  expect(matrix({ include: [{ row: { check: "false" }, n: 1 }, { row: { check: false }, n: 2 }] }).runners).toEqual([
    "linux",
    "macOS"
  ])
  expect(matrix({ include: [{ constructor: "release" }, { category: "test" }] }).matrix).toHaveLength(2)
})

it("matches checkout and setup inputs without case and excludes inherited cache definitions", () => {
  const job = actionJob({ steps: [{ uses: "ACTIONS/CHECKOUT@v4", with: { PATH: "subdir" } }] })
  expect(blockers(job)[0]?.feature).toBe("checkout")
  expect(setupCache("Actions/Setup-Node@v4", { CACHE: "npm" })?.paths).toBe("npm config get cache")
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(setupCache("actions/setup-node@v4", { cache: name })).toBeUndefined()
  }
})

it("leaves external vars unknown and requires a workspace directory separator and valid step id", () => {
  expect(blockers(actionJob({ if: "vars.RUN_CHECK" }))[0]?.detail).toContain("repository variable")
  expect(
    blockers(actionJob({ steps: [{ run: "true", "working-directory": "${{ github.workspace }}-sibling" }] }))[0]
      ?.feature
  ).toBe("working-directory")
  expect(blockers(actionJob({ steps: [{ id: "..", run: "true" }] }))[0]?.feature).toBe("malformed-step")
})

const call = (withInputs: unknown, callee: unknown, job: Record<string, unknown> = {}) => {
  const uses = "./.github/workflows/called.yml"
  return readWorkflow(file, JSON.stringify({ on: "push", jobs: { entry: { uses, with: withInputs, ...job } } }), {
    read: () => JSON.stringify(callee)
  }).jobs
}

it("validates reusable inputs and accepts scalar and list trigger forms", () => {
  const jobs = { child: { steps: [{ run: "true" }] } }
  for (const on of ["workflow_call", ["workflow_call", "workflow_dispatch"]]) {
    expect(call({}, { on, jobs })).toHaveLength(2)
  }
  const on = { workflow_call: { inputs: { count: { required: true, type: "number" }, label: { type: "string" } } } }
  for (
    const [given, why] of [
      [{}, "missing required"],
      [{ count: "2" }, "must be a number"],
      [{ count: 2, extra: true }, "undeclared"],
      [["x"], "must be a mapping"],
      [{ count: "${{ github.sha }}" }, "known only while"],
      [{ count: "${{ vars.N }}" }, "must be a number"]
    ] as const
  ) {
    const result = call(given, { on, jobs })
    expect(result).toHaveLength(1)
    expect(result[0]?.unsupported.some((entry) => entry.detail.includes(why))).toBe(true)
  }
  expect(
    call({}, { on: { workflow_call: { inputs: { bad: null, invalid: { type: "unknown" } } } }, jobs })[0]?.unsupported
  ).toHaveLength(2)
  for (const label of ["${{ 'sample' }}", "${{ github.sha }}"]) {
    expect(call({ count: 3, label }, { on, jobs })).toHaveLength(2)
  }
  const secret = call({ db_token: "${{ 'opaque-example' }}" }, {
    on: { workflow_call: { inputs: { db_token: { type: "string" } } } },
    jobs: { child: { steps: [{ run: "echo ${{ inputs.db_token }}" }] } }
  })
  expect(JSON.stringify(secret)).not.toContain("opaque-example")
  expect(call({ count: "${{ 2 }}", label: "${{ secrets.NAME }}" }, { on, jobs })).toHaveLength(2)
})

it("bounds calls across siblings, reads each path once and enforces nested write limits", () => {
  const uses = "./.github/workflows/other.yml"
  const caller = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["j" + i, { uses, permissions: "read-all" }]))
  let reads = 0
  const definition = {
    on: "workflow_call",
    permissions: "write-all",
    jobs: { inner: { permissions: "write-all", steps: [] } }
  }
  const { jobs } = readWorkflow(file, JSON.stringify({ jobs: caller }), {
    read: () => {
      reads++
      return JSON.stringify(definition)
    }
  })
  expect(reads).toBe(1)
  expect(jobs.filter((job) => job.id.endsWith("/inner"))).toHaveLength(64)
  expect(jobs[1]?.unsupported).toEqual([])
  expect(jobs.at(-1)?.unsupported[0]?.feature).toBe("uses")
})

it("recognizes a hand-written workflow at the reserved path", () => {
  const contents = "jobs: { check: { steps: [] } }"
  expect(readWorkflow(generatedWorkflow, contents).jobs[0]?.generated).toBe(false)
  expect(readWorkflow(generatedWorkflow, "# Generated by smithers-ci. Do not edit.\n" + contents).jobs[0]?.generated)
    .toBeUndefined()
  expect(readWorkflow(file, contents).jobs[0]?.generated).toBeUndefined()
})

it("preserves unexpected errors from the supplied expression context", () => {
  const signal = new Error("context unavailable")
  expect(() =>
    evaluate("github", {
      context: () => {
        throw signal
      }
    })
  ).toThrow(signal)
})

it("deduplicates malformed environment diagnostics inherited by the same job", () => {
  const env = { BAD: ["non-scalar"] }
  const { jobs } = readWorkflow(file, JSON.stringify({ env, jobs: { "the workflow": { env, steps: [] } } }))
  expect(jobs[0]?.unsupported).toEqual([{
    feature: "malformed-env",
    detail: file + ": the workflow sets BAD to a list or mapping"
  }])
})

it("explains malformed result environments and steps inside matrices", () => {
  const malformed = actionJob({ strategy: { matrix: { os: ["linux"] } }, steps: ["not a step"] })
  expect(malformed.unsupported[0]?.feature).toBe("malformed-step")
  const result = actionJob({ steps: [{ uses: "codecov/codecov-action@v5", env: "not a mapping" }] })
  expect(result.unkept?.[0]?.why).toBe("is given a value that is not text")
})

it("omits a setup version when its expression resolves to empty text", () => {
  const doc = {
    on: "push",
    jobs: { sample: { steps: [{ uses: "actions/setup-node@v4", with: { "node-version": "${{ inputs.absent }}" } }] } }
  }
  expect(readWorkflow(file, JSON.stringify(doc)).toolchains[0]).not.toHaveProperty("version")
})

it("preserves an unresolved grouped runner alongside a usable matrix label", () => {
  const expr = "${{ fromJSON(matrix.runner) }}"
  const job = actionJob({
    "runs-on": expr,
    strategy: { matrix: { runner: ["[\"linux\"]", "{\"group\":\"private\"}"] } }
  })
  expect(job.runners).toEqual(["linux", expr])
})

it("refuses incomplete cache definitions and unreadable required restores", () => {
  const cache = (uses: string, inputs: unknown) => actionJob({ steps: [{ uses, with: inputs }] })
  for (const inputs of [{ path: "dist" }, { path: "dist", key: "   " }]) {
    expect(blockers(cache("Actions/Cache@v4", inputs))[0]?.detail).toContain("requires a cache path and key")
  }
  for (const held of [true, { flag: true }, "${{ vars.STRICT }}"]) {
    expect(
      blockers(
        cache("actions/cache/restore@v4", { path: "cache", key: "${{ vars.KEY }}", "fail-on-cache-miss": held })
      )[0]?.detail
    ).toContain("cannot reproduce a required cache restore")
  }
  for (const [uses, strict] of [["actions/cache@v4", false], ["actions/cache/save@v4", true]] as const) {
    expect(blockers(cache(uses, { path: "dist", key: "${{ vars.KEY }}", "fail-on-cache-miss": strict }))).toEqual([])
  }
})
