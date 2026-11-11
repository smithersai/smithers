/**
 * The trace format.
 *
 * The Lean reference binary and this kernel both read this format and print
 * this rendering. The differential tests compare the two outputs line by line,
 * so the rendering shows every field of the state and everything the policy
 * derives from it.
 *
 * Input, one item per line:
 *
 * ```text
 * config required=1,2 maxAttempts=2 maxBatch=4 maxRuns=2 window=5 defaultDuration=60
 * enqueue <id> <priority>
 * withdraw <id>
 * result <run> <check> pass|fail <duration>
 * fixed <id> <attempt>
 * gaveup <id> <attempt> <detail to end of line>
 * foreign <id>
 * start <count>
 * push <run>
 * land <run>
 * blame <run>
 * cancel <run>
 * plan
 * ```
 *
 * `plan` applies the policy's next decision, if it has one.
 *
 * Mirrors `lean/MergeQueue/Trace.lean` definition for definition.
 *
 * @since 0.1.0
 */

import type { Change, Config, Event, Landing, Part, Result, Run, State, Status, Tree } from "./Basic.ts"
import { empty } from "./Basic.ts"
import type { FixBrief } from "./Policy.ts"
import { fixBriefs, plan, wantsCi } from "./Policy.ts"
import { eta, remaining } from "./Predict.ts"
import { ready, step } from "./Step.ts"

const list = (items: ReadonlyArray<string>): string => items.join(",")

const renderPart = (entry: Part): string => `${entry.id}.${entry.rev}`

const renderTree = (entries: Tree): string => list(entries.map(renderPart))

const renderResults = (results: ReadonlyArray<Result>): string =>
  list(results.map((entry) => `${entry.check}${entry.verdict === "pass" ? "p" : "f"}`))

const renderChecks = (checks: ReadonlyArray<number>): string => checks.join("+")

const renderStatus = (status: Status): string => {
  switch (status._tag) {
    case "queued":
      return "queued"
    case "fixing":
      return `fixing(${status.run})`
    case "merged":
      return "merged"
    case "unmergeable":
      return `unmergeable(${status.reason.kind};${
        renderChecks(status.reason.failures)
      };${status.reason.attempts};${status.reason.detail})`
    case "withdrawn":
      return "withdrawn"
  }
}

const renderChange = (change: Change): string =>
  `${change.id}:p${change.priority}:s${change.seq}:r${change.rev}:a${change.attempts}:${renderStatus(change.status)}`

const renderRun = (run: Run, id: number): string =>
  `${id}:${renderTree(run.base)}/${renderTree(run.batch)}:${renderResults(run.results)}`

const renderLanding = (landing: Landing): string =>
  landing.foreign
    ? `foreign:${renderTree(landing.base)}/${renderTree(landing.batch)}`
    : `${landing.run}:${renderTree(landing.base)}/${renderTree(landing.batch)}:${renderResults(landing.results)}`

/**
 * Renders one event as its input line.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderEvent = (event: Event): string => {
  switch (event._tag) {
    case "enqueue":
      return `enqueue ${event.id} ${event.priority}`
    case "withdraw":
      return `withdraw ${event.id}`
    case "result":
      return `result ${event.run} ${event.check} ${event.verdict} ${event.duration}`
    case "fixed":
      return `fixed ${event.id} ${event.attempt}`
    case "gaveUp":
      return `gaveup ${event.id} ${event.attempt} ${event.detail}`
    case "foreign":
      return `foreign ${event.id}`
    case "push":
      return `push ${event.run}`
    case "start":
      return `start ${event.count}`
    case "land":
      return `land ${event.run}`
    case "blame":
      return `blame ${event.run}`
    case "cancel":
      return `cancel ${event.run}`
  }
}

const renderBrief = (brief: FixBrief): string =>
  `${brief.id}.${brief.rev}#${brief.attempt}:${renderChecks(brief.failures)}:${
    brief.ahead.map((entry) => `${entry.id}${entry.fixing ? "f" : "q"}`).join("+")
  }`

/**
 * One line for the whole state and everything derived from it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderState = (config: Config, state: State): string => {
  const planned = plan(config, state)
  const ci = list(
    state.runs.filter((run) => wantsCi(config, state, run)).map((run) =>
      `${run.id}@${eta(config, state.history, run.results)}:${
        renderChecks(remaining(config, state.history, run.results))
      }`
    )
  )
  return [
    `main=${renderTree(state.main)}`,
    `changes=${state.changes.map(renderChange).join(";")}`,
    `runs=${state.runs.map((run) => renderRun(run, run.id)).join(";")}`,
    `next=${state.nextRun},${state.nextSeq}`,
    `pushing=${state.pushing === null ? "-" : state.pushing}`,
    `landed=${state.landed.map(renderLanding).join(";")}`,
    `history=${list(state.history.map((sample) => `${sample.check}:${sample.duration}`))}`,
    `ready=${list(ready(state).map((change) => String(change.id)))}`,
    `plan=${planned === undefined ? "wait" : renderEvent(planned)}`,
    `ci=${ci}`,
    `fix=${fixBriefs(state).map(renderBrief).join(";")}`
  ].join(" | ")
}

/**
 * One input line: a new config, an event, or `plan`.
 *
 * @category parsing
 * @since 0.1.0
 */
