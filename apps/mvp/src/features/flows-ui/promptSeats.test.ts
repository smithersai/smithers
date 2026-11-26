import { SeatResolver } from "@smthrs/agent"
import { Model } from "@smthrs/model"
import { Effect, Exit } from "effect"
import { expect, test } from "vitest"
import { DRAFT_MODEL_ROLE, FLOW_MODEL_ROLE } from "./contract"
import { promptSeats } from "./promptSeats.vibe"

test("a personal flow host resolves only its declared prompt roles", async () => {
  const model = Model.makeNoop()
  const seats = promptSeats("https://example.test", model)
  const resolve = (id: string) => Effect.flatMap(SeatResolver.SeatResolver, (resolver) => resolver.resolve(id)).pipe(
    Effect.provide(seats),
  )

  for (const id of new Set([DRAFT_MODEL_ROLE, FLOW_MODEL_ROLE])) {
    expect(await Effect.runPromise(resolve(id))).toMatchObject({
      id, modelId: id, model, contextWindowTokens: 32_768,
    })
  }
  const refused = await Effect.runPromiseExit(resolve("unconfigured-role"))
  expect(Exit.findErrorOption(refused)).toMatchObject({
    _tag: "Some",
    value: {
      _tag: "@smthrs/agent/Seat/SeatUnresolved",
      seat: "unconfigured-role",
      message: "No model seat is configured.",
    },
  })
})
