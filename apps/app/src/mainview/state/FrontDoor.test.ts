import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { visible } from "../flows/registry"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { COMMANDS_MAX, recommendRequest } from "./Recommend"
import { memoryStorage, settled } from "./TestFixtures"

/*
 * The client half of the Jev front door (apps/server frontDoor.ts).
 *
 * Two contracts, both held here against the REAL controller rather than a
 * description of it: every conversation turn carries the visible catalog as
 * data, so the Worker's decision model has options to choose among; and the
 * frames the Worker authors for a routed turn are ordinary tool-loop frames,
 * so the existing execution boundary runs the command (or renders its form)
 * with nothing new on this side. The Worker's minted call id rides straight
 * back out in the continuation leg, which is how the Worker recognises the
 * leg as its own and answers it without a model.
 */

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** The chat transport as the Worker drives it: each turn answers the next script step. */
const scriptedAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const requests: Array<StartAgentTurnRequest> = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      const step = steps[requests.length] ?? steps[steps.length - 1]
      requests.push(request)
      queueMicrotask(() => {
        for (const frame of step?.(request) ?? []) {
          for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
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
  return { agent, requests }
}

/** Exactly what the Worker writes for a routed turn (frontDoor.ts frontDoorFrames). */
const workerRoutedFrames = (command: string, callId = "frontdoor-b0a1") => [
  {
    type: "tool_call" as const,
    call_id: callId,
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name: command })
  },
  { type: "done" as const, reason: "tool_call" as const }
]

describe("the turn request carries the commands the client can execute right now", () => {
  test("a user-only command and one waiting on a requirement are left out; the recommender's pills still carry both", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedAgent([() => [{ type: "done", reason: "stop" }]])
    const controller = createAppController(store, agent)

    controller.send("hello")
    await settled()

    const sent = requests[0]?.commands
    expect(sent).toBeDefined()
    const offered = sent!.map((command) => command.name)
    expect(sent!.length).toBeGreaterThan(0)
    expect(sent!.length).toBeLessThanOrEqual(COMMANDS_MAX)
    // Hidden flows are the agent's business, never the front door's options.
    expect(offered).not.toContain("system.recommend")

    /*
     * The front door answers a turn by EXECUTING what it offers, so an option
     * the client would refuse is not an option. Two axes refuse one:
     * `chat.stop` is the human's own browser mechanic (userOnlyError), and
     * `files.read` waits on the first run's repository choice
     * (unmetRequirements) — the live front door carried all 208 anyway.
     */
    const listed = visible(controller.commands.all()).map((command) => command.name)
    expect(listed).toContain("chat.stop")
    expect(listed).toContain("files.read")
    expect(controller.commands.state().firstRunTargetPending).toBe(true)
    expect(offered).not.toContain("chat.stop")
    expect(offered).not.toContain("files.read")
    // The filter narrows the catalog; it does not empty it.
    expect(offered).toContain("runs.list")

    /*
     * The pills are a different offer: a recommendation is a suggestion the
     * human clicks, and clicking one through the registry is what renders the
     * sign-in step or the first-run choice. So the recommender's list keeps
     * every visible command.
     */
    const pillCommands = recommendRequest({
      repo: null,
      messages: [],
      catalog: controller.commands.all()
    }).commands.map((command) => command.name)
    expect(pillCommands).toContain("chat.stop")
    expect(pillCommands).toContain("files.read")
  })
})

describe("the Worker-authored frames drive the client's own execution boundary", () => {
  test("a routed command runs through the registry, and the continuation leg returns the Worker's call id", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedAgent([
      () => workerRoutedFrames("world.new-note"),
      () => [{ type: "done", reason: "stop" }]
    ])
    const controller = createAppController(store, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    // The command really ran: the note is in the store, not a promise about one.
    const notes = [...store.collections.worldDocuments.values()].filter((document) =>
      document.path.startsWith("Untitled")
    )
    expect(notes.length).toBe(1)

    // The continuation leg carries the Worker's own call id back out, which is
    // the whole recognition the Worker needs to answer it without a model.
    expect(requests.length).toBe(2)
    expect(requests[1]?.messages.filter((message) => "type" in message)).toEqual([
      {
        type: "function_call",
        call_id: "frontdoor-b0a1",
        name: "commands",
        arguments: JSON.stringify({ action: "execute", name: "world.new-note" })
      },
      { type: "function_call_output", call_id: "frontdoor-b0a1", output: "executed /world.new-note" }
    ])
  })

  test("the act is the answer: one act line on screen, and the next turn reads it as the assistant's words", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedAgent([
      () => workerRoutedFrames("world.new-note"),
      // What the Worker now writes for its own continuation leg: no text.
      () => [{ type: "done", reason: "stop" }],
      () => [{ type: "delta", kind: "text", text: "Sure." }, { type: "done", reason: "stop" }]
    ])
    const controller = createAppController(store, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    /*
     * One row, and it is the act line. No bubble echoing the command under
     * it, and no "Smithers Cloud returned an empty response" either — the
     * leg ended without text because the act had already answered.
     */
    const messages = [...store.collections.messages.values()]
    expect(messages.filter((message) => message.role === "smithers" && message.act === undefined)).toEqual([])
    expect(messages.filter((message) => message.act !== undefined).map((message) => message.text))
      .toEqual(["Smithers ran /world.new-note"])
    expect(store.session().phase).toBe("idle")

    /*
     * The live defect this pins: a routed turn left NO trace in the next
     * turn's transcript, so the concierge read the user's question as still
     * unanswered and re-attacked it with the same command, turn after turn.
     */
    controller.send("thanks")
    await settled()
    expect(requests.length).toBe(3)
    expect(requests[2]?.messages).toEqual([
      { role: "user", content: "make me a note" },
      { role: "assistant", content: "Smithers ran /world.new-note" },
      { role: "user", content: "thanks" }
    ])
  })

  test("a refused act is remembered as the refusal it really got, never as a success", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedAgent([
      () => workerRoutedFrames("flow.list"),
      () => [{ type: "done", reason: "stop" }],
      () => [{ type: "delta", kind: "text", text: "Sure." }, { type: "done", reason: "stop" }]
    ])
    const controller = createAppController(store, agent)

    controller.send("show me my flows")
    await settled()
    await settled()
    controller.send("why not?")
    await settled()

    /*
     * Signed out, the registry refuses this one. The echo the Worker used to
     * write said "/flow.list" under that refusal and read as success; the
     * memory now carries the refusal itself, so the next turn answers the
     * user instead of firing the same command again.
     */
    const refusal = "Smithers tried /flow.list — failed: Sign in with GitHub first: flows run on your own workspace."
    expect([...store.collections.messages.values()].filter((message) => message.act !== undefined)
      .map((message) => message.text)).toEqual([refusal])
    expect(requests[2]?.messages).toEqual([
      { role: "user", content: "show me my flows" },
      { role: "assistant", content: refusal },
      { role: "user", content: "why not?" }
    ])
  })

  test("a routed command that needs an argument renders its form instead of running", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedAgent([
      () => workerRoutedFrames("browser.open"),
      () => [{ type: "done", reason: "stop" }]
    ])
    const controller = createAppController(store, agent)

    controller.send("open example.com")
    await settled()
    await settled()

    const output = requests[1]?.messages.find(
      (message): message is { type: "function_call_output"; call_id: string; output: string } =>
        "type" in message && message.type === "function_call_output"
    )
    expect(output?.output).toStartWith("rendered a form for")
    // The form card is on screen, which is what the missing argument buys.
    expect(store.collections.cards.get("form-browser.open")?.kind).toBe("flow-form")
  })
})
