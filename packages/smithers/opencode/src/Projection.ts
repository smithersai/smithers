/**
 * The pure fold from harness `AgentEvent`s to OpenCode v1 events.
 *
 * One turn is one assistant message. Each frame opens a `step-start` part,
 * streams the model's prose into a `reasoning` part, renders the cell the
 * model wrote as a `cell` tool part and its prints as visible text after it,
 * renders every `ctx.call` as a tool part named after the flow (`ls` as
 * `list`, so OpenCode's rich cards apply), shows submitted patches as text
 * beside their cards, and closes with a `step-finish`
 * part carrying the frame's tokens. A discipline demand is a `demand` tool
 * part. A permission park is `permission.asked`. `Resolved` streams the
 * final answer as a text part and ends the turn: the assistant header gets
 * its finish, the session its tokens, and the status goes idle. The
 * assistant header carries the last model step's tokens, the way OpenCode
 * reports them (the app reads them as the context size); the session
 * carries the turn's totals, each frame counted once across a replay.
 *
 * Every part id is derived from the assistant message and a sort key
 * (`Ids.part`), so a frame replayed after a park names the same parts and
 * the app updates cards instead of duplicating them. That is also why a
 * park resets the frame counter: the engine re-drives the turn from frame
 * zero and the journal replays what settled. A replayed frame is not new
 * information: it triggers no health evaluation and counts nothing twice
 * (frames, calls, tokens, demands, frames since an edit), so every health
 * card sorts under the frame whose settlement or park produced its facts.
 *
 * The fold is total. It never throws, and an event it does not understand
 * changes nothing, because the stream consumer runs inside the frame and a
 * projection error would fail the run (composition brief, trap 7).
 *
 * Beside the cards, the fold keeps the facts the health color reads
 * (`Health.Facts`), hands them out on the events that trigger an
 * evaluation, and folds the decision back in with `health`: the session
 * title gets the dot, and a `health` card is emitted on a color change. It
 * also counts the turn's frames, calls, classify calls, Jev latency and
 * spend, which the run summary reports as a synthetic text part when the
 * turn ends, and it carries the seat's cost when the host names a price.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type { Schema } from "effect"
import { basename, isAbsolute, join } from "node:path"
import type * as Driver from "./Driver.ts"
import * as Health from "./Health.ts"
import * as Ids from "./Ids.ts"
import * as Protocol from "./Protocol.ts"

/**
 * What the fold needs from its host.
 *
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly directory: string
  readonly now: () => number
  /** The frame budget the health state reports until the engine arms one. One hundred by default. */
  readonly maxFrames?: number | undefined
  /** The seat's price, when the host knows it. Without one the seat costs zero. */
  readonly pricing?: Pricing | undefined
}

/**
 * Dollars per million tokens of a seat.
 *
 * @category models
 * @since 1.0.0
 */
export interface Pricing {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion?: number | undefined
  readonly cacheWritePerMillion?: number | undefined
}

/**
 * The dollars a token count costs at a price. Zero without a price.
 *
 * @category conversions
 * @since 1.0.0
 */
export const costOf = (tokens: Protocol.Tokens, pricing: Pricing | undefined): number =>
  pricing === undefined
    ? 0
    : (tokens.input * pricing.inputPerMillion +
      (tokens.output + tokens.reasoning) * pricing.outputPerMillion +
      tokens.cache.read * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
      tokens.cache.write * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)) / 1_000_000

/**
 * What opens a turn.
 *
 * @category models
 * @since 1.0.0
 */
export interface Opened {
  readonly session: Protocol.Session
  readonly userMessageID: string
  /** The id of the user message's text part: the app's own when it sent one, so its optimistic part is confirmed. */
  readonly userPartID: string
  readonly assistantMessageID: string
  readonly prompt: string
  readonly agent: string
  readonly model: Protocol.ModelRef
  /** When the assistant message was first created; now, unless a re-opened turn says otherwise. */
  readonly createdAt?: number | undefined
  /** When the user message was first created; now, unless the prompt is a retry of a stored one. */
  readonly userCreatedAt?: number | undefined
}

/**
 * How a turn ended when no event said so: the driver body's exit.
 *
 * @category models
 * @since 1.0.0
 */
export type Closing =
  | {
    readonly _tag: "interrupted"
    /**
     * The harness's own words for the interrupt, when it reported one. The
     * operator's Stop reports none and reads as the fixed sentence.
     */
    readonly message?: string | undefined
  }
  | {
    readonly _tag: "failed"
    readonly message: string
    readonly provider?: Driver.ProviderFailure | undefined
    /** The harness's own code, when the harness is what ended the run. */
    readonly harness?: Driver.HarnessStop | undefined
  }

interface CallCard {
  readonly partID: string
  readonly callID: string
  readonly tool: string
  /** The input the cell wrote, which the card's title and metadata read. */
  readonly input: Record<string, unknown>
  /** The input the card carries, which is the raw one for every flow OpenCode already renders. */
  readonly served: Record<string, unknown>
  readonly start: number
}

/**
 * The fold's state between events.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  readonly session: Protocol.Session
  readonly userMessageID: string
  readonly assistantMessageID: string
  readonly agent: string
  readonly model: Protocol.ModelRef
  readonly createdAt: number
  /** The current frame, zero-based; minus one before the first `turn-opened`. */
  readonly frame: number
  /** The turn's tokens, each frame counted once: what the session totals and the cost are made of. */
  readonly tokens: Protocol.Tokens
  /** The current frame's tokens, for its `step-finish`. */
  readonly frameTokens: Protocol.Tokens
  /**
   * The last model step's tokens: the current context size, which the
   * assistant header reports the way OpenCode does (the app divides its sum
   * by the model's context limit for the usage tooltip).
   */
  readonly context: Protocol.Tokens
  readonly reasoning: { readonly partID: string; readonly text: string; readonly start: number } | undefined
  /**
   * The open cell. It outlives a park, where the frame counter is reset for
   * the replay, so an abort of a parked turn still settles its card.
   */
  readonly cell:
    | {
      /** The frame the cell opened in, zero-based. */
      readonly frame: number
      readonly partID: string
      readonly callID: string
      readonly source: string
      readonly calls: number
      readonly edits: number
      readonly start: number
      readonly prints: string
    }
    | undefined
  readonly calls: Readonly<Record<string, CallCard>>
  readonly demandText: Readonly<Record<string, string>>
  /** Whether `resolved` has been folded: the answer is in the timeline. */
  readonly answered: boolean
  /** Whether the frame closed as resolved: the step is finished. */
  readonly resolving: boolean
  readonly closed: boolean
  /** This turn's seat cost so far. */
  readonly cost: number
  /** What the health color reads. */
  readonly facts: Health.Facts
  /** Whether an edit landed since the frame opened. */
  readonly editedThisFrame: boolean
  /** The current color and why, or none before the first decision. */
  readonly health: Health.Decision | undefined
  /**
   * The answers behind the last decision Jev gave any, which the turn's
   * final decision is re-read from. Kept across a gray evaluation: the last
   * answers are still the last thing anything knew about the run.
   */
  readonly answers: Health.Answers | undefined
  /** How many health cards this turn has emitted. */
  readonly healthCards: number
  /**
   * The output of the last `complete` transition the run applied, kept so a
   * completion the brake handed back can be read in the transcript instead of
   * only in the store. See the `claim-demanded` card.
   */
  readonly lastCompletion: string | undefined
  /**
   * How many health deadlines Jev has missed in a row. Reset by any
   * evaluation that came back, failure or answer, because the streak is about
   * the transport not answering and nothing else.
   */
  readonly missedDeadlines: number
  /** The run summary's counters. */
  readonly summary: Summary
  /**
   * The call starts and settles already counted, by identity: a frame the
   * engine replays after a park re-emits them, and the summary counts each
   * once.
   */
  readonly counted: Readonly<Record<string, true>>
}

/**
 * What the run summary reports at the end of a turn.
 *
 * @category models
 * @since 1.0.0
 */
export interface Summary {
  readonly frames: number
  readonly calls: number
  readonly classifyCalls: number
  /**
   * Every Jev call the run made: the classify calls the cell issued, the
   * health evaluation each trigger asked for, and the completion brake's
   * reading at each completion attempt. Counted where each call is asked, so
   * a health answer that arrives after the turn ended is still one of the
   * calls the footer reports.
   */
  readonly jevCalls: number
  readonly jevLatencyMs: number
  /** Dollars, from the usage the gateway reported. */
  readonly jevCost: number
}

/**
 * The fold's answer: the next state and the events to store and publish, in
 * order.
 *
 * @category models
 * @since 1.0.0
 */
export interface Step {
  readonly state: State
  readonly events: ReadonlyArray<Protocol.Emitted>
  /** The facts to evaluate, when the folded event triggers a health evaluation. */
  readonly health?: Health.Facts | undefined
}

/**
 * The slots a part can occupy inside a frame, in sort order.
 *
 * @category constants
 * @since 1.0.0
 */
export const slots = {
  stepStart: 0x00,
  reasoning: 0x01,
  cell: 0x02,
  call: 0x10,
  demand: 0xe0,
  health: 0xf0,
  stepFinish: 0xff
} as const

/**
 * The slot the run summary sorts under, after the final answer's text.
 *
 * @category constants
 * @since 1.0.0
 */
export const summarySlot = 0x01

/**
 * The frames the health state counts as the budget when the host names none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxFrames = 100

/**
 * How many recent calls the health state carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const lastCallsKept = 12

/**
 * How many characters of the task and of the prints the health state carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const healthTextCap = 2048

/**
 * The frame key the final answer sorts under: after every real frame.
 *
 * @category constants
 * @since 1.0.0
 */
