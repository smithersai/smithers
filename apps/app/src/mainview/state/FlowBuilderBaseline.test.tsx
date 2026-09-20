import { afterAll, beforeAll, expect, test } from "bun:test"
import baseline from "./fixtures/FlowBuilderBaseline.json"
import { openFlowBuilderBaseline } from "./fixtures/FlowBuilderBaseline"

let capture: Awaited<ReturnType<typeof openFlowBuilderBaseline>>
beforeAll(async () => { capture = await openFlowBuilderBaseline() })
afterAll(async () => { await capture?.dispose() })

test("flag-off DOM and catalog match frozen pre-feature main", () => {
  const { listing, run, registry, catalog } = baseline
  expect(capture.surface).toEqual({ listing, run, registry, catalog })
})

test("flag-off launch payload and calls match frozen pre-feature main", async () => {
  expect<unknown>(await capture.launch()).toEqual({ calls: baseline.calls, payload: baseline.payload })
})
