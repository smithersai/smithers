import { Model, ModelError, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "../features/views/renderer"

// The scripted agents the end-to-end tests run on the browser's engine under the dev server (src/flows/engine.worker.ts,
// `?agent=<script>`), so a needs-you path and a sandbox tool's resume run the same every time: the model is the only
// scripted seam. The needs-you scripts ask with `app/agent/ask` until their cell has printed what it heard, then
// finish with what it heard in their words; `queue` asks a question or an approval named for the person's message, so
// several open at once tell apart; `sandbox-once` and `sandbox-long` call the sandbox tools; `todo-draft` drafts a TODO;
// `show-code` opens a file at lines.

/** What the agent’s cell printed it heard: `app/agent/ask`’s answer. */
interface Heard {
  readonly answered: boolean
  readonly answer?: string
  readonly approved?: boolean
  readonly note?: string
}
// `form` asks with a form; `board` shows a board written by scriptedRenderer.

/** A script: what its agent asks, and how it finishes once it heard the answer. */
interface Script {
  readonly ask: string
  readonly done: (heard: Heard) => string
}

const scripts: Readonly<Record<string, Script>> = {
  "needs-you": {
    ask: `{ kind: "question", prompt: "Which branch should I deploy?", options: ["main", "docs-v2"] }`,
    done: (heard) => (heard.answered ? `Deploying ${heard.answer}.` : "No answer, so nothing deployed."),
  },
  approval: {
    ask: `{ kind: "approval", prompt: "Delete the stale preview docs-v1?" }`,
    done: (heard) => (heard.approved === true ? "Deleted docs-v1." : "Kept docs-v1."),
  },
}

const cell = (source: string) => "```cell\n" + source + "\n```"

/** What the agent's cell printed it heard, if it has asked. */
const heardIn = (request: ModelRequest.ModelRequest) => {
  const text = request.messages.flatMap((message) => message.content.map((part) => ("text" in part ? part.text : "")))
  const printed = text.join("\n").match(/\{"answered":(?:true|false)[^}]*\}/)
  return printed === null ? undefined : JSON.parse(printed[0]) as Heard
}

/** Everything the model has been sent so far, as one text. */
const textOf = (request: ModelRequest.ModelRequest) =>
  request.messages.flatMap((message) => message.content.map((part) => ("text" in part ? part.text : ""))).join("\n")

/** One cell, then the turn's end: what a scripted turn streams. */
const turn = (source: string) =>
  Stream.fromIterable<ModelEvent.ModelEvent>([
    { type: "text-delta", id: "t", text: cell(source) },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
    { type: "settle", stopReason: "stop" },
  ])

/**
 * `sandbox-once` (e2e/sandbox-tools.spec.ts): asked `sandbox-count <word>`, the agent runs a slow command on the branch's
 * machine that appends a line to `runs-<word>.log` and counts its lines, then reads the file back, then answers what it
 * saw. A command that ran twice would leave two lines.
 */
const sandboxOnce = Model.make({
  stream: (request) => {
    const text = textOf(request)
    // The question may reach the model in the system prompt or a message, after the conversation's earlier questions:
    // this run's is the last one anywhere in the request.
    const word = [...JSON.stringify(request).matchAll(/sandbox-count ([a-z0-9-]+)/g)].at(-1)?.[1] ?? "none"
    const ran = text.match(/\{"ran":"(\d+)"\}/)?.[1]
    const lines = text.match(/\{"lines":(\d+)\}/)?.[1]
    const log = `runs-${word}.log`
    if (ran === undefined) {
      return turn(
        `const r = await ctx.call("sandbox/run", { command: ${JSON.stringify(`sleep 15; echo ran >> ${log}; wc -l < ${log}`)} })\n` +
          `console.log(JSON.stringify({ ran: r.stdout.trim() }))`,
      )
    }
    if (lines === undefined) {
      return turn(
        `const f = await ctx.call("sandbox/read", { path: ${JSON.stringify(log)} })\n` +
          `console.log(JSON.stringify({ lines: f.content.split("\\n").filter(Boolean).length }))`,
      )
    }
    return turn(`ctx.done(${JSON.stringify(`Counted ${ran}; the log has ${lines} line(s) for ${word}.`)})`)
  },
})

/**
 * `sandbox-long` (e2e/sandbox-tools.spec.ts): asked `sandbox-long <word> <seconds>`, the agent runs a command on the
 * branch's machine that sleeps that long, appends a line to `runs-<word>.log` and prints `done-5`, with the longest
 * timeout a command may have; then reads the log back and answers what it saw. A command that ran twice would leave two
 * lines, and one lost would answer no `done-5`.
 */