export const finalFrame = 0xffff

/**
 * The tool name a flow renders as. `ls` becomes `list`; every other flow
 * keeps its name, which is what OpenCode's cards for `read`, `edit`, `write`,
 * `bash`, `grep`, `glob` and `apply_patch` expect.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolName = (flowName: string): string =>
  flowName === "ls" ? "list" : isClassify(flowName) ? "classify" : flowName

/**
 * Whether a flow is the ad-hoc `classify` door or a curated `classify/<id>`.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isClassify = (flowName: string): boolean => flowName === "classify" || flowName.startsWith("classify/")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

/**
 * What the person reads on a bash card that names no command: the call gives
 * no subject to approve, and `Bash.run` refuses it as `invalid_input`.
 *
 * @category constants
 * @since 1.0.0
 */
export const unnameableBash = "a bash call that names no command"

/** The interpreter a script-form bash call runs under when it names none. */
const defaultInterpreter = "bash"

/** How much of a program's first line a subject line carries. */
const subjectLineLimit = 120

/**
 * A program as one line: its first non-blank line, clipped, and how many more
 * follow. Only called for a program that has one.
 */
const programLine = (script: string): string => {
  const lines = script.split("\n").filter((line) => line.trim() !== "").length
  const first = script.trim().split("\n", 1).join("").trim()
  const clipped = first.length > subjectLineLimit ? `${first.slice(0, subjectLineLimit)}...` : first
  return lines > 1 ? `${clipped} (+${lines - 1} more lines)` : clipped
}

/**
 * What a bash call asks for, from any input `@smthrs/agent/std/Bash` accepts:
 * the one line the person is approving, and the `always` pattern a grant may
 * cover.
 *
 * A simple command line names its program in its first word, so a grant can
 * cover that word. Shell syntax can run other programs or redirect output;
 * those calls offer no reusable pattern and ask for their own approval.
 * A script is program text an interpreter reads
 * on standard input; it has no first word, and the first word of the program
 * is not the name of anything the shell would run. Such a call therefore
 * offers no `always` at all: an empty list, which is why no bash answer can
 * ever grant `*`. The subject names the interpreter and shows the program's
 * first line, and the card carries the program whole.
 *
 * A container is part of what a grant covers, because `pytest` inside a
 * container and `pytest` on this machine are two different acts.
 *
 * @param input the call input, as the cell wrote it or as the card carries it
 * @category conversions
 * @since 1.0.0
 */
export const bashSubject = (input: Record<string, unknown>): {
  readonly command: string
  readonly always: Array<string>
} => {
  // The program is read first, and it decides. A card this function already
  // described carries both fields: the subject it derived in `command`, and
  // the program in `script`. Reading `command` first would take that derived
  // line for a command line and hand its first word an always-grant, which is
  // the hole this order closes.
  const script = asString(input["script"])
  if (script !== undefined && script.trim() !== "") {
    const interpreter = asString(input["interpreter"]) ?? defaultInterpreter
    return { command: `${interpreter} script: ${programLine(script)}`, always: [] }
  }
  const command = asString(input["command"])
  if (command !== undefined && command.trim() !== "") {
    const simple = command.trim()
    // Deliberately a small literal-command grammar, not a shell parser.
    // Quotes, substitutions, redirections, operators, and line breaks all
    // need their own approval instead of borrowing the first word's grant.
    if (!/^[\w./-]+(?:[ \t]+[\w./:=+,%@*?-]+)*$/.test(simple)) return { command, always: [] }
    const word = simple.replace(/\s[\s\S]*$/, "")
    const container = asString(input["container"])
    return { command, always: [container === undefined ? `${word} *` : `${word} * in container ${container}`] }
  }
  return { command: "", always: [] }
}

/**
 * The input OpenCode's card for a flow reads, from the input the cell wrote.
 * Paths become absolute because the cards relativize them to the project.
 *
 * @param directory the served directory
 * @param flowName the flow the cell called
 * @param input the call input as the cell wrote it
 * @category conversions
 * @since 1.0.0
 */
export const toolInput = (directory: string, flowName: string, input: Schema.Json): Record<string, unknown> => {
  const raw: Record<string, unknown> = isRecord(input) ? input : { input }
  const absolute = (value: unknown): string => {
    const path = asString(value) ?? "."
    return isAbsolute(path) ? path : join(directory, path)
  }
  const optional = (key: string, value: unknown): Record<string, unknown> => value === undefined ? {} : { [key]: value }
  switch (flowName) {
    case "read":
      return {
        filePath: absolute(raw["path"]),
        ...optional("offset", raw["offset"]),
        ...optional("limit", raw["limit"])
      }
    case "ls":
      return { path: absolute(raw["path"]) }
    case "glob":
      return { pattern: asString(raw["pattern"]) ?? "", path: absolute(raw["root"]) }
    case "grep":
      return {
        pattern: asString(raw["pattern"]) ?? "",
        path: absolute(raw["root"]),
        ...(Array.isArray(raw["globs"]) ? { include: raw["globs"].join(",") } : {})
      }
    case "edit":
      return {
        filePath: absolute(raw["path"]),
        oldString: asString(raw["oldString"]) ?? "",
        newString: asString(raw["newString"]) ?? ""
      }
    case "write":
      return { filePath: absolute(raw["path"]), content: asString(raw["content"]) ?? "" }
    case "bash":
      // Both clients render this card from `command`, so the subject goes
      // there whichever form the cell wrote, and the program follows the
      // short scalars that qualify it.
      return {
        command: bashSubject(raw).command,
        ...optional("description", raw["description"]),
        ...optional("interpreter", raw["interpreter"]),
        ...optional("args", raw["args"]),
        ...optional("container", raw["container"]),
        ...optional("cwd", raw["cwd"]),
        ...optional("script", raw["script"])
      }
    default:
      return raw
  }
}

const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

/** The states a classify input carries: one, or the batch. */
const classifyStates = (input: Record<string, unknown>): number =>
  Array.isArray(input["states"]) ? input["states"].length : 1

/** Usage is optional in old journal results and when the provider omitted it. */
const classifyCost = (value: unknown): number => {
  const usage = isRecord(value) ? value["usage"] : undefined
  if (!isRecord(usage)) return 0
  const inputTokens = asNumber(usage["inputTokens"])
  const outputTokens = asNumber(usage["outputTokens"])
  return inputTokens === undefined || outputTokens === undefined ? 0 : Health.jevCost({ inputTokens, outputTokens })
}

const leading = (answer: Record<string, unknown>): string => {
  const value = answer["value"]
  const probabilities = isRecord(answer["probabilities"]) ? answer["probabilities"] : {}
  if (typeof value === "boolean") {
    const probability = asNumber(answer["probability"]) ?? 0
    return `${value ? "yes" : "no"} (${(value ? probability : 1 - probability).toFixed(2)})`
  }
  const label = asString(answer["label"]) ?? asString(value) ?? String(value)
  return `${label} (${(asNumber(probabilities[label]) ?? 0).toFixed(2)})`
}

const answersLine = (answers: Record<string, unknown>): string =>
  Object.entries(answers)
    .map(([id, answer]) => `${id}: ${isRecord(answer) ? leading(answer) : String(answer)}`)
    .join(" · ")

/**
 * One state's entry in a classify result: its answers, or the failure that
 * kept them from arriving.
 *
 * @category models
 * @since 1.0.0
 */
export type ClassifyEntry =
  | { readonly answers: Record<string, unknown>; readonly error?: undefined }
  | { readonly answers?: undefined; readonly error: Record<string, unknown> }

/**
 * The entries of a classify result, one per state: the answers of a
 * verdict, or each batch entry's answers or error.
 *
 * @category conversions
 * @since 1.0.0
 */
export const classifyEntries = (value: Schema.Json): Array<ClassifyEntry> => {
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  if (Array.isArray(record["results"])) {
    return record["results"].map((entry): ClassifyEntry => {
      const result: Record<string, unknown> = isRecord(entry) ? entry : {}
      return isRecord(result["answers"])
        ? { answers: result["answers"] }
        : { error: isRecord(result["error"]) ? result["error"] : {} }
    })
  }
  return [{ answers: isRecord(record["answers"]) ? record["answers"] : {} }]
}

/**
 * The full answers of a classify result, one entry per state, for the
 * card's structured metadata; a failed state carries its error instead.
 *
 * @category conversions
 * @since 1.0.0
 */
export const classifyAnswers = (value: Schema.Json): Array<Record<string, unknown>> =>
  classifyEntries(value).map((entry) => entry.answers ?? { error: entry.error })

/**
 * The output of a classify card: one line per state with the leading answer
 * to every question and its probability, or the failure.
 *
 * @category conversions
 * @since 1.0.0
 */
export const classifyOutput = (value: Schema.Json): string =>
  classifyEntries(value)
    .map((entry, index) =>
      `${index + 1}. ${
        entry.answers === undefined
          ? `${asString(entry.error["code"]) ?? "failed"}: ${asString(entry.error["message"]) ?? ""}`
          : answersLine(entry.answers)
      }`
    )
    .join("\n")

/**
 * The door a classify call went through, as its card names it: the curated
 * id (`triage/relevance` for `classify/triage/relevance`) or `ad hoc` for
 * the bare `classify` door, so a check/verdict card is told from an
 * edit/risk card without opening it.
 *
 * @category conversions
 * @since 1.0.0
 */
export const classifyDoor = (flowName: string): string =>
  flowName === "classify" ? "ad hoc" : flowName.slice("classify/".length)

