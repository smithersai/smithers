import { expect, test } from "vitest"
import { explainShapeFailure } from "./shapeResponse.ts"

test.each([200, 403, 503])("leaves a shape response of %i for the caller's assertions", async (status) => {
  const response = new Response("unchanged", { status })
  await expect(explainShapeFailure(response)).resolves.toBeUndefined()
  expect(await response.text()).toBe("unchanged")
})

test("an invalid shape exposes Electric's diagnostic and correlation headers without consuming the response", async () => {
  const body = JSON.stringify({ message: "Invalid request", errors: { table: ['Table "fixture"."changes" does not exist.'] } })
  const response = new Response(body, {
    status: 400,
    headers: { "content-type": "application/json", "electric-server": "ElectricSQL/test", "x-request-id": "shape-request-123", "set-cookie": "PRIVATE" },
  })
  await expect(explainShapeFailure(response)).rejects.toThrow(
    `Electric shape returned 400: ${JSON.stringify({ "content-type": "application/json", "electric-server": "ElectricSQL/test", "x-request-id": "shape-request-123" })}\n${body}`,
  )
  expect(await response.text()).toBe(body)
})

test("an invalid shape still reports the body when Electric supplies no correlation headers", async () => {
  const response = new Response(new Uint8Array(), { status: 400 })
  await expect(explainShapeFailure(response)).rejects.toThrow(
    'Electric shape returned 400: {"content-type":null,"electric-server":null,"x-request-id":null}\n',
  )
})
