import { Model, ModelRequest } from "@smthrs/model"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { clientSeat } from "./clientSeat.vibe"

const origin = "https://chat.test"
const request = ModelRequest.ModelRequest.make({
  modelId: "browser-choice",
  system: [],
  messages: [ModelRequest.Message.user("Check this item")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 256 }),
})

test("a client without a host model refuses to prepare a route", async () => {
  const seat = clientSeat(origin, "judge")
  const failure = await Effect.runPromise(Effect.flip(seat.route.prepare(request)))

  expect(failure.code).toBe("no_route")
})

test("a configured client keeps the host model and prepares the seat's request identity", async () => {
  const model = Model.makeNoop()
  const seat = clientSeat(origin, "judge", model)
  const first = await Effect.runPromise(seat.route.prepare(request))
  const second = await Effect.runPromise(seat.route.prepare(request))

  expect(seat.model).toBe(model)
  expect(first).toEqual(second)
  expect(first.url).toBe(origin + "/seats/judge")
  expect(first.method).toBe("POST")
  expect(new TextDecoder().decode(first.body)).toContain("Check this item")
})