const sandboxLong = Model.make({
  stream: (request) => {
    const text = textOf(request)
    const [, word = "none", seconds = "1"] = [...JSON.stringify(request).matchAll(/sandbox-long ([a-z0-9-]+) (\d+)/g)].at(-1) ?? []
    const out = text.match(/\{"out":"([^"]*)"\}/)?.[1]
    const lines = text.match(/\{"lines":(\d+)\}/)?.[1]
    const log = `runs-${word}.log`
    if (out === undefined) {
      const command = `sleep ${seconds}; echo ran >> ${log}; echo done-$((2+3))`
      return turn(
        `const r = await ctx.call("sandbox/run", { command: ${JSON.stringify(command)}, timeoutSeconds: 600 })\n` +
          `console.log(JSON.stringify({ out: r.stdout.trim() }))`,
      )
    }
    if (lines === undefined) {
      return turn(
        `const f = await ctx.call("sandbox/read", { path: ${JSON.stringify(log)} })\n` +
          `console.log(JSON.stringify({ lines: f.content.split("\\n").filter(Boolean).length }))`,
      )
    }
    return turn(`ctx.done(${JSON.stringify(`Ran ${out}; the log has ${lines} line(s) for ${word}.`)})`)
  },
})

/**
 * `todo-draft` (e2e/todos.spec.ts): asked `todo-draft <owner>/<name> <word>`, the agent drafts a TODO on that
 * repository with `todo/draft`, its prompt naming the word, then answers. It never commits: the person does.
 */
const todoDraft = Model.make({
  stream: (request) => {
    // The question ends the agent's system prompt, after the conversation before it, which may hold earlier runs'
    // questions: the last one asked is this run's. What its cells printed is in the messages.
    const text = [...request.system.map((part) => part.text), textOf(request)].join("\n")
    const asked = [...text.matchAll(/todo-draft ([\w.-]+\/[\w.-]+) ([a-z0-9-]+)/g)].at(-1) ?? []
    const [, repo = "octocat/Spoon-Knife", word = "none"] = asked
    if (!textOf(request).includes(`"status":"drafted"`)) {
      const input = { repo, prompt: `Add a line to the README: ${word}`, acceptance: ["The README ends with the line"] }
      return turn(`const d = await ctx.call("todo/draft", ${JSON.stringify(input)})\nconsole.log(JSON.stringify(d))`)
    }
    return turn(`ctx.done("Drafted. Edit it and press Commit.")`)
  },
})

/**
 * `show-code` (e2e/files.spec.ts): asked `show-code <path> <lines>`, the agent opens the file of the repository the
 * person's tab views as a tab, with those lines highlighted, through `file/open`, then answers.
 */
const showCode = Model.make({
  stream: (request) => {
    const text = [...request.system.map((part) => part.text), textOf(request)].join("\n")
    const [, path = "README.md", lines = "1"] = [...text.matchAll(/show-code (\S+) ([0-9-]+)/g)].at(-1) ?? []
    if (!textOf(request).includes(`"opened":true`)) {
      return turn(`const o = await ctx.call("file/open", ${JSON.stringify({ path, lines })})\nconsole.log(JSON.stringify(o))`)
    }
    return turn(`ctx.done(${JSON.stringify(`Opened ${path} at lines ${lines}.`)})`)
  },
})

/**
 * A deliberately slow reasoning service for the ordering regression. It emits private thinking for forty seconds
 * without visible answer progress. A follow-up can say it saw the earlier reply only when ChatApi included that
 * completed exchange in its turn. Everything except this slow model is the real browser/Worker/engine path.
 */
const reasoningOrder = Model.make({
  stream: (request) => {
    const text = [...request.system.map((part) => part.text), textOf(request)].join("\n")
    const asked = [...text.matchAll(/(Think quietly, then say ready|Use the previous answer): ([a-z0-9-]+)/g)].at(-1)
    const word = asked?.[2] ?? "missing"
    if (asked?.[1] === "Use the previous answer") {
      const included = text.includes(`Smithers: Ready ${word}.`)
      return turn(`ctx.done(${JSON.stringify(`${included ? "Earlier answer included" : "Earlier answer missing"}: ${word}.`)})`)
    }
    const thinking = Stream.fromIterable(Array.from({ length: 40 }, (_, index) => index)).pipe(
      Stream.mapEffect(() =>
        Effect.as(Effect.sleep("1 second"), {
          type: "thinking-delta", id: "reasoning-order", text: "Still considering the question. ",
        } satisfies ModelEvent.ModelEvent)
      ),
    )
    return Stream.concat(thinking, turn(`ctx.done(${JSON.stringify(`Ready ${word}.`)})`))
  },
})

/**
 * `queue` (the needs-you plugin's queue): asked a message, the agent asks for approval when it says "approve", else
 * which branch to deploy, naming the message's last word, so several open waits tell apart. It finishes with what it
 * heard: `Deploying <branch>.`, `Approved: <note>` (`Approved.` without one) or `Kept it.`.
 */
