/**
 * Host seams that run a real turn in Node with no network.
 *
 * The seat replays a committed fixture through `RecordedModel` (or, for a
 * plumbing test, answers every call with one scripted cell), the judge is
 * `ScriptedJudge`, cells run on the Node QuickJS build, and the chain is the
 * deterministic `makeMock` the fixtures were recorded against. Everything
 * between those seams is the code a deployed Worker runs.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import type { SeatProvider } from "@smthrs/create-app/runtime"
import { preparedRequest, replayModelError } from "@smthrs/create-app/testing"
import type { TurnRoute } from "@smthrs/create-app/worker"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { make as makeModel } from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { Fixture } from "@smthrs/testing/Fixture"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { readFileSync } from "node:fs"
import { flows, paneNames } from "../../routes.gen.ts"
import { makeMock } from "../../tools/tevm.ts"
import type { HostSeams } from "../../worker/host.ts"

/** The committed fixture the chat flow replays. */
export const fixtures = {
  chat: new URL("../../flows/chat/fixtures/balance.json", import.meta.url)
} as const

const seatOf = (model: ReturnType<typeof makeModel>): SeatProvider => ({
  resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } })
})

/**
 * A seat that answers every model call with the one cell `source`, whatever
 * the request says. It proves the plumbing around a run, not a model's
 * behavior, so it needs no fixture to stay in step with the prompt.
 */
export const scriptedSeat = (source: string): SeatProvider =>
  seatOf(makeModel({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-start", id: "cell" },
        { type: "text-delta", id: "cell", text: `\`\`\`cell\n${source}\n\`\`\`` },
        { type: "text-end", id: "cell" },
        { type: "settle", stopReason: "stop" }
      ] as unknown as ReadonlyArray<ModelEvent.ModelEvent>)
  }))

/**
 * A seat that replays `fixture`. Each run resolves the seat once and gets a
 * fresh replay, so one set of seams serves any number of turns.
 */
export const recordedSeat = (fixture: URL): SeatProvider => {
  const decoded = Schema.decodeUnknownSync(Fixture)(JSON.parse(readFileSync(fixture, "utf8")))
  return {
    resolve: () =>
      RecordedModel.make(decoded).pipe(
        Effect.map((replay) => ({
          model: makeModel({
            stream: (request) =>
              replay.model.stream(request).pipe(
                Stream.mapError(replayModelError),
                Stream.map((event): ModelEvent.ModelEvent => event)
              )
          }),
          route: { prepare: () => Effect.succeed(preparedRequest) }
        }))
      )
  }
}

/** Seams for one run on `seats`: Node QuickJS, the scripted judge, the mock chain. */
export const nodeHost = (seats: SeatProvider, overrides: HostSeams = {}): HostSeams => ({
  sandboxVariant: QuickJSSandbox.layerVariantLive,
  routes: async () => flows as unknown as ReadonlyArray<TurnRoute>,
  paneNames,
  seats,
  evaluator: ScriptedJudge.layer,
  chain: makeMock(),
  ...overrides
})

/** Seams for runs replaying `fixture`. */
export const recordedHost = (fixture: URL, overrides: HostSeams = {}): HostSeams =>
  nodeHost(recordedSeat(fixture), overrides)
