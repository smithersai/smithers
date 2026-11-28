import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import * as AgentRoute from "./AgentRoute.vibe"

test.each([
  [{ code: "inputs", stage: "definition", reason: "inputs" }, "definition: inputs"],
  [{ code: "inputs", stage: "definition", reason: "unrecognized detail" }, "definition"],
  [{ code: "inputs" }, "inputs"],
])("reports bounded workflow admission details", async (response, message) => {
  const result = await Effect.runPromise(Effect.flip(AgentRoute.post(
    AgentRoute.workflowReceipt,
    Effect.succeed(HttpServerResponse.jsonUnsafe(response, { status: 422 })),
    { subject: { kind: "person", id: "test" }, login: "maya", role: null },
    HttpServerRequest.fromWeb(new Request("https://smithers.test/api/repos/acme/widgets/runs", { method: "POST" })),
  )))
  expect(result).toMatchObject({ code: "invalid_params", message })
})
