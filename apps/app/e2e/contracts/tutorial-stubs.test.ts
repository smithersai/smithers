import { expect, test } from "bun:test"
import type { Page } from "@playwright/test"
import { LiveTutorialRunSchema } from "@smthrs/rpc/LiveTutorial"
import { stubTutorialHost } from "../playwright/tutorial-stubs"

test("live tutorial test host validates starts and progresses asynchronously through schema-valid snapshots", async () => {
  let handler: (route: any) => Promise<unknown> = async () => undefined
  const page = { on() {}, route(pattern: unknown, fn: typeof handler) { if (pattern === "**/api/tutorial/live/**") handler = fn }, context() { return { route() {} } } } as unknown as Page
  const host = await stubTutorialHost(page, "http://localhost")
  const call = async (method: string, path: string, body?: unknown) => {
    let answer: { status: number; body: string } | undefined
    await handler({ request: () => ({ method: () => method, url: () => `http://localhost/api/tutorial/live/${path}`, postDataJSON: () => body }), fulfill: async (value: typeof answer) => { answer = value } })
    return { status: answer!.status, body: JSON.parse(answer!.body) }
  }
  const planned = await call("POST", "plan", { idempotencyKey: "plan-1", playthrough: 0 })
  expect(planned.status).toBe(202)
  const queued = LiveTutorialRunSchema.parse(planned.body)
  expect(queued.phase).toBe("queued")
  expect(LiveTutorialRunSchema.parse((await call("GET", `run/${queued.runId}`)).body).phase).toBe("running")
  const completed = LiveTutorialRunSchema.parse((await call("GET", `run/${queued.runId}`)).body)
  expect(completed.phase).toBe("completed")
  expect(completed.plan?.steps).toHaveLength(3)
  expect((await call("POST", "implement", { idempotencyKey: "bad", playthrough: 0, planId: "stale" })).status).toBe(409)
  const implementation = LiveTutorialRunSchema.parse((await call("POST", "implement", { idempotencyKey: "implementation", playthrough: 0, planId: completed.plan!.id })).body)
  await call("GET", `run/${implementation.runId}`)
  const done = LiveTutorialRunSchema.parse((await call("GET", `run/${implementation.runId}`)).body)
  expect(done.files?.["src/hello.ts"]).toContain('name || "world"')
  expect(done.commits).toHaveLength(3)
  expect(host.livePolls).toHaveLength(4)
})