const queue = Model.make({
  stream: (request) => {
    // The agent's task ends its system prompt: the message, after the conversation before it.
    const task = request.system.at(-1)?.text ?? ""
    const marker = "The person now asks: "
    const at = task.lastIndexOf(marker)
    const message = (at === -1 ? task : task.slice(at + marker.length)).trim()
    const approval = /\bapprove\b/i.test(message)
    const word = message.split(/\s+/).at(-1)?.replace(/[^\w-]/g, "") || "none"
    const heard = heardIn(request)
    if (heard === undefined) {
      const need = approval
        ? { kind: "approval", prompt: `Approve the deploy for ${word}?` }
        : { kind: "question", prompt: `Deploy which branch for ${word}?`, options: ["main", "docs-v2", "release"] }
      return turn(`const heard = await ctx.call("app/agent/ask", ${JSON.stringify(need)})\nconsole.log(JSON.stringify(heard))`)
    }
    const done = !heard.answered
      ? "No answer, so nothing deployed."
      : !approval
      ? `Deploying ${heard.answer}.`
      : heard.approved !== true
      ? "Kept it."
      : heard.note === undefined
      ? "Approved."
      : `Approved: ${heard.note}`
    return turn(`ctx.done(${JSON.stringify(done)})`)
  },
})

/** The form `form` asks with: which repository to clone. */
const CLONE_FORM = {
  title: "Which repository?",
  schema: {
    type: "object",
    properties: { url: { type: "string", title: "Repository URL" } },
    required: ["url"],
  },
  submitLabel: "Clone",
}

/**
 * `form` (e2e/forms.spec.ts): asked anything, the agent asks which repository with `ui/form` and ends its answer; asked
 * the form's submission, it answers with the URL the person sent. The submission is the question's text then its
 * values (worker/Messages.ts `SENT_VALUES`).
 */
const formAsk = Model.make({
  stream: (request) => {
    // The question may end the system prompt or a message, after the conversation before it (src/features/agent/flows.ts
    // `prompt`), which may hold earlier submissions: this run's question is the last one asked.
    const all = [...request.system.map((part) => part.text), textOf(request)].join("\n")
    const text = all.lastIndexOf("now asks: ") < 0 ? all : all.slice(all.lastIndexOf("now asks: "))
    const sent = text.match(/Clone\nThe values the person sent with it: (\{[^\n]*\})/)
    if (sent === null) {
      return turn(`await ctx.call("ui/form", ${JSON.stringify(CLONE_FORM)})\nctx.done("Which repository should I clone?")`)
    }
    const { url } = JSON.parse(sent[1]!) as { readonly url: string }
    return turn(`ctx.done(${JSON.stringify(`Got it. I'll clone ${url}.`)})`)
  },
})

/** `board` (e2e/generated-view.spec.ts): asked anything, the agent shows a tic-tac-toe board with `ui/render`. */
const board = Model.make({
  stream: () =>
    turn(
      `await ctx.call("ui/render", { description: "A tic-tac-toe board for two players", size: "inline" })\n` +
        `ctx.done("Here's a board. Click a square to move, or open it full screen.")`,
    ),
})

/** The renderer the scripted agents' `ui/render` calls: it writes the tic-tac-toe module (src/features/views/renderer.ts). */
export const scriptedRenderer = Model.make({
  stream: () =>
    Stream.fromIterable<ModelEvent.ModelEvent>([
      {
        type: "text-delta",
        id: "t",
        text: "```json\n" + JSON.stringify({ title: "Tic-tac-toe", state: TIC_TAC_TOE_STATE }) + "\n```\n```tsx\n" +
          TIC_TAC_TOE + "```",
      },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "settle", stopReason: "stop" },
    ]),
})

/** The scripted model named `name`, or `undefined` for a name no script has. */
export const scriptedModel = (name: string): Model.Model | undefined => {
  // A terminal provider refusal, already normalized by the model endpoint.
  if (name === "quota-refused") return Model.make({ stream: () => Stream.fail(
    new ModelError.ModelError({ code: "out_of_credit", httpStatus: 402, message: "scripted credit refusal" }),
  ) })
  if (name === "pin-message") return Model.make({ stream: () => turn(`ctx.done(${JSON.stringify(
    "GARDEN\n\n" + Array.from({ length: 35 }, (_, i) => `${i + 1}. The garden has room for trees, flowers, a winding path, and a quiet place to sit.`).join("\n\n"),
  )})`) })
  if (name === "sandbox-once") return sandboxOnce
  if (name === "sandbox-long") return sandboxLong
  if (name === "todo-draft") return todoDraft
  if (name === "show-code") return showCode
  if (name === "reasoning-order") return reasoningOrder
  if (name === "queue") return queue
  if (name === "form") return formAsk
  if (name === "board") return board
  const script = scripts[name]
  if (script === undefined) return undefined
  return Model.make({
    stream: (request) => {
      const heard = heardIn(request)
      const source = heard === undefined
        ? `const heard = await ctx.call("app/agent/ask", ${script.ask})\nconsole.log(JSON.stringify(heard))`
        : `ctx.done(${JSON.stringify(script.done(heard))})`
      const events: ReadonlyArray<ModelEvent.ModelEvent> = [
        { type: "text-delta", id: "t", text: cell(source) },
        { type: "usage", inputTokens: 1, outputTokens: 1 },
        { type: "settle", stopReason: "stop" },
      ]
      return Stream.fromIterable(events)
    },
  })
}