export type Line =
  | { readonly _tag: "config"; readonly config: Config }
  | { readonly _tag: "event"; readonly event: Event }
  | { readonly _tag: "plan" }

const nat = (text: string | undefined): number | undefined =>
  text !== undefined && /^[0-9]+$/.test(text) ? Number(text) : undefined

const nats = (text: string): ReadonlyArray<number> | undefined => {
  if (text === "") return []
  const parsed = text.split(",").map(nat)
  return parsed.every((entry) => entry !== undefined) ? parsed : undefined
}

/**
 * The config a trace starts from before its first `config` line.
 *
 * @category parsing
 * @since 0.1.0
 */
export const initialConfig: Config = {
  required: [],
  maxAttempts: 0,
  maxBatch: 1,
  maxRuns: 1,
  window: 1,
  defaultDuration: 0
}

const setting = (config: Config, item: string): Config | undefined => {
  const pieces = item.split("=")
  if (pieces.length !== 2) return undefined
  const [name, value] = pieces as [string, string]
  if (name === "required") {
    const required = nats(value)
    return required === undefined ? undefined : { ...config, required }
  }
  const amount = nat(value)
  if (amount === undefined) return undefined
  switch (name) {
    case "maxAttempts":
      return { ...config, maxAttempts: amount }
    case "maxBatch":
      return { ...config, maxBatch: amount }
    case "maxRuns":
      return { ...config, maxRuns: amount }
    case "window":
      return { ...config, window: amount }
    case "defaultDuration":
      return { ...config, defaultDuration: amount }
    default:
      return undefined
  }
}

const parseConfig = (words: ReadonlyArray<string>): Config | undefined =>
  words.reduce<Config | undefined>(
    (config, item) => config === undefined ? undefined : setting(config, item),
    initialConfig
  )

const numbers = (words: ReadonlyArray<string>): ReadonlyArray<number> | undefined => {
  const parsed = words.map(nat)
  return parsed.every((entry) => entry !== undefined) ? parsed : undefined
}

const event = (parsed: Event): Line => ({ _tag: "event", event: parsed })

/**
 * Reads one input line, or `undefined` for a line that is not in the format.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseLine = (text: string): Line | undefined => {
  const [head, ...words] = text.split(" ") as [string, ...Array<string>]
  if (head === "config") {
    const config = parseConfig(words)
    return config === undefined ? undefined : { _tag: "config", config }
  }
  if (head === "plan") return words.length === 0 ? { _tag: "plan" } : undefined
  if (head === "gaveup") {
    const [id, attempt] = [nat(words[0]), nat(words[1])]
    return id === undefined || attempt === undefined
      ? undefined
      : event({ _tag: "gaveUp", id, attempt, detail: words.slice(2).join(" ") })
  }
  if (head === "result") {
    const [run, check, verdict, duration] = [nat(words[0]), nat(words[1]), words[2], nat(words[3])]
    return words.length !== 4 || run === undefined || check === undefined || duration === undefined
        || (verdict !== "pass" && verdict !== "fail")
      ? undefined
      : event({ _tag: "result", run, check, verdict, duration })
  }
  const values = numbers(words)
  if (values === undefined) return undefined
  const [first, second] = values
  if (values.length === 2 && first !== undefined && second !== undefined) {
    if (head === "enqueue") return event({ _tag: "enqueue", id: first, priority: second })
    if (head === "fixed") return event({ _tag: "fixed", id: first, attempt: second })
    return undefined
  }
  if (values.length !== 1 || first === undefined) return undefined
  switch (head) {
    case "withdraw":
      return event({ _tag: "withdraw", id: first })
    case "foreign":
      return event({ _tag: "foreign", id: first })
    case "push":
      return event({ _tag: "push", run: first })
    case "start":
      return event({ _tag: "start", count: first })
    case "land":
      return event({ _tag: "land", run: first })
    case "blame":
      return event({ _tag: "blame", run: first })
    case "cancel":
      return event({ _tag: "cancel", run: first })
    default:
      return undefined
  }
}

/**
 * Runs one line. A `config` line restarts the queue from empty.
 *
 * @category transitions
 * @since 0.1.0
 */
export const apply = (config: Config, state: State, line: Line): readonly [Config, State] => {
  switch (line._tag) {
    case "config":
      return [line.config, empty]
    case "event":
      return [config, step(config, state, line.event)]
    case "plan": {
      const planned = plan(config, state)
      return [config, planned === undefined ? state : step(config, state, planned)]
    }
  }
}

/**
 * Runs a whole trace and returns what the reference binary prints for it: one
 * state line per input line, or `error` for a line that is not in the format.
 *
 * @category transitions
 * @since 0.1.0
 */
export const replay = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  let config = initialConfig
  let state = empty
  return lines.map((text) => {
    const line = parseLine(text)
    if (line === undefined) return "error"
    ;[config, state] = apply(config, state, line)
    return renderState(config, state)
  })
}
