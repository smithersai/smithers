import { expect, it } from "vitest"
import { runQuickstart } from "../examples/quickstart.ts"
import { runServeRpc } from "../examples/serveRpc.ts"

it("joins a resubmitted execution id and refuses it for a different payload", async () => {
  expect(await runQuickstart()).toEqual({
    first: "app.js",
    second: "app.js",
    compiles: 1,
    conflictField: "payload"
  })
})

it("serves a flow over RPC, joins a repeated id, and returns its declared error", async () => {
  expect(await runServeRpc()).toEqual({
    first: "spec-1: approved",
    second: "spec-1: approved",
    reviews: 2,
    rejection: "rejected"
  })
})