/**
 * The title of a classify card: the door, how many states and questions,
 * and how long Jev took. `elapsed` stands in for the latency a batch does
 * not report.
 *
 * @category conversions
 * @since 1.0.0
 */
export const classifyTitle = (
  flowName: string,
  input: Record<string, unknown>,
  value: Schema.Json,
  elapsed: number
): string => {
  const states = classifyStates(input)
  const answered = classifyEntries(value).find((entry) => entry.answers !== undefined)
  const questions = answered === undefined
    ? Object.keys(isRecord(input["questions"]) ? input["questions"] : {}).length
    : Object.keys(answered.answers).length
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  const ms = asNumber(record["latencyMs"]) ?? elapsed
  return `${classifyDoor(flowName)} · ${states} state${states === 1 ? "" : "s"} · ${questions} question${
    questions === 1 ? "" : "s"
  } · ${ms} ms`
}

/**
 * The input a card this server invents carries. Both clients render a card
 * whose tool they do not know from its input alone: the hosted app's
 * `label` (packages/session-ui/src/components/basic-tool.tsx) takes the
 * subtitle from the first of `description`, `query`, `url`, `filePath`,
 * `path`, `pattern`, `name`, then lists three more scalars as `key=value`,
 * and its `GenericTool` has no expanded body at all; the TUI's `input`
 * (packages/tui/src/routes/session/index.tsx) prints every scalar of the
 * input, in insertion order and untruncated. Neither reads the card's
 * `title`. So the one line a reader needs goes in `description`, ahead of
 * the short scalars that qualify it, and everything long — a frame's
 * program, a classify call's state — stays in the card's metadata.
 *
 * @param description the one line a reader scanning the transcript needs
 * @param rest the short scalars that follow it
 * @category conversions
 * @since 1.0.0
 */
export const cardInput = (
  description: string,
  rest: Record<string, unknown> = {}
): Record<string, unknown> => ({ description, ...rest })

/**
 * The line a classify card leads with: the door, and the leading answer to
 * the first question the classifier declares, which is the verdict the door
 * was opened for. A batch names how many states it judged instead, because
 * no single answer stands for the batch, and a state that failed names its
 * code.
 *
 * @param flowName the flow the cell called
 * @param input the call input as the cell wrote it
 * @param value the settled call's value, or `undefined` while it runs
 * @category conversions
 * @since 1.0.0
 */
export const classifyDescription = (
  flowName: string,
  input: Record<string, unknown>,
  value?: Schema.Json
): string => {
  const door = classifyDoor(flowName)
  const states = classifyStates(input)
  if (value === undefined || states > 1) return `${door} · ${states} state${states === 1 ? "" : "s"}`
  const entry = classifyEntries(value)[0]
  if (entry === undefined) return `${door} · ${states} state`
  if (entry.answers === undefined) return `${door} · ${asString(entry.error["code"]) ?? "failed"}`
  const first = Object.entries(entry.answers)[0]
  if (first === undefined) return `${door} · no questions`
  const [id, answer] = first
  return `${door} · ${id}: ${isRecord(answer) ? leading(answer) : String(answer)}`
}

/**
 * The title of a call card: the one thing the reader needs to tell this call
 * from the next.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolTitle = (flowName: string, input: Record<string, unknown>): string => {
  if (isClassify(flowName)) {
    const states = classifyStates(input)
    return `${classifyDoor(flowName)} · ${states} state${states === 1 ? "" : "s"}`
  }
  switch (flowName) {
    case "read":
    case "edit":
    case "write":
      return basename(asString(input["filePath"]) ?? "")
    case "ls":
      return asString(input["path"]) ?? ""
    case "glob":
    case "grep":
      return asString(input["pattern"]) ?? ""
    case "bash":
      return bashSubject(input).command
    default:
      return flowName
  }
}

/**
 * A settled call's value as the text a card shows.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolOutput = (flowName: string, value: Schema.Json): string => {
  if (isClassify(flowName)) return classifyOutput(value)
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  switch (flowName) {
    case "read":
      return asString(record["content"]) ?? Cell.renderText(value)
    case "bash": {
      const stdout = asString(record["stdout"]) ?? ""
      const stderr = asString(record["stderr"]) ?? ""
      return stderr === "" ? stdout : `${stdout}${stdout === "" ? "" : "\n"}${stderr}`
    }
    case "ls":
      return Array.isArray(record["entries"])
        ? record["entries"].map((entry) => isRecord(entry) ? asString(entry["name"]) ?? "" : "").join("\n")
        : Cell.renderText(value)
    case "glob":
      return Array.isArray(record["paths"]) ? record["paths"].join("\n") : Cell.renderText(value)
    case "edit":
      return asString(record["hunk"]) ?? Cell.renderText(value)
    case "write":
      return `Wrote ${String(record["bytesWritten"] ?? 0)} bytes to ${asString(record["path"]) ?? ""}`
    default:
      return Cell.renderText(value)
  }
}

/**
 * The structured metadata a card gets beside its output. `bash` mirrors
 * OpenCode's `{output, exit}` so the shell card reads its exit code.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolMetadata = (flowName: string, value: Schema.Json): Record<string, unknown> => {
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  if (isClassify(flowName)) return { answers: classifyAnswers(value), result: value }
  if (flowName === "bash") {
    return {
      output: toolOutput(flowName, value),
      exit: typeof record["exitCode"] === "number" ? record["exitCode"] : 0,
      truncated: record["stdoutTruncated"] === true || record["stderrTruncated"] === true,
      result: value
    }
  }
  return { result: value }
}

/**
 * The permission card's patterns and `always` rule for a parked call.
 *
 * The bash flow never offers `*`: a simple command line offers its first word, and
 * a call that names no command a person could read offers nothing, so an
 * answer to it covers that one call. Every other flow offers the whole flow,
 * which is what its card says.
 *
 * @category conversions
 * @since 1.0.0
 */
export const permissionPatterns = (
  flowName: string,
  input: Record<string, unknown>
): { readonly patterns: [string]; readonly always: Array<string> } => {
  if (flowName === "bash") {
    const subject = bashSubject(input)
    return { patterns: [subject.command === "" ? unnameableBash : subject.command], always: subject.always }
  }
  const subject = toolTitle(flowName, input)
  return { patterns: [subject === "" ? "*" : subject], always: ["*"] }
}

const callID = (identity: { readonly frame: number; readonly cell: string; readonly ordinal: number }): string =>
  `call_${identity.frame}_${identity.cell.slice(0, 8)}_${identity.ordinal}`

const addTokens = (a: Protocol.Tokens, b: Protocol.Tokens): Protocol.Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write }
})

const tokensOf = (usage: ModelEvent.Usage): Protocol.Tokens => ({
  input: usage.inputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  reasoning: usage.reasoningTokens ?? 0,
  cache: { read: usage.cachedInputTokens ?? 0, write: usage.cacheWriteTokens ?? 0 }
})

/**
 * The prose of an assistant message: its text content with fenced code
 * blocks removed, which is what the model said around the cell it wrote.
 *
 * @category conversions
 * @since 1.0.0
 */
export const prose = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("")
    .replace(/```[\s\S]*?```/g, "")
    .trim()

/**
 * The final answer of a resolved turn.
 *
 * @category conversions
 * @since 1.0.0
 */
export const answerText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")

/**
 * Splits streamed text into the deltas the app receives, at word boundaries
 * and at most `size` characters each.
 *
 * @category conversions
 * @since 1.0.0
 */
export const chunks = (text: string, size = 24): Array<string> => {
  const out: Array<string> = []
  let current = ""
  for (const word of text.split(/(?<=\s)/)) {
    if (current.length > 0 && current.length + word.length > size) {
      out.push(current)
      current = ""
    }
    current += word
  }
  if (current.length > 0) out.push(current)
  return out
}

const base = (state: State): Pick<Protocol.PartBase, "sessionID" | "messageID"> => ({
  sessionID: state.session.id,
  messageID: state.assistantMessageID
})

const partEvent = (part: Protocol.Part, time: number): Protocol.Emitted => ({
  type: "message.part.updated",
  properties: { sessionID: part.sessionID, part, time }
})

