import { Control, ControlError } from "@smthrs/control"
import { waitFor } from "@smthrs/testing/Faults"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { invoke, project, remoteAddress, serverLayer, waitingProject } from "./support/unified-cli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await project()
  roots.push(root)
  return root
}
const value = (result: Awaited<ReturnType<typeof invoke>>) => {
  expect(result.codes, result.stdout + result.stderr).not.toContain(1)
  expect(result.codes, result.stdout + result.stderr).not.toContain(2)
  return JSON.parse(result.stdout)
}
const query = (root: string, sql: string) => {
  const db = new DatabaseSync(join(root, ".flows/control.db"), { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

describe("unified commands with real local stores", () => {
  it("plans the merged input, approves the exact file payload and executes the approved flow", async () => {
    const root = await fixture()
    const at = ["--root", root, "--json"]
    const card = value(
      await invoke(["flow", "plan", "echo", "message=pair", "--data", "{\"message\":\"file wins\"}", ...at])
    )
    expect(card.inputSummary).toBe("{\"message\":\"file wins\"}")
    const file = join(root, "approval.json")
    await writeFile(file, JSON.stringify(card.approval, null, 2) + "\n")
    const approved = value(await invoke(["approvals", "approve", `@${file}`, "--scope", "run", ...at]))
    expect(approved._tag).toBe("Accepted")
    expect(query(root, "SELECT decision, decoded_input_json FROM control_plans")).toEqual([
      expect.objectContaining({ decision: "approved", decoded_input_json: "{\"message\":\"file wins\"}" })
    ])
    const receipt = value(await invoke(["flow", "execute", `@${file}`, ...at]))
    expect(receipt).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
    const shown = value(await invoke(["runs", "show", receipt.runId, ...at]))
    expect(shown).toMatchObject({ runId: receipt.runId, flowId: "echo", status: "completed" })
    const waited = value(await invoke(["runs", "wait", receipt.runId, ...at]))
    expect(waited.status).toBe("completed")
    const resumed = value(await invoke(["runs", "resume", receipt.runId, "--allow-code-drift", ...at]))
    expect(resumed).toMatchObject({ _tag: "Terminal", runId: receipt.runId, status: "completed" })
  }, 120_000)

  it.each(["inline", "file"])("denies a real plan from an %s payload and prevents execution", async (source) => {
    const root = await fixture()
    const at = ["--root", root, "--json"]
    const card = value(await invoke(["flow", "plan", "echo", "--data", "{\"message\":\"do not run\"}", ...at]))
    const contents = JSON.stringify(card.approval)
    await writeFile(join(root, "deny.json"), contents)
    const payload = source === "inline" ? contents : `@${join(root, "deny.json")}`
    value(await invoke(["approvals", "deny", payload, ...at]))
    expect(query(root, "SELECT decision FROM control_plans")).toEqual([expect.objectContaining({ decision: "denied" })])
    const result = await invoke(["flow", "execute", contents, ...at])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("denied")
    expect(query(root, "SELECT run_id FROM flows_runs")).toEqual([])
  }, 120_000)

  it.each([
    ["--budget-tokens", "50", "--budget-ms", "1000", "--on-exceeded", "park"],
    ["--budget-usd", "2.5", "--on-exceeded", "park"],
    ["--deadline", "30 minutes"]
  ])("persists the launch budget from %j", async (...flags) => {
    const root = await fixture()
    const result = await invoke([
      "flow",
      "start",
      "echo",
      "--data",
      "{\"message\":\"budgeted\"}",
      ...flags,
      "--root",
      root,
      "--json"
    ])
    value(result)
    const plans = query(root, "SELECT card_json FROM control_plans") as Array<{ card_json: string }>
    expect(plans).toHaveLength(1)
    expect(query(root, "SELECT decoded_input_json FROM control_plans")).toEqual([
      expect.objectContaining({ decoded_input_json: "{\"message\":\"budgeted\"}" })
    ])
    const budget = JSON.parse(plans[0]!.card_json).envelope.budget
    if (flags[0] === "--budget-tokens") {
      expect(budget).toMatchObject({ tokens: 50, milliseconds: 1000, onExceeded: "park" })
    }
    if (flags[0] === "--budget-usd") expect(budget).toMatchObject({ usd: 2.5, onExceeded: "park" })
    if (flags[0] === "--deadline") expect(budget).toMatchObject({ deadline: 1_800_000 })
  }, 120_000)

  it("reads local flow descriptions and refuses an unknown flow", async () => {
    const root = await fixture()
    const at = ["--root", root, "--json"]
    const listed = value(await invoke(["flow", "list", ...at]))
    expect(listed.items).toContainEqual(
      expect.objectContaining({ flowId: "echo", description: "Return the supplied input" })
    )
    expect(value(await invoke(["flow", "show", "echo", ...at]))).toMatchObject({ flowId: "echo" })
    const missing = await invoke(["flow", "show", "missing", ...at])
    expect(missing.codes).toContain(1)
    expect(missing.stdout).toContain("Unknown flow missing")
  })

  it("answers observing verbs without creating a missing store", async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-empty-observers-"))
    roots.push(root)
    const at = ["--root", root, "--json"]
    expect(value(await invoke(["runs", "list", ...at]))).toMatchObject({ _tag: "runs", items: [] })
    expect(value(await invoke(["runs", "count", ...at]))).toMatchObject({ count: 0 })
    expect(value(await invoke(["approvals", "list", ...at]))).toEqual([])
    expect(value(await invoke(["runs", "logs", "absent", ...at]))).toEqual([])
    const shown = await invoke(["runs", "show", "absent", ...at])
    expect(shown.codes).toContain(1)
    expect(shown.stdout).toContain("run_not_found")
    expect(await readdir(root)).toEqual([])
  })

  it.each([["runs", "logs", "missing", "--limit=0"], ["runs", "logs", "missing", "--limit=10001"], [
    "runs",
    "logs",
    "missing",
    "--limit=1.5"
  ], [
    "flow",
    "execute",
    "@missing-approval.json"
  ]])(
    "refuses invalid input without creating stores: %j",
    async (...args) => {
      const root = await fixture()
      const result = await invoke([...args, "--root", root, "--json"])
      expect(result.codes.some((code) => code !== 0)).toBe(true)
      expect(await readdir(root)).not.toContain(".flows")
    }
  )
})

describe("unified commands over a real local transport", () => {
  it("executes and interrupts the real flow while preserving signal and steering payloads", async () => {
    const root = await waitingProject()
    roots.push(root)
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const at = ["--remote", remote, "--json"]
        const card = value(yield* Effect.promise(() => invoke(["flow", "plan", "wait", "message=exact words", ...at])))
        expect(card.inputSummary).toBe("{\"message\":\"exact words\"}")
        yield* control.approve({ ...card.approval, scope: "run" })
        const receipt = value(
          yield* Effect.promise(() => invoke(["flow", "execute", JSON.stringify(card.approval), ...at]))
        )
        const runId = receipt.runId as string
        yield* Effect.promise(() => waitFor(() => existsSync(join(root, "wait.log")), "real action admission", 15_000))
        expect(readFileSync(join(root, "wait.log"), "utf8")).toBe("exact words\n")
        value(
          yield* Effect.promise(() =>
            invoke(["runs", "signal", runId, "{\"name\":\"wake\",\"payload\":{\"exact\":\"words\"}}", ...at])
          )
        )
        value(yield* Effect.promise(() => invoke(["runs", "steer", runId, "--message", "Keep the exact words", ...at])))
        const logs = value(yield* Effect.promise(() => invoke(["runs", "logs", runId, ...at])))
        expect(logs.filter((event: { kind: string }) => event.kind === "control.signal.admitted")).toHaveLength(1)
        const signals = query(root, "SELECT payload_json FROM control_signal_commands") as Array<
          { payload_json: string }
        >
        expect(signals.map((signal) => JSON.parse(signal.payload_json))).toEqual([{
          name: "wake",
          payload: { exact: "words" }
        }])
        const count = value(yield* Effect.promise(() => invoke(["runs", "count", "--flow", "wait", ...at])))
        expect(count.count).toBe(1)
        value(yield* Effect.promise(() => invoke(["runs", "cancel", runId, ...at])))
        yield* Effect.promise(() =>
          waitFor(
            () => readFileSync(join(root, "wait.log"), "utf8").includes("cancelled"),
            "real action cancellation finalizer",
            15_000
          )
        )
        expect(readFileSync(join(root, "wait.log"), "utf8")).toBe("exact words\ncancelled\n")
        expect(yield* control.list({ _tag: "runs", filters: { runId } })).toMatchObject({
          items: [expect.objectContaining({ runId, status: "cancelled" })]
        })
      }).pipe(Effect.provide(serverLayer(root)), Effect.scoped)
    )
  }, 120_000)

  it("redacts an injected Effect service failure after the real transport and handler", async () => {
    const root = await fixture()
    await Effect.runPromise(
      Effect.gen(function*() {
        const remote = remoteAddress(yield* HttpServer.HttpServer)
        const result = yield* Effect.promise(() => invoke(["flow", "show", "missing", "--remote", remote, "--json"]))
        expect(result.codes).toContain(1)
        expect(result.stdout).toContain("[REDACTED_TOKEN]")
        expect(result.stdout + result.stderr).not.toContain("private-fixture")
      }).pipe(
        Effect.provide(serverLayer(root, (control) =>
          Control.make({
            ...control,
            list: () =>
              Effect.fail(
                new ControlError.TransportError({
                  message: "Authorization: Bearer private-fixture",
                  retryable: false
                })
              )
          }))),
        Effect.scoped
      )
    )
  })
})
