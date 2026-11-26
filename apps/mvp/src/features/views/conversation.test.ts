import { FlowRuntime } from "@smthrs/flow"
import { Effect, Latch, Scope } from "effect"
import { expect, test } from "vitest"
import { isAgentCall, viewConversation } from "./conversation.vibe"
import { ShowRepo } from "./flows"

const answer = "AA4E8965-192C-408C-89C9-CAF2C522CFC8"
const branch = "c210672e-cbc6-455b-a419-14386c311526"

test.each([
  { executionId: answer, conversationId: undefined, agent: false, place: {} },
  { executionId: answer, conversationId: branch, agent: false, place: { conversationId: branch } },
  { executionId: `${answer}/chat/Respond@1/call/0.0`, conversationId: branch, agent: true, place: { answerId: answer.toLowerCase() } },
  { executionId: "legacy-answer/chat/Respond@1/call/0.0", conversationId: branch, agent: true, place: { conversationId: branch } },
])("chooses the destination for $executionId with conversation $conversationId", async ({ executionId, conversationId, agent, place }) => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    return yield* Effect.all({ place: viewConversation(conversationId), agent: isAgentCall }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, FlowRuntime.FlowInstance.of({
        executionId,
        lineageId: executionId,
        flow: ShowRepo,
        scope,
        suspended: false,
        interrupted: false,
        waiting: undefined,
        handoff: undefined,
        cause: undefined,
        actionState: {
          count: 0,
          latch: Latch.makeUnsafe(),
          nextOrdinal: () => 1,
          snapshots: new Map(),
          keylessInFlight: new Set(),
        },
      })),
    )
  })))
  expect(result).toEqual({ agent, place })
})
