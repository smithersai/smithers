import { expect, test } from "vitest"
import { appliedRecord, IssueLayoutSync } from "./layout-sync"

const REPOSITORY = "smithersai/smithers"
const finish = (sync: IssueLayoutSync, source: string) => {
  sync.answered(`/api/shapes/${source}`, REPOSITORY, 200, true)
  sync.applied(source, source === "github-writes" ? "*" : REPOSITORY)
}

test("issue counts cannot certify delayed metadata, triage, pending writes or TODO controls", () => {
  const sync = new IssueLayoutSync(REPOSITORY)
  finish(sync, "item-summaries")
  expect(sync.behind()).toEqual(["repository role", "github-sync", "triage-settings", "github-writes"])
  sync.authority("member")
  expect(sync.behind()).toEqual(["github-sync", "triage-settings", "github-writes", "todos"])
  finish(sync, "github-sync")
  finish(sync, "triage-settings")
  sync.answered("/api/shapes/github-writes", null, 200, true)
  sync.applied("github-writes", "*")
  expect(sync.behind()).toEqual(["todos"])
  sync.answered("/api/shapes/todos", REPOSITORY, 200, false)
  sync.answered("/api/shapes/todos", REPOSITORY, 503, true)
  sync.answered("/api/shapes/todos", "someone/else", 200, true)
  expect(sync.behind()).toEqual(["todos"])
  finish(sync, "todos")
  expect(sync.behind()).toEqual([])
  sync.answered("/api/shapes/todos", REPOSITORY, 200, false)
  expect(sync.behind()).toEqual([])
})

test.each([null, "guest", "member", "maintainer", "admin"] as const)("%s waits only for sources the page may read", role => {
  const sync = new IssueLayoutSync(REPOSITORY)
  sync.authority(role)
  for (const source of ["item-summaries", "github-sync", "triage-settings", "github-writes"]) finish(sync, source)
  if (role === null || role === "guest") expect(sync.behind()).toEqual([])
  else expect(sync.behind()).toEqual(["todos"])
})

test("completed downloads cannot certify deferred decoding or persistence, in either receipt order", () => {
  const sync = new IssueLayoutSync(REPOSITORY)
  sync.authority("member")
  for (const source of ["item-summaries", "github-sync", "triage-settings", "github-writes", "todos"]) {
    sync.answered(`/api/shapes/${source}`, REPOSITORY, 200, true)
  }
  expect(sync.behind()).toEqual(["item-summaries", "github-sync", "triage-settings", "github-writes", "todos"])
  sync.applied("todos", "someone/else")
  sync.applied("github-writes", "someone/else")
  expect(sync.behind()).toHaveLength(5)
  for (const source of ["item-summaries", "github-sync", "triage-settings", "github-writes", "todos"]) {
    sync.applied(source, source === "github-writes" ? "*" : REPOSITORY)
  }
  expect(sync.behind()).toEqual([])
  const installedFirst = new IssueLayoutSync(REPOSITORY)
  installedFirst.authority("guest")
  for (const source of ["item-summaries", "github-sync", "triage-settings", "github-writes"]) installedFirst.applied(source, REPOSITORY)
  expect(installedFirst.behind()).toHaveLength(4)
  for (const source of ["item-summaries", "github-sync", "triage-settings", "github-writes"]) finish(installedFirst, source)
  expect(installedFirst.behind()).toEqual([])
})

test("applied console receipts have a fixed name and typed, content-free fields", () => {
  expect(appliedRecord('[00:00] INFO: shape.initial.applied {"source":"todos","repository":"smithersai/smithers"}')).toEqual({ source: "todos", repository: REPOSITORY })
  for (const line of ["other log", "shape.initial.applied bad json", "shape.initial.applied null", 'shape.initial.applied {"source":1}', 'shape.initial.applied {"source":"todos","repository":1}']) expect(appliedRecord(line)).toBeUndefined()
})
