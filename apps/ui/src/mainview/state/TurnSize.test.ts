import { describe, expect, test } from "bun:test"
import type { AgentChatMessage, AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { MAX_TOOL_RESULT_BYTES, MAX_TURN_REQUEST_BYTES, turnRequestBytes, utf8Bytes } from "./AgentTurnPolicy"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, recordingAgent, settled, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/** `AgentChatMessage` is a union: a chat turn, or a tool call/result item. */
const textOf = (message: AgentChatMessage | undefined): string =>
  message !== undefined && "content" in message ? message.content : ""

/*
 * §4.13 — the conversation the client sends is bounded, so a long one cannot
 * kill the seam for good.
 *
 * The size policy in AgentTurnPolicy.ts was written, unit-tested, and never
 * called: `contextMessages()` handed the WHOLE transcript to every turn. On
 * canary, seven long answers crossed the boundary's body limit and every turn
 * after that failed identically — `say ok` included, and `/clear` included,
 * because /clear runs a model turn of its own. This pins the wiring, not the
 * policy: the request that actually leaves the client is the thing under test.
 */

/** An agent double that records every turn request and ends the turn fast. */
describe("a long conversation still sends a turn the boundary accepts", () => {
  test("the turn is bounded, the newest prompt survives, and the drop is stated", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    // Six long turns is roughly where canary crossed the limit.
    for (let turn = 0; turn < 6; turn += 1) {
      controller.send(`turn ${turn} ${"w".repeat(15_000)}`)
      await settled()
    }
    controller.send("say ok")
    await settled()

    const last = requests.at(-1)
    expect(last).toBeDefined()
    expect(turnRequestBytes(last as StartAgentTurnRequest)).toBeLessThanOrEqual(
      MAX_TURN_REQUEST_BYTES
    )
    expect(textOf(last?.messages.at(-1))).toBe("say ok")
    expect(textOf(last?.messages[0])).toContain("dropped to fit this turn's size limit")
  })

  test("a short conversation is sent whole, with no notice invented", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("hello")
    await settled()

    expect(requests[0]?.messages).toHaveLength(1)
    expect(textOf(requests[0]?.messages[0])).toBe("hello")
  })
})

/*
 * The tool-result bound had the same history as the turn bound: written,
 * unit-tested, and never called. The continuation leg posted whatever the
 * command returned as the function_call_output, so one wide tool result could
 * fill the next request by itself. This pins the wiring at the seam.
 */
describe("a wide tool result is bounded before it goes back to the model", () => {
  /** A transport double that answers with a scripted tool call, then ends. */
  const toolCallingAgent = (
    requests: StartAgentTurnRequest[],
    call: Omit<Extract<AgentTurnFrame, { type: "tool_call" }>, "runId">
  ): AgentPort => {
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    return {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames: ReadonlyArray<AgentTurnFrame> = requests.length === 1
          ? [{ ...call, runId: request.runId }, { type: "done", runId: request.runId, reason: "tool_call" }]
          : [{ type: "done", runId: request.runId, reason: "stop" }]
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener(frame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  test("the function_call_output is cut to the tool-result limit with the marker, the record keeps it whole", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    // An unknown command echoes its name in the honest error, so a very long
    // name is a deterministic, registry-free way to get a wide tool result.
    const name = "n".repeat(MAX_TOOL_RESULT_BYTES + 4_096)
    const controller = createAppController(
      store,
      unavailableRepositories,
      toolCallingAgent(requests, {
        type: "tool_call",
        call_id: "call_wide",
        name: "commands",
        arguments: JSON.stringify({ action: "execute", name })
      })
    )

    controller.send("run the wide thing")
    await settled()
    await settled()

    expect(requests).toHaveLength(2)
    expect(turnRequestBytes(requests[1] as StartAgentTurnRequest)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    const output = requests[1]?.messages.find(
      (message): message is Extract<AgentChatMessage, { type: "function_call_output" }> =>
        "type" in message && message.type === "function_call_output"
    )
    expect(output).toBeDefined()
    expect(utf8Bytes(output?.output ?? "")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)
    expect(output?.output).toStartWith("unknown-command: nnn")
    expect(output?.output).toContain("[Tool result truncated:")
    // The store's own record is the evidence and stays whole.
    const recorded = [...store.collections.toolCalls.values()].at(-1)
    expect(recorded?.result).toBe(
      `unknown-command: ${name} — no command has that name; use the list action for every command callable right now`
    )
    controller.dispose()
  })
})
