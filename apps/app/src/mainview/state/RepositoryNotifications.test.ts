import { expect, test } from "bun:test"
import { processRepositoryEvents, type RepositoryEvent } from "./RepositoryNotifications"
const event: RepositoryEvent = { source: "github", sourceId: "3", kind: "issue", number: 3, title: "Fix greetings", state: "open", updatedAt: "2026-09-10T00:00:00Z", tags: ["bug"] }
const process = (events: RepositoryEvent[], previous: Parameters<typeof processRepositoryEvents>[3] = []) => processRepositoryEvents("alice", "org/repo", events, previous, 1)
test("deduplicates delivery, tracks announcement separately from read, and announces changed versions", () => {
  const first = process([event, event])
  expect(first.rows).toHaveLength(1)
  expect(first.fresh).toHaveLength(1)
  const announced = { ...first.rows[0]!, announcedVersion: first.rows[0]!.version }
  expect(process([event], [announced]).fresh).toHaveLength(0)
  expect(announced.readVersion).toBeUndefined()
  const read = { ...announced, readVersion: announced.version }
  expect(process([event], [read]).fresh).toHaveLength(0)
  expect(process([{ ...event, updatedAt: "2026-09-11T00:00:00Z" }], [read]).fresh).toHaveLength(1)
})
test("closed baseline is quiet, a newly closed issue is an update, stale events cannot roll back receipts", () => {
  const baseline = process([{ ...event, state: "closed" }])
  expect(baseline.fresh).toHaveLength(0)
  expect(process([{ ...event, state: "closed" }], baseline.rows).fresh).toHaveLength(0)
  const prior = process([event]).rows
  expect(process([{ ...event, state: "closed", updatedAt: "2026-09-11T00:00:00Z" }], prior).fresh).toHaveLength(1)
  expect(process([{ ...event, updatedAt: "2026-09-09T00:00:00Z" }], prior).rows).toHaveLength(0)
})
test("account and repository scopes isolate receipts; source marks read and custom tags survive", () => {
  const first = process([event]).rows[0]!
  const prior = { ...first, announcedVersion: first.version, tags: ["follow-up"] }
  expect(processRepositoryEvents("bob", "org/repo", [event], [prior], 2).fresh).toHaveLength(1)
  expect(processRepositoryEvents("alice", "other/repo", [event], [prior], 2).fresh).toHaveLength(1)
  const read = process([{ ...event, read: true }], [prior])
  expect(read.fresh).toHaveLength(0)
  expect(read.rows[0]!.readVersion).toBe(read.rows[0]!.version)
  expect(read.rows[0]!.tags).toEqual(["follow-up", "bug"])
})
