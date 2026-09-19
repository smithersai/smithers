import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as Ids from "../src/Ids.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

const directory = "/repo"
const sessionID = "ses_ffffffffeffe00000000000000"
const userMessageID = "msg_0000000010010000000000000a"
const assistantMessageID = "msg_0000000010020000000000000b"

const session: Protocol.Session = {
  id: sessionID,
  slug: "quiet-harbor",
  projectID: "p",
  directory,
  path: "",
  title: "New session - 2026",
  version: "test",
  agent: "smithers",
  model: { id: "demo", providerID: "scripted" },
  cost: 0,
  tokens: Protocol.noTokens,
  time: { created: 1000, updated: 1000 }
}

const clock = () => {
  let now = 1000
  return () => (now += 1)
}

const opened = (): Projection.Opened => ({
  session,
  userMessageID,
  userPartID: Ids.part(userMessageID, { frame: 0, slot: 0, ordinal: 0 }),
  assistantMessageID,
  prompt: "Read package.json and tell me the name field.",
  agent: "smithers",
  model: { providerID: "scripted", modelID: "demo" }
})

const scriptEvents = (): Array<AgentEvent.AgentEvent> => {
  const script = DemoScript.script({ sessionID, messageID: assistantMessageID, prompt: "p" })
  const out: Array<AgentEvent.AgentEvent> = []
  for (const segment of script.segments) {
    if (segment._tag === "events") out.push(...segment.events)
    else {
      out.push(
        new AgentEvents.PermissionRequired({
          eventType: "flows.harness.permission-required.v1",
          request: segment.request
        }),
        new AgentEvents.Suspended({
          eventType: "flows.harness.suspended.v1",
          reason: { code: "permission-required", message: "park" } as never
        }),
        ...segment.allowed
      )
    }
  }
  return out
}

/**
 * Every tool card the demo turn writes, plus one health card. Health lands
 * only on a color change and the demo script carries no evaluation, so the
 * decision is folded in here.
 */
const cards = (): ReadonlyArray<Protocol.ToolPart> => {
  const ctx = { directory, now: clock() }
  let step = Projection.open(ctx, opened())
  const emitted: Array<Protocol.Emitted> = [...step.events]
  for (const event of scriptEvents()) {
    step = Projection.fold(ctx, step.state, event)
    emitted.push(...step.events)
  }
  const decided = Projection.decided(
    ctx,
    { ...step.state, closed: false },
    { color: "red", reason: "needs you: approve the write" },
    {
      progress: {
        value: 3,
        label: "verifying",
        probabilities: { stuck: 0.05, exploring: 0.05, progressing: 0.1, verifying: 0.75, done: 0.05 },
        confidence: 0.75
      },
      stuck: { value: false, probability: 0.1 },
      needsHuman: { value: true, probability: 0.91 }
    }
  )
  return [...emitted, ...decided.events]
    .filter((event) => event.type === "message.part.updated")
    .map((event) => event.properties["part"] as Protocol.Part)
    .filter((part): part is Protocol.ToolPart => part.type === "tool")
}

const inputOf = (card: Protocol.ToolPart): Record<string, unknown> => card.state.input

const metadataOf = (card: Protocol.ToolPart): Record<string, unknown> =>
  card.state.status === "pending" ? {} : card.state.metadata ?? {}

const labelKeys = ["description", "query", "url", "filePath", "path", "pattern", "name"]

/**
 * What the hosted app puts in a collapsed generic card's subtitle: `label`
 * in packages/session-ui/src/components/basic-tool.tsx takes the first
 * non-empty string among these keys. `GenericTool` in the same file passes
 * no children, so the card has no expanded body at all and a reason that
 * lives only in the card's `title` is never shown.
 */
const appSubtitle = (input: Record<string, unknown>): string | undefined =>
  labelKeys.map((key) => input[key]).find((value): value is string => typeof value === "string" && value.length > 0)

/**
 * What the hosted app puts after the subtitle: `args` in the same file, the
 * first three remaining scalar entries as `key=value`.
 */
const appArgs = (input: Record<string, unknown>): ReadonlyArray<string> =>
  Object.entries(input)
    .filter(([key]) => !labelKeys.includes(key))
    .flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [`${key}=${value}`]
        : []
    )
    .slice(0, 3)

/**
 * The whole line the TUI shows for a generic card: `input` in
 * packages/tui/src/routes/session/index.tsx renders every scalar entry of
 * the input, in insertion order, untruncated, and never reads the title.
 */
