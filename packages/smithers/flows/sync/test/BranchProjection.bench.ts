/**
 * Projection rebuild throughput. The unit suite checks the rebuild's result;
 * wall-clock cost lives here so a loaded CI host cannot turn it red.
 *
 * Run: `pnpm --filter @smthrs/sync bench`.
 */
import { describe, test } from "vitest"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as TestEntry from "./fixtures/entry.ts"

const branchId = "bench-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)

const entries = Array.from({ length: 10_000 }, (_, seq) =>
  TestEntry.entry(runId, seq, {
    eventId: `event-${seq}`,
    eventType: BranchProtocol.CommandEvent,
    payload: {
      branchId,
      commandId: `c-${seq}`,
      participantId: "alice",
      name: BranchProtocol.SayCommand,
      args: `message ${seq}`,
      target: ""
    }
  }))

describe("BranchProjection", () => {
  test("rebuild 10,000 ordered chat commands", async ({ bench }) => {
    await bench("project", () => {
      BranchProjection.project(branchId, entries)
    }).run()
  })
})
