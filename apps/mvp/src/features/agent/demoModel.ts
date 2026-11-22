import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { Effect, Layer, Stream } from "effect"
import { AuthClient } from "../auth/api"
import type { SessionState } from "../auth/contract"
import { ChatClient } from "../chat/api"

// Zero-backend interactive demo mode (`?agent=mock`): runs Smithers' real browser flow engine and composer in memory
// for visitors without sign-in or model spend. Lazy-loaded only when `?agent=mock` is requested.

/** Query parameter value that enables the in-browser interactive demo. */
export const DEMO_AGENT = "mock"

/** Isolated engine name so demo mode never touches a real person's OPFS database or Web Lock. */
export const DEMO_ENGINE_NAME = "smithers-demo"

/** Worker name passed from main.tsx to engine.worker.ts for demo mode. */
export const DEMO_WORKER_NAME = "demo:mock"

/** Local in-memory session presented only inside an isolated `?agent=mock` demo tab. */
export const DEMO_SESSION: SessionState = {
  signedIn: true,
  personId: "00000000-0000-4000-8000-00000000de00",
  login: "visitor",
  role: "member",
  hostedModel: true,
}

/** Whether `search` (e.g. `window.location.search`) activates the interactive visitor demo. */
export const isDemoMode = (search: string): boolean =>
  new URLSearchParams(search).get("agent") === DEMO_AGENT

interface Heard {
  readonly answered: boolean
  readonly answer?: string
  readonly approved?: boolean
  readonly note?: string
}

const textOf = (request: ModelRequest.ModelRequest): string =>
  request.messages
    .flatMap((message) => message.content.map((part) => ("text" in part ? part.text : "")))
    .join("\n")

const lastUserText = (request: ModelRequest.ModelRequest): string => {
  const userMessages = request.messages.filter((message) => message.role === "user")
  const last = userMessages.at(-1)
  if (last === undefined) return ""
  return last.content.map((part) => ("text" in part ? part.text : "")).join(" ").trim()
}

const heardIn = (text: string): Heard | undefined => {
  const match = text.match(/\{"answered":(?:true|false)[^}]*\}/)
  return match === null ? undefined : JSON.parse(match[0]) as Heard
}

const streamText = (text: string) =>
  Stream.fromIterable<ModelEvent.ModelEvent>([
    { type: "text-delta", id: "demo", text },
    { type: "usage", inputTokens: 12, outputTokens: Math.max(8, Math.ceil(text.length / 4)) },
    { type: "settle", stopReason: "stop" },
  ])

const cell = (source: string): string => "```cell\n" + source + "\n```"

/** Pure reply selector for a demo prompt, tested independently of streaming. */
export const demoReplyFor = (prompt: string, heard?: Heard): string => {
  const lower = prompt.toLowerCase()
  if (/\b(approve|deploy|publish)\b/.test(lower)) {
    if (heard === undefined) {
      return cell(
        'const r = await ctx.call("app/agent/ask", { kind: "approval", prompt: "Publish branch demo/add-tour to GitHub?" })\n' +
        "console.log(JSON.stringify(r))",
      )
    }
    return heard.approved === true
      ? "Approved — branch `demo/add-tour` would now publish through the durable `branch/publish` flow."
      : "Kept local — no changes were pushed. Try asking me to compare options (`choose workflow`) or type `/tour`."
  }
  if (/\b(choose|question|which|workflow)\b/.test(lower)) {
    if (heard === undefined) {
      return cell(
        'const r = await ctx.call("app/agent/ask", { kind: "question", prompt: "Which Smithers workflow do you want to explore?", options: ["TODO Stack", "Branch Sandbox", "Review Queue"] })\n' +
        "console.log(JSON.stringify(r))",
      )
    }
    return heard.answered && heard.answer !== undefined
      ? `Great pick: **${heard.answer}** runs as a durable flow with full journals and keyboard triage. Type \`/tour\` to walk through all eight capabilities.`
      : "No option selected — ask anything else or type `/tour` to open the guided walkthrough."
  }
  if (/\b(todo|stack|issue)\b/.test(lower)) {
    return "Smithers turns GitHub issues into a stacked TODO queue (`T1 → T2 → T3`). Each TODO runs in an isolated sandbox branch, streams its progress, and opens a PR for review. Try typing `deploy preview` to test an approval gate, or `/tour` for the full walkthrough."
  }
  return "Welcome to the **Smithers interactive demo** (running locally in your browser with zero backend writes).\n\nTry:\n- Ask **`deploy preview`** to test a live human-in-the-loop approval gate\n- Ask **`which workflow`** to test an interactive multi-choice question\n- Press **`⌘K`** or type **`/tour`** for the guided walkthrough, or **`/theme`** to switch themes"
}

/** Deterministic in-browser model for `?agent=mock`. */
export const demoModel: Model.Model = Model.make({
  stream: (request) => {
    const all = textOf(request)
    const prompt = lastUserText(request)
    return streamText(demoReplyFor(prompt, heardIn(all)))
  },
})

/** Deterministic conversation title summarizer for `?agent=mock`. */
export const demoSummary: Model.Model = Model.make({
  stream: (request) => {
    const words = lastUserText(request).split(/\s+/).filter(Boolean).slice(0, 4).join(" ")
    return streamText(words === "" ? "Smithers demo" : `Demo: ${words}`)
  },
})

/** Deterministic presentation renderer for `?agent=mock`. */
export const demoRenderer: Model.Model = Model.make({
  stream: () => streamText('export default function View() { return null }'),
})

/** Local in-memory ChatClient + AuthClient layer for `?agent=mock` (zero network writes). */
export const demoServices = Layer.merge(
  Layer.succeed(ChatClient, {
    ask: () => Effect.succeed({ _tag: "inserted" as const }),
  }),
  Layer.succeed(AuthClient, {
    session: Effect.succeed(DEMO_SESSION),
    signOut: Effect.void,
    setHostedModel: (enabled) => Effect.succeed({ enabled }),
  }),
)
