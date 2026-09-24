import { expect, test } from "bun:test"
import { createOperationalFailureReporter } from "./OperationalFailures"

test("operational reports dedupe per subject, expire, bound memory, and reset", () => {
  let now = 0
  const posts: unknown[] = []
  const failures = createOperationalFailureReporter({ now: () => now, ringSize: 2,
    clientErrors: { report: (kind, error) => posts.push({ kind, error }), reported: () => posts.length } })
  for (let i = 0; i < 4; i++) failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(1)
  expect(failures.recent()[0]).toMatchObject({ seam: "run.pump", lost: "app-bug", fault: "infra", subject: "a", count: 4 })
  failures.report("run.pump", new Error("disk"), "b")
  expect(posts).toHaveLength(2)
  now = 60_001
  failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(3)
  expect(failures.recent()).toHaveLength(2)
  failures.reset()
  expect(failures.recent()).toEqual([])
  failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(4)
})

test("reporting survives a broken telemetry sink", () => {
  const failures = createOperationalFailureReporter({ clientErrors: {
    report: () => { throw Error("offline") }, reported: () => 0
  } })
  expect(() => failures.report("run.cancel", new Error("lost"))).not.toThrow()
  expect(failures.recent()).toHaveLength(1)
})