/** Literal output cannot close its own fence and become transcript markup. */
const fenced = (text: string): string => {
  const size = (text.match(/`+/g) ?? []).reduce((size, run) => Math.max(size, run.length + 1), 3)
  const fence = "`".repeat(size)
  return `${fence}text\n${text}\n${fence}`
}

/**
 * Native cards without a body need a visible receipt beside the card. The
 * suffix sorts immediately after its card and before the next ordinal;
 * replay derives the same id, so the clients replace this text in place.
 */
const detailText = (
  state: State,
  card: { readonly partID: string; readonly start: number },
  text: string,
  now: number
): Protocol.Emitted =>
  partEvent({
    ...base(state),
    id: `${card.partID}0`,
    type: "text",
    synthetic: true,
    text,
    time: { start: card.start, end: now }
  }, now)

const deltaEvent = (state: State, partID: string, field: string, delta: string): Protocol.Emitted => ({
  type: "message.part.delta",
  properties: { sessionID: state.session.id, messageID: state.assistantMessageID, partID, field, delta }
})

const assistantHeader = (
  state: State,
  ctx: Context,
  extra: Partial<Protocol.AssistantMessage> = {}
): Protocol.AssistantMessage => ({
  id: state.assistantMessageID,
  sessionID: state.session.id,
  role: "assistant",
  time: { created: state.createdAt },
  parentID: state.userMessageID,
  modelID: state.model.modelID,
  providerID: state.model.providerID,
  mode: state.agent,
  agent: state.agent,
  path: { cwd: ctx.directory, root: ctx.directory },
  cost: state.cost,
  tokens: state.context,
  ...extra
})

/**
 * The session as it stands mid-turn: the stored session plus this turn's
 * tokens and cost.
 *
 * @category getters
 * @since 1.0.0
 */
export const sessionNow = (state: State, now: number): Protocol.Session => ({
  ...state.session,
  tokens: addTokens(state.session.tokens, state.tokens),
  cost: state.session.cost + state.cost,
  time: { ...state.session.time, updated: now }
})

const sessionEvent = (session: Protocol.Session): Protocol.Emitted => ({
  type: "session.updated",
  properties: { sessionID: session.id, info: session }
})

const statusEvent = (sessionID: string, status: Protocol.SessionStatus): Protocol.Emitted => ({
  type: "session.status",
  properties: { sessionID, status }
})

const cellTitle = (cell: NonNullable<State["cell"]>, frame: number): string =>
  `frame ${frame + 1} · ${cell.calls} call${cell.calls === 1 ? "" : "s"} · ${
    cell.edits === 0 ? "read-only" : `${cell.edits} edit${cell.edits === 1 ? "" : "s"}`
  }`

const finishReasoning = (state: State, ctx: Context, text?: string): Step => {
  if (state.reasoning === undefined) return { state, events: [] }
  const part: Protocol.ReasoningPart = {
    ...base(state),
    id: state.reasoning.partID,
    type: "reasoning",
    text: text ?? state.reasoning.text,
    time: { start: state.reasoning.start, end: ctx.now() }
  }
  return { state: { ...state, reasoning: undefined }, events: [partEvent(part, ctx.now())] }
}

const stepFinish = (state: State, ctx: Context, reason: string): Protocol.Emitted =>
  partEvent(
    {
      ...base(state),
      id: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.stepFinish, ordinal: 0 }),
      type: "step-finish",
      reason,
      cost: costOf(state.frameTokens, ctx.pricing),
      tokens: state.frameTokens
    },
    ctx.now()
  )

/**
 * The run summary line: frames, calls, classify calls, Jev latency and spend.
 *
 * @category conversions
 * @since 1.0.0
 */
export const summaryLine = (summary: Summary): string =>
  [
    `${summary.frames} frame${summary.frames === 1 ? "" : "s"}`,
    `${summary.calls} call${summary.calls === 1 ? "" : "s"}`,
    `${summary.classifyCalls} classify`,
    `Jev ${summary.jevCalls} call${summary.jevCalls === 1 ? "" : "s"} · ${summary.jevLatencyMs} ms · $${
      summary.jevCost.toFixed(4)
    }`
  ].join(" · ")

const endTurn = (
  state: State,
  ctx: Context,
  header: Partial<Protocol.AssistantMessage>
): Step => {
  const now = ctx.now()
  const session = sessionNow(state, now)
  const next: State = { ...state, session, closed: true }
  const summary: Protocol.TextPart = {
    ...base(next),
    id: Ids.part(next.assistantMessageID, { frame: finalFrame, slot: summarySlot, ordinal: 0 }),
    type: "text",
    text: summaryLine(next.summary),
    synthetic: true,
    time: { start: now, end: now }
  }
  return {
    state: next,
    events: [
      { type: "message.updated", properties: { sessionID: session.id, info: assistantHeader(next, ctx, header) } },
      partEvent(summary, now),
      sessionEvent(session),
      statusEvent(session.id, { type: "idle" }),
      { type: "session.idle", properties: { sessionID: session.id } }
    ]
  }
}

/**
 * Whether the frame budget, and not the run, ended a turn that resolved.
 *
 * The harness resolves a turn two ways, and the difference is one typed fact.
 * A run that finished says so first: it applies a `complete` transition and
 * the controller closes the turn on that transition's own words. A run whose
 * budget ran out applies no such transition; the controller closes the turn
 * because there is no next frame and hands back the budget notice
 * (`CellTurn.budgetMessage`), which is a sentence about the harness rather
 * than an answer to the task. So a resolved turn whose last transition is not
 * `complete` is a turn its budget ended, whatever the notice says.
 *
 * Read off the transition and never off the notice, the rule 091697c6 states:
 * the sentence is prose that changes, the transition is the contract. The
 * frame count is not the test either, because a run that completes on its
 * last frame has spent exactly the same budget and is not this.
 *
 * @category predicates
 * @since 1.0.0
 */
export const budgetEnded = (state: State): boolean => state.facts.lastTransition !== "complete"

/**
 * The turn's last reading, which always lands.
 *
 * {@link decided} emits a card only when the color changed, which keeps a
 * long run from growing one card a frame. The end of a turn is the one
 * decision that rule is wrong about. A run whose frame budget ran out while a
 * permission card was open ends red under the red the park earned, so the
 * reason an operator reads says `waiting for approval` about a card that is
 * gone, and the same silence masked every other terminal reason a red turn
 * can end on: a seat out of quota, a claim the harness refused, a run it
 * stopped. The color rule was never wrong; the card that carries its words
 * was never emitted.
 *
 * So the final reading is taken against a state carrying no earlier color,
 * and the card that names what ended the run always lands.
 */
const finalDecision = (
  ctx: Context,
  state: State,
  decision: Health.Decision,
  answers: Health.Answers | undefined,
  frame: number
): Step => decided(ctx, { ...state, health: undefined }, decision, answers, frame)

/**
 * Ends a turn that answered, after one last reading of the color rule.
 *
 * The dot a finished session keeps is the last one anything decided, and
 * mid-turn decisions are made of facts that the end of the turn has since
 * settled: a park that was answered, a demand that was met. The live drive
 * left finished, idle sessions red "waiting for approval" over an empty
 * permission list for exactly that reason. So the rule is re-read here over
 * the turn's own final facts (nothing parked, no demand outstanding) and the
 * last answers Jev gave. It is the rule, not the gateway: no call is made, so
 * the footer's count stays true and the turn ends when it ends.
 *
 * Two of those final facts were wrong, and each one ended a run on a color
 * that said the opposite of what happened.
 *
 * `lastTransition` was overwritten with `complete` here, so a run its frame
 * budget ended took rule 6 and finished green over an answer that is only the
 * budget notice. The real transition is kept now, and a resolved turn that
 * never completed carries {@link Health.frameBudget} as the fact that ended
 * it ({@link budgetEnded}), which is red naming the budget.
 *
 * A turn nothing ever judged used to keep no color at all, which is what a
 * conversational turn that resolves in one frame always is: it ends before
 * the first evaluation answers. No dot is not honesty, it is a hole an
 * operator cannot read. The rule has an answer for it without Jev: rule 6's
 * second clause is a fact, the harness handed a completion back, and at this
 * point nothing is parked, no demand is outstanding and there is no
 * `needsHuman` to beat it. So it is green, reading {@link Health.answeredReason}
 * rather than a `done` nobody said.
 */
const resolvedTurn = (state: State, ctx: Context): Step => {
  const close = (from: State): Step =>
    endTurn(from, ctx, { finish: "stop", time: { created: state.createdAt, completed: ctx.now() } })
  const endedBy: Health.Ended | undefined = budgetEnded(state)
    ? { code: Health.frameBudget, maxFrames: state.facts.maxFrames }
    : undefined
  const facts: Health.Facts = {
    ...state.facts,
    parked: "none",
    demandThisFrame: false,
    endedBy
  }
  const decision = endedBy === undefined && state.answers === undefined
    ? { color: "green" as const, reason: Health.answeredReason }
    : Health.decide(facts, state.answers)
  const last = finalDecision(ctx, { ...state, facts }, decision, state.answers, lastFrame(state))
  const ended = close(last.state)
  return { state: ended.state, events: [...last.events, ...ended.events] }
}

/**
 * The park a person just answered, cleared, and the color asked again.
 *
 * `parked` is a fact about right now, and until a permission or a question
 * is answered every decision short-circuits red on it before it reads a
 * single answer. It used to be cleared only at the next `turn-opened`, so a
 * call the person allowed inside a frame that never parked, and any
 * evaluation between the answer and the re-drive, kept saying "waiting for
 * approval" about a session that was waiting for nobody. The answer is the
 * moment the fact stops being true, so the fact is cleared here and the
 * color is asked again from the same frame. A session that is not parked is
 * unchanged and asks nothing.
 *
 * @category combinators
 * @since 1.0.0
 */
export const replied = (state: State): Step => {
  if (state.closed || state.facts.parked === "none") return { state, events: [] }
  return {
    state: {
      ...state,
      facts: { ...state.facts, parked: "none" },
      summary: { ...state.summary, jevCalls: state.summary.jevCalls + 1 }
    },
    events: [],
    health: { ...state.facts, parked: "none", frame: lastFrame(state) + 1 }
  }
}

const demandCard = (
  state: State,
  ctx: Context,
  frame: number,
  ordinal: number,
  title: string,
  text: string
): Step => {
  const partID = Ids.part(state.assistantMessageID, { frame, slot: slots.demand, ordinal })
  const now = ctx.now()
  const part: Protocol.ToolPart = {
    ...base(state),
    id: partID,
    type: "tool",
    callID: `demand_${frame}_${ordinal}`,
    tool: "demand",
    state: {
      status: "completed",
      input: cardInput(title),
      output: text,
      title,
      metadata: {},
      time: { start: now, end: now }
    }
  }
  return { state: { ...state, demandText: { ...state.demandText, [partID]: text } }, events: [partEvent(part, now)] }
}