const tuiLine = (card: Protocol.ToolPart): string => {
  const entries = Object.entries(card.state.input).filter(([, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  )
  const rendered = entries.length === 0 ? "" : `[${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`
  return `# ${card.tool} ${rendered}`
}

const firstCard = (tool: string, status?: Protocol.ToolState["status"]): Protocol.ToolPart => {
  const found = cards().filter((card) => card.tool === tool && (status === undefined || card.state.status === status))
  expect(found.length).toBeGreaterThan(0)
  return found[0]!
}

describe("the cards this server invents", () => {
  /**
   * design.html section 3.3 wants a color change legible at a glance with
   * its reason. Neither client reads a generic card's title and the app's
   * generic card has no expanded body, so the card read "Called health"
   * over "color=red" and the reason was nowhere.
   */
  it("lead the health card with the reason, not the color it came from", () => {
    const card = firstCard("health")
    expect(appSubtitle(inputOf(card))).toBe("needs you: approve the write")
    expect(appArgs(inputOf(card))).toEqual(["color=red"])
    expect(tuiLine(card)).toBe("# health [description=needs you: approve the write, color=red]")
  })

  /**
   * The cell card carried the whole frame program in its collapsed line,
   * because the TUI renders every scalar of the input. The program is the
   * card's structured detail, not its headline.
   */
  it("lead the cell card with the frame and what it did", () => {
    const running = firstCard("cell", "running")
    expect(appSubtitle(inputOf(running))).toBe("frame 1")
    expect(appArgs(inputOf(running))).toEqual(["frame=1"])
    expect(metadataOf(running)["source"]).toContain("ctx.call(\"read\"")
    const settled = firstCard("cell", "completed")
    expect(appSubtitle(inputOf(settled))).toBe("frame 1 · 3 calls · read-only")
    expect(tuiLine(settled)).toBe("# cell [description=frame 1 · 3 calls · read-only, frame=1]")
    expect(metadataOf(settled)["source"]).toContain("ctx.call(\"read\"")
  })

  /**
   * A classify card's collapsed line was the call's own state: the task,
   * the file and the excerpt, which is a whole file in a real run.
   */
  it("lead the classify card with the door and the leading answer", () => {
    const running = firstCard("classify", "running")
    expect(appSubtitle(inputOf(running))).toBe("triage/relevance · 1 state")
    expect(metadataOf(running)["input"]).toMatchObject({ file: "package.json" })
    const settled = firstCard("classify", "completed")
    expect(appSubtitle(inputOf(settled))).toBe("triage/relevance · relevant: yes (0.93)")
    expect(appArgs(inputOf(settled))).toEqual([])
    expect(metadataOf(settled)["input"]).toMatchObject({ file: "package.json" })
  })

  /**
   * The demand card had an empty input, so it collapsed to the tool name
   * alone and every demand of a turn read the same.
   */
  it("lead the demand card with the demand and its streak", () => {
    const card = firstCard("demand")
    expect(appSubtitle(inputOf(card))).toBe("read-only · 1/1")
    expect(tuiLine(card)).toBe("# demand [description=read-only · 1/1]")
  })

  /**
   * The lines the door's own answers produce, at the shapes a run reaches
   * them by: a batch stands for itself, a state Jev refused names its code,
   * and a door with nothing to say still names itself.
   */
  it("name the door when no single answer stands for the call", () => {
    const value = { answers: { relevant: { value: true, probability: 0.9 } } }
    expect(Projection.classifyDescription("classify/triage/relevance", { states: [{}, {}] }, value))
      .toBe("triage/relevance · 2 states")
    expect(Projection.classifyDescription("classify", {}, undefined)).toBe("ad hoc · 1 state")
    expect(Projection.classifyDescription("classify", {}, { results: [] })).toBe("ad hoc · 1 state")
    expect(Projection.classifyDescription("classify", {}, { results: [{ error: { code: "refused" } }] }))
      .toBe("ad hoc · refused")
    expect(Projection.classifyDescription("classify", {}, { results: [{ error: {} }] })).toBe("ad hoc · failed")
    expect(Projection.classifyDescription("classify", {}, { answers: {} })).toBe("ad hoc · no questions")
    expect(Projection.classifyDescription("classify", {}, { answers: { note: "plain" } })).toBe("ad hoc · note: plain")
  })

  /**
   * The rule behind all four: a collapsed line is a headline, so no card
   * this server invents puts a paragraph or a program in it.
   */
  it("keep every collapsed line short enough to scan", () => {
    const invented = new Set(["health", "cell", "classify", "demand"])
    const scanned = cards().filter((card) => invented.has(card.tool))
    expect(scanned.length).toBeGreaterThan(4)
    for (const card of scanned) {
      const line = tuiLine(card)
      expect({ tool: card.tool, line, over: line.length > 120, wrapped: line.includes("\n") }).toMatchObject({
        over: false,
        wrapped: false
      })
      expect(appSubtitle(inputOf(card))).toBeDefined()
    }
  })
})
