import { expect, test } from "vitest"
import { Migrations } from "@smthrs/effect-tanstack-db"
import { olderLeader, watchLeader } from "./olderLeader"
import { deviceRegistry } from "./registry"

/** issue-writes' version in this build: the cases below hold whatever it is raised to. */
const ISSUE_WRITES = Migrations.declarationOf(deviceRegistry, "issue-writes")!.schemaVersion

// Will's tab on smithers.sh, 2026-10-31: an Arc tab left open on a build from before issue-writes' version 2 led that
// collection, and every newer tab's issue page stayed on "Syncing issue…". Its console said exactly this.
const PRODUCTION = new Error(
  "ensurePersistedIndex failed: Schema version mismatch for collection \"issue-writes\": found 2, expected 1. Refusing to create a persisted index through a stale cached adapter.",
)

test("a leader whose adapter expects a version below this build's runs an older build", () => {
  expect(olderLeader(deviceRegistry, PRODUCTION)).toBe(true)
  // A family member, by its store's declaration.
  expect(olderLeader(deviceRegistry, new Error("Schema version mismatch for collection \"issue-items:github/a/b\": found 3, expected 2."))).toBe(true)
})

test("anything else is not an older leader", () => {
  // The leader runs this build or a newer one: reloading would load this same build again.
  expect(olderLeader(deviceRegistry, new Error(`Schema version mismatch for collection "issue-writes": found 1, expected ${ISSUE_WRITES}.`))).toBe(false)
  expect(olderLeader(deviceRegistry, new Error(`Schema version mismatch for collection "issue-writes": found ${ISSUE_WRITES + 1}, expected ${ISSUE_WRITES + 1}.`))).toBe(false)
  // A collection this build doesn't declare, and other failures.
  expect(olderLeader(deviceRegistry, new Error("Schema version mismatch for collection \"gone\": found 2, expected 1."))).toBe(false)
  expect(olderLeader(deviceRegistry, new Error("leadership route timed out"))).toBe(false)
  expect(olderLeader(deviceRegistry, undefined)).toBe(false)
})

test("each request to the leader tells what it failed with, then fails as it did; answers pass through", async () => {
  const seen: Array<unknown> = []
  const coordinator = watchLeader({
    calls: 0,
    async requestEnsurePersistedIndex() {
      throw PRODUCTION
    },
    async pullSince(from: number) {
      this.calls += 1
      return { from, calls: this.calls }
    },
    async getNodeId() {
      throw new Error("not a request to the leader")
    },
  }, (error) => seen.push(error))
  await expect(coordinator.requestEnsurePersistedIndex()).rejects.toBe(PRODUCTION)
  await expect(coordinator.pullSince(4)).resolves.toEqual({ from: 4, calls: 1 })
  await expect(coordinator.getNodeId()).rejects.toThrow("not a request to the leader")
  expect(seen).toEqual([PRODUCTION])
})