/**
 * The title of the card the completion brake writes: the word, the probability
 * that decided, and the two that did not.
 *
 * The card used to be titled `claim` and nothing else, and a collapsed card
 * is its title alone, so the only mark the brake left in a transcript was one
 * word. The numbers are the three questions Jev answered, which is what makes
 * the refusal arguable: a person who thinks the run was right can see how
 * close it was.
 *
 * `invented` leads, and the other two are in brackets behind it, because only
 * one of the three decides anything. `CompletionClaim` carries the corpus that
 * demoted the other two, and a title that led with them would invite a reader
 * to argue with numbers that did not act.
 *
 * @param invented the probability the claim reports a command or a result the evidence does not record
 * @param complete the probability the task as stated is done
 * @param overclaims the probability the claim asserts what the evidence does not show
 * @category conversions
 * @since 1.0.0
 */
export const claimTitle = (invented: number, complete: number, overclaims: number): string =>
  `claim · invented ${invented.toFixed(2)} (complete ${complete.toFixed(2)}, overclaims ${overclaims.toFixed(2)})`

/**
 * The body of that card: what the brake did, what the run has to do about it,
 * and the completion it refused, word for word.
 *
 * The refused completion is the point. A brake that is right most of the time
 * is wrong some of the time, and until now the only copy of the sentence it
 * refused was a `complete` transition inside `opencode.sqlite`, so a correct
 * answer it bounced was gone as far as the person was concerned. It goes in
 * the transcript, under the probabilities, where they can read it and decide
 * for themselves whether the brake was right.
 *
 * The first line says what was wrong with the sentence rather than that the
 * task was unfinished, because that is what the brake now judges: a completion
 * reporting a command the run never ran or a result it never got. See
 * `CompletionClaim`.
 *
 * @param completion the words the refused completion carried, when the run applied one
 * @category conversions
 * @since 1.0.0
 */
export const claimText = (completion: string | undefined): string =>
  `Unrecorded claim: this completion reports a command the run ran, or a result it got, that the run's record does not carry. Complete again on what was actually run, or say plainly what was not checked.${
    completion === undefined ? "" : `\n\nThe completion this demand handed back:\n\n${completion}`
  }`

/**
 * The demand kinds, in the order their cards sort inside a frame.
 *
 * @category constants
 * @since 1.0.0
 */
export const demandOrdinals = {
  "read-only": 0,
  repeat: 1,
  narrowed: 2,
  unmoved: 3,
  unresolved: 4,
  "narrow-only": 5,
  claim: 6
} as const

/** The decision a session title already carries, so a follow-up turn starts from the last color. */
const colorOf = (title: string): Health.Decision | undefined => {
  const color = Health.colorOf(title)
  return color === undefined ? undefined : { color, reason: "" }
}

/**
 * A demand issued: remembered for the health state, and pending for the
 * next evaluation. A demand whose card exists was issued before, and the
 * replay is not a second demand.
 */
const demanded = (state: State, name: keyof typeof demandOrdinals, frame: number): State =>
  Ids.part(state.assistantMessageID, { frame, slot: slots.demand, ordinal: demandOrdinals[name] }) in state.demandText
    ? state
    : {
      ...state,
      facts: { ...state.facts, demands: [...state.facts.demands, name].slice(-lastCallsKept), demandThisFrame: true }
    }

/**
 * The facts to evaluate at a trigger, and the state once they are handed
 * out. A settlement consumes the demand flag; a park does not, because the
 * frame the demand was issued for has not settled yet, and it reads the
 * flag when it does.
 *
 * The Jev call is counted here, where it is asked, and not where its answer
 * is folded. The evaluation runs on a fiber of its own and a slow one answers
 * after the turn has ended, which is recorded and never folded, so counting
 * the answer left the run summary short of the calls the run had already
 * made: a live drive's footer said three where the gateway log said four.
 */
const trigger = (state: State, settled: boolean): { readonly state: State; readonly health: Health.Facts } => ({
  state: {
    ...(settled ? { ...state, facts: { ...state.facts, demandThisFrame: false } } : state),
    summary: { ...state.summary, jevCalls: state.summary.jevCalls + 1 }
  },
  health: { ...state.facts, frame: state.frame + 1 }
})

/**
 * Whether the current frame settled before: the engine re-drives a parked
 * turn from frame zero, and every frame below the high-water mark is the
 * journal replaying what it already holds.
 */
const replayed = (state: State): boolean => state.frame + 1 < state.summary.frames

/**
 * The last frame that opened, zero-based: the current one, or the
 * high-water mark while a park has reset the counter.
 */
const lastFrame = (state: State): number => Math.max(state.frame, state.summary.frames - 1)

/**
 * Opens a turn: the user message and its text part, the session with its
 * title set from the first prompt, the assistant header, and the busy
 * status.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = (ctx: Context, opened: Opened): Step => {
  const now = ctx.now()
  const titled = opened.session.title.startsWith("New session")
    ? opened.prompt.replace(/\s+/g, " ").trim().slice(0, 60)
    : opened.session.title
  const session: Protocol.Session = {
    ...opened.session,
    title: titled === "" ? opened.session.title : titled,
    agent: opened.agent,
    model: { id: opened.model.modelID, providerID: opened.model.providerID },
    time: { ...opened.session.time, updated: now }
  }
  const state: State = {
    session,
    userMessageID: opened.userMessageID,
    assistantMessageID: opened.assistantMessageID,
    agent: opened.agent,
    model: opened.model,
    createdAt: opened.createdAt ?? now,
    frame: -1,
    tokens: Protocol.noTokens,
    frameTokens: Protocol.noTokens,
    context: Protocol.noTokens,
    reasoning: undefined,
    cell: undefined,
    calls: {},
    demandText: {},
    answered: false,
    resolving: false,
    closed: false,
    cost: 0,
    facts: {
      task: opened.prompt.slice(0, healthTextCap),
      frame: 0,
      maxFrames: ctx.maxFrames ?? defaultMaxFrames,
      framesSinceEdit: 0,
      demands: [],
      lastCalls: [],
      lastPrints: "",
      parked: "none",
      lastTransition: "continue",
      demandThisFrame: false,
      stoppedBy: undefined,
      endedBy: undefined
    },
    editedThisFrame: false,
    health: colorOf(session.title),
    answers: undefined,
    healthCards: 0,
    lastCompletion: undefined,
    missedDeadlines: 0,
    summary: { frames: 0, calls: 0, classifyCalls: 0, jevCalls: 0, jevLatencyMs: 0, jevCost: 0 },
    counted: {}
  }
  const user: Protocol.UserMessage = {
    id: opened.userMessageID,
    sessionID: session.id,
    role: "user",
    time: { created: opened.userCreatedAt ?? now },
    agent: opened.agent,
    model: opened.model
  }
  const userText: Protocol.TextPart = {
    id: opened.userPartID,
    sessionID: session.id,
    messageID: opened.userMessageID,
    type: "text",
    text: opened.prompt
  }
  return {
    state,
    events: [
      { type: "message.updated", properties: { sessionID: session.id, info: user } },
      partEvent(userText, now),
      sessionEvent(session),
      statusEvent(session.id, { type: "busy" }),
      { type: "message.updated", properties: { sessionID: session.id, info: assistantHeader(state, ctx) } }
    ]
  }
}

/**
 * Folds one harness event.
 *
 * @category combinators
 * @since 1.0.0
 */
