import { Manifest } from "@smthrs/plugin"
import { Effect, Schema } from "effect"
import { expect, test } from "vitest"
import manifest from "../plugin.json" with { type: "json" }
import { projectId } from "../../../src/features/projects/contract"
import { type ProjectSummary, Roster, Summaries } from "../../../src/features/projects/schema"
import { projectsInAttentionOrder } from "./order"

test("the public manifest admits the app home slot and declares the owner-scoped read", async () => {
  const decoded = await Effect.runPromise(Manifest.decode(manifest))
  expect(decoded.contributes?.slots).toMatchObject([{
    slot: "app.home", reads: ["core/projects"], render: { kind: "component", export: "Projects" },
  }])
  expect(decoded.contributes?.views ?? []).toEqual([])
})

test("the shared contract canonicalizes GitHub paths and refuses route escapes", () => {
  expect(projectId("First-Org/Idle.Component")).toBe("first-org/idle.component")
  for (const bad of ["", "../one", "org/..", "org/.", "org/repo/tree", "app/queue", "API/repos", "org/%2e", "org/repo?x", " org/repo"]) {
    expect(projectId(bad), bad).toBeUndefined()
  }
  expect(Schema.decodeUnknownSync(Roster)({ projects: ["one/idle", "two/active"] })).toEqual({ projects: ["one/idle", "two/active"] })
  expect(() => Schema.decodeUnknownSync(Roster)({ projects: ["ONE/idle"] })).toThrow()
})

test("summary counts preserve genuine zero and unavailable as different values", () => {
  const summary = { project: "one/idle", access: "member", openTodos: 0, needsAttention: null, openPlanNodes: 0 }
  const decode = Schema.decodeUnknownSync(Summaries)
  expect(decode({ projects: [summary] })).toEqual({ projects: [summary] })
  expect(() => decode({ projects: [{ ...summary, openTodos: -1 }] })).toThrow()
})

test("known attention sorts by total and name ahead of unavailable attention", () => {
  const summary = (project: string, needsAttention: number | null): ProjectSummary => ({
    project, access: "member", openTodos: 0, openPlanNodes: 0, needsAttention,
  })
  const summaries = [summary("org/d-idle", 0), summary("org/a-unknown", null), summary("org/e-waiting", 2), summary("org/c-waiting", 2)]
  expect(projectsInAttentionOrder(
    ["org/b-unread", ...summaries.map(({ project }) => project)], new Map(summaries.map((row) => [row.project, row])),
  )).toEqual(["org/c-waiting", "org/e-waiting", "org/d-idle", "org/a-unknown", "org/b-unread"])
})
