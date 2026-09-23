/** The real Port over the native control host, under Bun, against a fixture project. */
import { afterAll, expect, it } from "bun:test"
import { Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FlowControl from "../src/flow-control.ts"
import { FlowError } from "../src/flows.ts"

const root = join(import.meta.dir, "fixtures", "flows-project")
const stateRoot = mkdtempSync(join(tmpdir(), "tui-flows-"))
const port = FlowControl.make({ cwd: root, environment: {}, stateRoot })
afterAll(async () => {
  await port.dispose()
  rmSync(stateRoot, { recursive: true, force: true })
})

it("discovers flows without importing them", async () => {
  const listed = await port.discover()
  expect(listed.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name)))
    .toEqual([{ name: "echo", description: "Echo" }, { name: "wide", description: "Wide" }])
})

it("reads a module flow's payload schema", async () => {
  const input = await port.input("echo")
  expect(input).toBeDefined()
  expect(Schema.is(input!)({ text: "hi" })).toBe(true)
  expect(Schema.is(input!)({})).toBe(false)
})

it("rejects an unknown flow with a typed error", async () => {
  const error = await port.input("missing").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(FlowError)
  expect((error as FlowError).code).toBe("unknown_flow")
})

it("plans, starts and settles a run from the watch", async () => {
  const card = await port.plan("echo", { text: "hi" })
  expect(card.all).toBe(false)
  const runId = await port.start(card)
  expect(runId).toBeString()
  const events: Array<string> = []
  const settled = await port.watch(runId, (event) => events.push(event.kind)).done
  expect(settled).toEqual({ kind: "done", answer: "hi" })
  expect(events).toContain("control.run.completed")
  expect((await port.events(runId)).length).toBeGreaterThan(0)
  // A retry that finds the run already completed reads its answer from the journal.
  expect(await port.resume(runId)).toEqual({ kind: "done", answer: "hi" })
}, 120_000)

it("marks a * envelope for approval", async () => {
  expect((await port.plan("wide", {})).all).toBe(true)
}, 60_000)

it("settles a run whose input the payload schema rejects as failed", async () => {
  // Planning accepts it (the body cannot be walked); the run itself fails, and the watch says so.
  const runId = await port.start(await port.plan("echo", { text: 3 }))
  const settled = await port.watch(runId, () => {}).done
  // The cause's first line only, never its stack.
  expect(settled).toEqual({ kind: "failed", message: "Schema validation failed" })
}, 60_000)

it("stops a running run through the control plane", async () => {
  const runId = await port.start(await port.plan("echo", { text: "stop" }))
  // `start` returns before the engine drives the run, so the stop lands first.
  await port.cancel(runId)
  expect(await port.watch(runId, () => {}).done).toEqual({ kind: "cancelled" })
  expect((await port.events(runId)).map((event) => event.kind)).toContain("control.run.cancel-requested")
  const error = await port.cancel("missing").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(FlowError)
  expect((error as FlowError).code).toBe("control")
}, 60_000)