export const fold = (ctx: Context, state: State, event: AgentEvent.AgentEvent): Step => {
  if (state.closed) return { state, events: [] }
  switch (event._tag) {
    case "turn-opened": {
      const frame = state.frame + 1
      const next: State = {
        ...state,
        frame,
        frameTokens: Protocol.noTokens,
        reasoning: undefined,
        cell: undefined,
        editedThisFrame: false,
        facts: { ...state.facts, parked: "none" },
        // Frames are counted by index, so a replay from frame zero after a park counts nothing twice.
        summary: { ...state.summary, frames: Math.max(state.summary.frames, frame + 1) }
      }
      const part: Protocol.StepStartPart = {
        ...base(next),
        id: Ids.part(next.assistantMessageID, { frame, slot: slots.stepStart, ordinal: 0 }),
        type: "step-start"
      }
      return { state: next, events: [partEvent(part, ctx.now())] }
    }
    case "model-delta": {
      const delta = event.delta
      if (delta.type !== "text-delta" && delta.type !== "thinking-delta") return { state, events: [] }
      const events: Array<Protocol.Emitted> = []
      let reasoning = state.reasoning
      if (reasoning === undefined) {
        const now = ctx.now()
        reasoning = {
          partID: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.reasoning, ordinal: 0 }),
          text: "",
          start: now
        }
        events.push(
          partEvent({ ...base(state), id: reasoning.partID, type: "reasoning", text: "", time: { start: now } }, now)
        )
      }
      events.push(deltaEvent(state, reasoning.partID, "text", delta.text))
      return { state: { ...state, reasoning: { ...reasoning, text: reasoning.text + delta.text } }, events }
    }
    case "model-settled": {
      const frameTokens = tokensOf(event.usage)
      // The journal replays a frame's model step after a park with the same
      // usage; the turn's total and the cost count each frame once.
      const counted = `model:${state.frame}` in state.counted
      const next: State = {
        ...state,
        frameTokens,
        context: frameTokens,
        tokens: counted ? state.tokens : addTokens(state.tokens, frameTokens),
        cost: counted ? state.cost : state.cost + costOf(frameTokens, ctx.pricing),
        counted: { ...state.counted, [`model:${state.frame}`]: true }
      }
      // The session carries the totals; the header carries this step's
      // tokens, so the app's context usage follows the run.
      const usage: Array<Protocol.Emitted> = [
        sessionEvent(sessionNow(next, ctx.now())),
        { type: "message.updated", properties: { sessionID: next.session.id, info: assistantHeader(next, ctx) } }
      ]
      const text = prose(event.message)
      if (next.reasoning === undefined && text === "") return { state: next, events: usage }
      if (next.reasoning === undefined) {
        const now = ctx.now()
        const partID = Ids.part(next.assistantMessageID, { frame: next.frame, slot: slots.reasoning, ordinal: 0 })
        return {
          state: next,
          events: [
            ...usage,
            partEvent({ ...base(next), id: partID, type: "reasoning", text, time: { start: now, end: now } }, now)
          ]
        }
      }
      const finished = finishReasoning(next, ctx, text)
      return { state: finished.state, events: [...usage, ...finished.events] }
    }
    case "model-retried":
      return {
        state,
        events: [
          statusEvent(state.session.id, {
            type: "retry",
            attempt: event.attempt,
            message: `Model call retried (${event.code})`,
            next: ctx.now() + event.delayMillis
          })
        ]
      }
    case "cell-produced": {
      const finished = finishReasoning(state, ctx)
      const now = ctx.now()
      const cell = {
        frame: state.frame,
        partID: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.cell, ordinal: 0 }),
        callID: `cell_${state.frame}_${event.cell.digest.slice(0, 8)}`,
        source: event.cell.text,
        calls: 0,
        edits: 0,
        start: now,
        prints: ""
      }
      const part: Protocol.ToolPart = {
        ...base(state),
        id: cell.partID,
        type: "tool",
        callID: cell.callID,
        tool: "cell",
        state: {
          status: "running",
          input: cardInput(`frame ${state.frame + 1}`, { frame: state.frame + 1 }),
          title: `frame ${state.frame + 1}`,
          metadata: { source: cell.source },
          time: { start: now }
        }
      }
      return { state: { ...finished.state, cell }, events: [...finished.events, partEvent(part, now)] }
    }
    case "cell-call-started": {
      const identity = event.call.identity
      const key = callID(identity)
      const existing = state.calls[key]
      const now = existing?.start ?? ctx.now()
      const input = toolInput(ctx.directory, event.call.flowName, event.call.input)
      const card: CallCard = {
        partID: Ids.part(state.assistantMessageID, {
          frame: identity.frame,
          slot: slots.call,
          ordinal: identity.ordinal
        }),
        callID: key,
        tool: toolName(event.call.flowName),
        input,
        served: isClassify(event.call.flowName) ? cardInput(classifyDescription(event.call.flowName, input)) : input,
        start: now
      }
      const edits = ["edit", "write", "apply_patch"].includes(event.call.flowName) ? 1 : 0
      const cell = state.cell === undefined
        ? undefined
        : { ...state.cell, calls: state.cell.calls + 1, edits: state.cell.edits + edits }
      const part: Protocol.ToolPart = {
        ...base(state),
        id: card.partID,
        type: "tool",
        callID: card.callID,
        tool: card.tool,
        state: isClassify(event.call.flowName)
          ? {
            status: "running",
            input: card.served,
            title: toolTitle(event.call.flowName, input),
            metadata: { input },
            time: { start: now }
          }
          : { status: "running", input, title: toolTitle(event.call.flowName, input), time: { start: now } }
      }
      const classify = isClassify(event.call.flowName) ? 1 : 0
      const counted = `start:${key}` in state.counted
      return {
        state: {
          ...state,
          cell,
          calls: { ...state.calls, [key]: card },
          summary: counted ? state.summary : {
            ...state.summary,
            calls: state.summary.calls + 1,
            classifyCalls: state.summary.classifyCalls + classify
          },
          counted: { ...state.counted, [`start:${key}`]: true }
        },
        events: [partEvent(part, ctx.now())]
      }
    }
    case "cell-call-settled": {
      const key = callID(event.identity)
      const card = state.calls[key]
      if (card === undefined) return { state, events: [] }
      const now = ctx.now()
      const result = event.result
      const ok = result.outcome === "success"
      const classify = isClassify(event.flowName)
      const latency = classify && isRecord(result.value) ? asNumber(result.value["latencyMs"]) ?? now - card.start : 0
      const edited = ok && ["edit", "write", "apply_patch"].includes(event.flowName)
      const subject = toolTitle(event.flowName, card.input)
      const summary = ok
        ? subject || toolOutput(event.flowName, result.value).slice(0, 80)
        : `${result.code ?? Cell.defaultCallFailureCode}: ${result.message ?? ""}`.slice(0, 80)
      // A failed card's error leads with what was called (the command, the
      // file): the app shows the words before the first `: ` in the card's
      // header and the rest in its body, so a failed shell reads as the
      // command and the reason instead of "Failed" over nothing.
      const failure = `${result.message ?? "The call failed"}${result.code === undefined ? "" : ` (${result.code})`}${
        result.code === undefined ? "" : `\n${Cell.callFailureHint[result.code]}`
      }`
      // A settle already folded is the journal replaying it after a park:
      // the card updates, the health facts and the counters do not.
      const seen = `settle:${key}` in state.counted
      const facts: Health.Facts = seen ? state.facts : {
        ...state.facts,
        lastCalls: [...state.facts.lastCalls, { flow: event.flowName, ok, summary }].slice(-lastCallsKept)
      }
      const part: Protocol.ToolPart = {
        ...base(state),
        id: card.partID,
        type: "tool",
        callID: card.callID,
        tool: card.tool,
        state: ok
          ? {
            status: "completed",
            input: classify
              ? cardInput(classifyDescription(event.flowName, card.input, result.value))
              : card.served,
            output: toolOutput(event.flowName, result.value),
            title: classify
              ? classifyTitle(event.flowName, card.input, result.value, now - card.start)
              : toolTitle(event.flowName, card.input),
            metadata: classify
              ? { ...toolMetadata(event.flowName, result.value), input: card.input }
              : toolMetadata(event.flowName, result.value),
            time: { start: card.start, end: now }
          }
          : {
            status: "error",
            input: card.served,
            error: subject === "" ? failure : `${subject}: ${failure}`,
            metadata: { code: result.code ?? Cell.defaultCallFailureCode, result: result.value },
            time: { start: card.start, end: now }
          }
      }
      const { [key]: _settled, ...calls } = state.calls
      // A replayed classify settle is the journal's answer, not a second Jev call.
      const counted = !classify || seen
      return {
        state: {
          ...state,
          calls,
          facts,
          editedThisFrame: state.editedThisFrame || edited,
          summary: counted ? state.summary : {
            ...state.summary,
            jevCalls: state.summary.jevCalls + classifyStates(card.input),
            jevLatencyMs: state.summary.jevLatencyMs + latency,
            jevCost: state.summary.jevCost + (ok ? classifyCost(result.value) : 0)
          },
          counted: { ...state.counted, [`settle:${key}`]: true }
        },
        events: [
          partEvent(part, now),
          ...(event.flowName === "apply_patch"
            ? [detailText(
              state,
              card,
              `Submitted patch\n\n${fenced(asString(card.input["input"]) ?? "")}\n\nSettled result\n\n${
                fenced(ok ? toolOutput(event.flowName, result.value) : failure)
              }`,
              now
            )]
            : [])
        ]
      }
    }
    case "cell-printed": {
      const facts: Health.Facts = { ...state.facts, lastPrints: event.text.slice(-healthTextCap) }
      return state.cell === undefined
        ? { state: { ...state, facts }, events: [] }
        : {
          state: { ...state, facts, cell: { ...state.cell, prints: event.text } },
          events: event.text === ""
            ? []
            : [detailText(state, state.cell, `Cell output\n\n${fenced(event.text)}`, ctx.now())]
        }
    }
    case "discipline-armed":
      // The budget the engine armed is the budget health reports, whatever the host was told.
      return { state: { ...state, facts: { ...state.facts, maxFrames: event.maxFrames } }, events: [] }
    case "mutation-observed":
      return event.mutated
        ? { state: { ...state, editedThisFrame: true, facts: { ...state.facts, framesSinceEdit: 0 } }, events: [] }
        : { state, events: [] }
    case "transition-applied":
      return {
        state: {
          ...state,
          // The words a completion carried, kept for the card the brake's
          // demand writes: a completion the brake hands back is otherwise
          // nowhere a person can read it.
          lastCompletion: event.transition._tag === "complete" ? event.transition.output : state.lastCompletion,
          facts: { ...state.facts, lastTransition: event.transition._tag }
        },
        events: []
      }
    case "cell-settled": {
      if (state.cell === undefined) return { state, events: [] }
      const now = ctx.now()
      const cell = state.cell
      const outcome = event.outcome
      const settledTitle = cellTitle(cell, state.frame)
      const part: Protocol.ToolPart = {
        ...base(state),
        id: cell.partID,
        type: "tool",
        callID: cell.callID,
        tool: "cell",
        state: outcome._tag === "settled"
          ? {
            status: "completed",
            input: cardInput(settledTitle, { frame: state.frame + 1 }),
            output: cell.prints,
            title: settledTitle,
            metadata: {
              transition: outcome.transition._tag,
              calls: cell.calls,
              edits: cell.edits,
              source: cell.source
            },
            time: { start: cell.start, end: now }
          }
          : {
            status: "error",
            input: cardInput(settledTitle, { frame: state.frame + 1 }),
            error: outcome._tag === "raised" ? `${outcome.name}: ${outcome.message}` : outcome.message,
            metadata: {
              outcome: outcome._tag,
              output: cell.prints,
              calls: cell.calls,
              edits: cell.edits,
              source: cell.source
            },
            time: { start: cell.start, end: now }
          }
      }
      // A frame the journal replays after a park settled before: the card
      // updates, the frame is not counted again, and health is not asked.
      if (replayed(state)) return { state: { ...state, cell: undefined }, events: [partEvent(part, now)] }
      const settled = trigger({
        ...state,
        cell: undefined,
        facts: { ...state.facts, framesSinceEdit: state.editedThisFrame ? 0 : state.facts.framesSinceEdit + 1 }
      }, true)
      return { state: settled.state, events: [partEvent(part, now)], health: settled.health }
    }
    case "read-only-demand-issued":
      return demandCard(
        demanded(state, "read-only", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals["read-only"],
        `read-only · ${event.streak}/${event.cap}`,
        `The last ${event.streak} frames only read (cap ${event.cap}). The next frame must write, justify the reading, or park.`
      )
    case "read-only-demanded": {
      const partID = Ids.part(state.assistantMessageID, {
        frame: event.nextFrame,
        slot: slots.demand,
        ordinal: demandOrdinals["read-only"]
      })
      const issued = state.demandText[partID] ??
        `The last ${event.streak} frames only read (cap ${event.cap}).`
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals["read-only"],
        `read-only · ${event.streak}/${event.cap} · ${event.nextAction}`,
        `${issued}\nAnswered: ${event.nextAction}.`
      )
    }
    case "repeat-demanded":
      return demandCard(
        demanded(state, "repeat", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals.repeat,
        `repeat · ${event.frames}/${event.cap}`,
        `${event.frames} frames repeated observations the run already had (cap ${event.cap}). Do something new.`
      )
    case "narrowed-demanded":
      return demandCard(
        demanded(state, "narrowed", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals.narrowed,
        `narrowed · ${event.flow}`,
        `The completion rests on ${event.flow} ${event.narrower}, a narrowing of ${event.broader} that was never re-run over the changed tree. Re-run the broader check.`
      )
    case "unmoved-demanded":
      return demandCard(
        demanded(state, "unmoved", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals.unmoved,
        "unmoved",
        `The tree is unchanged since the run opened (${
          event.openedDigest.slice(0, 8)
        }). Complete with an edit, or say no change was needed.`
      )
    case "unresolved-demanded":
      return demandCard(
        demanded(state, "unresolved", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals.unresolved,
        `unresolved · ${event.flow}`,
        `${event.flow} ${event.failed} failed and was replaced by ${event.instead}. Resolve the failure or re-run it.`
      )
    case "narrow-only-demanded":
      return demandCard(
        demanded(state, "narrow-only", event.nextFrame),
        ctx,
        event.nextFrame,
        demandOrdinals["narrow-only"],
        `narrow-only · ${event.flow}`,
        `${event.flow} ${event.check} covers ${event.targets.join(", ")} alone. Run a broader check.`
      )
    case "claim-demanded": {
      // The completion brake is a Jev call, and the most expensive question
      // the run asks: one reading per completion attempt, with the time it
      // took on the event. A reading the journal replays after a park is the
      // same reading, counted once, under the frame it was attached to.
      const key = `claim:${event.nextFrame}`
      const read: State = key in state.counted ? state : {
        ...state,
        summary: {
          ...state.summary,
          jevCalls: state.summary.jevCalls + 1,
          jevLatencyMs: state.summary.jevLatencyMs + event.latencyMs,
          jevCost: state.summary.jevCost + Health.jevCost(event.usage)
        },
        counted: { ...state.counted, [key]: true }
      }
      // A reading that let the completion through is a journal line and not a
      // card: nothing was asked of the run, so a card would report a demand
      // that never happened.
      return event.demanded
        ? demandCard(
          demanded(read, "claim", event.nextFrame),
          ctx,
          event.nextFrame,
          demandOrdinals.claim,
          claimTitle(event.invented, event.complete, event.overclaims),
          claimText(state.lastCompletion)
        )
        : { state: read, events: [] }
    }
    case "permission-required": {
      const request = event.request
      const meta: Record<string, unknown> = request.meta
      const flowName = asString(meta["flow"]) ?? request.capability.action
      const input = toolInput(ctx.directory, flowName, (meta["input"] ?? {}) as Schema.Json)
      const identity = isRecord(meta["identity"]) ? meta["identity"] : undefined
      const known = identity !== undefined && typeof identity["frame"] === "number" &&
        typeof identity["cell"] === "string" && typeof identity["ordinal"] === "number"
      const call = known
        ? {
          frame: identity["frame"] as number,
          cell: identity["cell"] as string,
          ordinal: identity["ordinal"] as number
        }
        : undefined
      const id = Ids.isKind("permission", request.requestId) ? request.requestId : `per_${request.requestId}`
      const events: Array<Protocol.Emitted> = []
      let calls = state.calls
      const key = call === undefined ? id : callID(call)
      if (call !== undefined) {
        const now = ctx.now()
        const card: CallCard = {
          partID: Ids.part(state.assistantMessageID, { frame: call.frame, slot: slots.call, ordinal: call.ordinal }),
          callID: key,
          tool: toolName(flowName),
          input,
          // A parked call is a capability call, and OpenCode renders every
          // capability's card from the input the cell wrote.
          served: input,
          start: now
        }
        calls = { ...calls, [key]: card }
        events.push(
          partEvent(
            {
              ...base(state),
              id: card.partID,
              type: "tool",
              callID: card.callID,
              tool: card.tool,
              state: { status: "running", input: card.served, title: toolTitle(flowName, input), time: { start: now } }
            },
            now
          )
        )
      }
      const { patterns, always } = permissionPatterns(flowName, input)
      const permission: Protocol.PermissionRequest = {
        id,
        sessionID: state.session.id,
        permission: flowName,
        patterns,
        metadata: { ...input, tier: request.tier, capability: request.capability },
        always,
        tool: { messageID: state.assistantMessageID, callID: key }
      }
      events.push({ type: "permission.asked", properties: { ...permission } })
      return { state: { ...state, calls, facts: { ...state.facts, parked: "permission" } }, events }
    }
    case "suspended": {
      // The engine re-drives the turn from frame zero after the park; the
      // journal replays what settled, and the derived part ids make the
      // replay an update of the same cards. The parked frame's cell stays
      // open until that replay's first `turn-opened`, so an abort of the
      // parked turn finds it and settles its card.
      const parked: Health.Facts["parked"] = event.reason.code === "waiting-quota"
        ? "quota"
        : event.reason.code === "permission-required"
        ? "permission"
        : "question"
      const suspended = trigger({ ...state, facts: { ...state.facts, parked } }, false)
      return {
        state: { ...suspended.state, frame: -1, reasoning: undefined },
        events: [],
        health: suspended.health
      }
    }
    case "resolved": {
      // The answer and the frame's close arrive in either order: the
      // recorded turn says the answer first, the engine says the close
      // first. The turn ends once both have been folded.
      const finished = finishReasoning(state, ctx)
      const text = answerText(event.message)
      const now = ctx.now()
      const partID = Ids.part(state.assistantMessageID, { frame: finalFrame, slot: slots.stepStart, ordinal: 0 })
      const events: Array<Protocol.Emitted> = [
        ...finished.events,
        partEvent({ ...base(state), id: partID, type: "text", text: "", time: { start: now } }, now),
        ...chunks(text).map((delta) => deltaEvent(state, partID, "text", delta)),
        partEvent({ ...base(state), id: partID, type: "text", text, time: { start: now, end: ctx.now() } }, ctx.now())
      ]
      const answered: State = { ...finished.state, answered: true }
      if (!answered.resolving) return { state: answered, events }
      const ended = resolvedTurn(answered, ctx)
      return { state: ended.state, events: [...events, ...ended.events] }
    }
    case "turn-closed": {
      switch (event.outcome) {
        case "continue":
          return { state, events: [stepFinish(state, ctx, "tool-calls")] }
        case "resolved": {
          const resolving: State = { ...state, resolving: true }
          if (!resolving.answered) return { state: resolving, events: [stepFinish(state, ctx, "stop")] }
          const ended = resolvedTurn(resolving, ctx)
          return { state: ended.state, events: [stepFinish(state, ctx, "stop"), ...ended.events] }
        }
        case "aborted": {
          const ended = endTurn(state, ctx, {
            finish: "error",
            time: { created: state.createdAt, completed: ctx.now() },
            error: { name: "UnknownError", data: { message: `The turn stopped: ${event.stopReason}` } }
          })
          return { state: ended.state, events: [stepFinish(state, ctx, "error"), ...ended.events] }
        }
        case "suspended":
          return { state, events: [] }
      }
    }
    case "aborted":
      // The only `Aborted` the harness emits is the one `CellTurn` sends from
      // `Effect.onInterrupt`, so it is an interrupt and closes as one, with
      // the harness's own words. It used to close as a failure, which read as
      // `UnknownError` on the message; now that a failure is red, reading it
      // as one would also have told an operator to act on their own Stop.
      return close(ctx, state, { _tag: "interrupted", message: event.reason })
    default:
      return { state, events: [] }
  }
}

/**
 * The state with the session fields the person edits as the store holds
 * them now: the title and the archive stamp a `PATCH /session/:id` set
 * while the turn ran. A `session.updated` the turn emits is built from
 * this state, so a rename or an archive made mid-turn stays on the session
 * instead of being written over by the title the turn opened with. The
 * turn's own fields (tokens, cost, agent, model) stay the projection's:
 * the stored copy of those is what the projection last wrote.
 *
 * @param stored the session as the store holds it now
 * @category combinators
 * @since 1.0.0
 */
export const adopt = (state: State, stored: Protocol.Session): State => {
  const archived = stored.time.archived
  if (state.session.title === stored.title && state.session.time.archived === archived) return state
  const { archived: _, ...unarchived } = state.session.time
  return {
    ...state,
    session: {
      ...state.session,
      title: stored.title,
      time: archived === undefined ? unarchived : { ...state.session.time, archived }
    }
  }
}

/**
 * Folds a decision in: the session title gets the dot, and a `health` card
 * is emitted when the color changed, with the reason as its title and the
 * answers as its output, sorted under the frame the decision judged. A
 * decision that reached a closed turn changes nothing.
 *
 * @param answers what the evaluation answered, for the card
 * @param frame the zero-based frame the card sorts under; the current one by default
 * @param failure why there are no answers, for the card, when the evaluation failed
 * @category combinators
 * @since 1.0.0
 */
export const decided = (
  ctx: Context,
  state: State,
  decision: Health.Decision,
  answers: Health.Answers | undefined,
  frame: number = state.frame,
  failure?: string
): Step => {
  if (state.closed) return { state, events: [] }
  if (state.health?.color === decision.color) return { state: { ...state, health: decision }, events: [] }
  const now = ctx.now()
  // An archived session carries no dot, the way the archive route answered.
  const session: Protocol.Session = {
    ...state.session,
    title: state.session.time.archived === undefined
      ? Health.dotted(state.session.title, decision.color)
      : Health.strip(state.session.title)
  }
  const next: State = { ...state, session, health: decision, healthCards: state.healthCards + 1 }
  const part: Protocol.ToolPart = {
    ...base(next),
    id: Ids.part(next.assistantMessageID, {
      frame: Math.max(frame, 0),
      slot: slots.health,
      ordinal: state.healthCards
    }),
    type: "tool",
    callID: `health_${state.healthCards}`,
    tool: "health",
    state: {
      status: "completed",
      input: cardInput(decision.reason, { color: decision.color }),
      output: answers === undefined && failure !== undefined ? failure : Health.renderAnswers(answers),
      title: decision.reason,
      metadata: { color: decision.color, reason: decision.reason, answers },
      time: { start: now, end: now }
    }
  }
  return { state: next, events: [sessionEvent(sessionNow(next, now)), partEvent(part, now)] }
}

/**
 * Folds one health evaluation in: adds the time and the spend when the
 * gateway answered it ({@link Health.gatewayAnswered}, so a call that never
 * reached it adds no milliseconds), keeps the answers for the turn's final
 * decision, then `decided` under the frame the facts were about
 * (`facts.frame` counts from one), with the failure on the card when there is
 * one. The call itself was counted where it was asked, which is the only
 * place that always happens before the turn ends.
 *
 * A missed deadline is the one failure that does not repaint the dot. Every
 * other transport failure is the gateway saying it cannot serve this: no key,
 * an unreachable host, a refusal, an answer that would not decode. A deadline
 * miss says only that this frame's measurement did not arrive in time, and
 * the color the run already had is still the last thing anything knew about
 * it, so the dot keeps it. Going gray instead flickered the dot mid-run in
 * four of sixteen measured turns and told the operator that health was
 * unavailable on a run that was working. {@link Health.deadlineMisses} in a
 * row is a different fact and does go gray, naming the streak, so a dot is
 * never more than three frames older than something that confirmed it.
 *
 * @category combinators
 * @since 1.0.0
 */
export const health = (ctx: Context, state: State, facts: Health.Facts, evaluation: Health.Evaluation): Step => {
  const missed = evaluation.code === "timeout" ? state.missedDeadlines + 1 : 0
  const counted: State = {
    ...state,
    answers: evaluation.answers ?? state.answers,
    missedDeadlines: missed,
    summary: !evaluation.answered ? state.summary : {
      ...state.summary,
      jevLatencyMs: state.summary.jevLatencyMs + evaluation.latencyMs,
      jevCost: state.summary.jevCost + Health.jevCost(evaluation.usage)
    }
  }
  if (missed > 0 && missed < Health.deadlineMisses && state.health !== undefined) return { state: counted, events: [] }
  const decision = missed >= Health.deadlineMisses
    ? { color: "gray" as const, reason: Health.missedDeadlines(missed) }
    : evaluation.decision
  return decided(ctx, counted, decision, evaluation.answers, facts.frame - 1, evaluation.error)
}

/**
 * Whether the turn already delivered its answer and the stream never closed
 * it: the one shape the harness's other budget exit makes.
 *
 * The loop checks the budget at the top of a frame as well as at the bottom.
 * The check at the bottom closes the turn first (`turn-closed`, then
 * `Resolved`), which {@link budgetEnded} reads. The check at the top emits
 * `Resolved` alone and returns, so the body exits `completed`, the sink calls
 * this with a fixed "the turn ended without an answer", and the only trace of
 * what happened is that `resolved` was folded and nothing closed the turn.
 * That is a spent budget, not a failure, and it says so.
 *
 * @category predicates
 * @since 1.0.0
 */
const answeredWithoutClosing = (state: State): boolean => state.answered && !state.resolving

/**
 * Ends a turn the stream did not end: an interrupt takes the consumer down
 * with the frame and no `Aborted` reaches it (composition brief section 10),
 * and a failed body exits with a cause instead of an event.
 *
 * @category combinators
 * @since 1.0.0
 */
export const close = (ctx: Context, state: State, closing: Closing): Step => {
  if (state.closed) return { state, events: [] }
  const finished = finishReasoning(state, ctx)
  const settled = settleOpenCards(finished.state, ctx, closing)
  // A refused key is the app's own ProviderAuthError; every other provider
  // refusal keeps the composed message, with the provider's words verbatim.
  const error: Protocol.MessageError = closing._tag === "interrupted"
    ? { name: "MessageAbortedError", data: { message: closing.message ?? "The turn was interrupted" } }
    : closing.provider?.code === "authentication"
    ? { name: "ProviderAuthError", data: { providerID: closing.provider.providerID, message: closing.message } }
    : { name: "UnknownError", data: { message: closing.message } }
  // A turn that ended without an answer is red, and the reason names what
  // ended it. It used to be gray unless a usage limit ended it, and gray says
  // one thing, "health is unavailable", which an operator who walked away
  // reads as Jev being down while the run carries on. Nothing was carrying
  // on. A run the harness killed on an unproven claim sat idle under a gray
  // dot reading `failed` for exactly that reason.
  //
  // Which reason it is comes off a typed code every time and never off a
  // sentence (`Health.limitReached`, `EngineDriver.harnessStop`): the
  // provider's normalized code when a usage limit ended it, the harness's own
  // `HarnessError` code when the harness did, and `unknown` when the body
  // exited with neither, where the header's message carries the words.
  //
  // An interrupt stays gray. The person pressed Stop; nothing about the run
  // is theirs to act on, and health genuinely was never judged.
  const stoppedBy = closing._tag === "failed" ? Health.limitReached(closing.provider) : undefined
  const endedBy: Health.Ended | undefined = closing._tag === "interrupted"
    ? undefined
    : answeredWithoutClosing(settled.state)
    ? { code: Health.frameBudget, maxFrames: settled.state.facts.maxFrames }
    : { code: closing.harness?.code ?? "unknown" }
  const decision: Health.Decision = endedBy === undefined
    ? { color: "gray", reason: "interrupted" }
    : stoppedBy !== undefined
    ? { color: "red", reason: Health.limitReason(stoppedBy) }
    : { color: "red", reason: Health.endedReason(endedBy) }
  const marked = finalDecision(
    ctx,
    { ...settled.state, facts: { ...settled.state.facts, stoppedBy, endedBy } },
    decision,
    undefined,
    lastFrame(settled.state)
  )
  const ended = endTurn(marked.state, ctx, {
    finish: "error",
    time: { created: state.createdAt, completed: ctx.now() },
    error
  })
  return {
    state: ended.state,
    events: [...finished.events, ...settled.events, ...marked.events, ...ended.events]
  }
}

/**
 * Ends the cards a turn leaves running when it ends without the event that
 * would settle them: the cell and every open call read as errors carrying
 * why the turn ended, so a Stop leaves no card spinning, in the stream or
 * after a reload. The cell names the frame it opened in, which a park has
 * since reset the counter away from.
 */
const settleOpenCards = (state: State, ctx: Context, closing: Closing): Step => {
  const now = ctx.now()
  const reason = closing.message ?? "interrupted"
  const events: Array<Protocol.Emitted> = []
  const cell = state.cell
  if (cell !== undefined) {
    events.push(partEvent(
      {
        ...base(state),
        id: cell.partID,
        type: "tool",
        callID: cell.callID,
        tool: "cell",
        state: {
          status: "error",
          input: cardInput(cellTitle(cell, cell.frame), { frame: cell.frame + 1 }),
          error: reason,
          metadata: {
            outcome: closing._tag,
            output: cell.prints,
            calls: cell.calls,
            edits: cell.edits,
            source: cell.source
          },
          time: { start: cell.start, end: now }
        }
      },
      now
    ))
  }
  for (const card of Object.values(state.calls)) {
    events.push(partEvent(
      {
        ...base(state),
        id: card.partID,
        type: "tool",
        callID: card.callID,
        tool: card.tool,
        state: {
          status: "error",
          input: card.served,
          error: reason,
          metadata: {},
          time: { start: card.start, end: now }
        }
      },
      now
    ))
  }
  return { state: { ...state, cell: undefined, calls: {} }, events }
}
