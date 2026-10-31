import { expect, test } from "vitest"
import { todoPageOf, type TodoCardProps } from "./view"

const card = (fields: Partial<TodoCardProps>): TodoCardProps => ({
  id: "todo-2",
  number: 2,
  title: "Announce search results",
  state: "working",
  prompt: "Announce result counts",
  acceptance: [],
  createdLogin: "tester",
  createdAt: "2026-10-23 15:00:00+00",
  updatedAt: "2026-10-23 15:01:00+00",
  settledAt: null,
  branch: "smithers/t2-search",
  prNumber: null,
  issueNumber: null,
  runId: "todo:6b788f13-01cb-408d-86e6-78da878e0997",
  afterNumber: null,
  waiting: null,
  ...fields,
})

test("a reserved branch is not linked until its pull request exists", () => {
  const working = todoPageOf(card({}), "octo", "hello")
  expect(working).not.toHaveProperty("branch")
  expect(working.run?.label).toBe("Watch")

  const failedBeforePublish = todoPageOf(card({ state: "failed", failure: "implement" }), "octo", "hello")
  expect(failedBeforePublish).not.toHaveProperty("branch")
  expect(failedBeforePublish.run?.label).toBe("Open")
  expect(failedBeforePublish.events.at(-1)?.text).toBe("Implementation failed")

  const published = todoPageOf(card({ state: "in_review", prNumber: 42 }), "octo", "hello")
  expect(published.branch).toEqual({ label: "smithers/t2-search", href: "/octo/hello/tree/smithers/t2-search" })
  expect(published.pullRequest).toEqual({ label: "#42", href: "/octo/hello/pull/42" })
})
