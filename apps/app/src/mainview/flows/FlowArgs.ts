/*
 * The button door's one serialisation: a flow's typed input as the single
 * slash line its grammar parses.
 *
 * Every card used to hand-serialise its own act — `${repoId} ${workspace}
 * ${label}`, `${changeId} ${from} ${to} ${file.path}`, `${snapshot.id}
 * ${workspaceId} --name ${snapshot.name}` — so each card carried a private
 * copy of one grammar from SlashPayload.ts, and a value holding a space was
 * parsed by whatever that copy happened to do. The encoders live here instead:
 * one per flow, beside the grammar they invert, with FlowArgs.test.ts holding
 * the two to each other. A card names its flow and hands over the values.
 *
 * Only the flows whose acts carry STRUCTURE are here. A flow whose whole
 * argument is one id stays `onRunCommand(name, id)`, and the slash door still
 * hands the line a human typed straight through.
 */

import type { SetupManualRequest } from "@smthrs/rpc/RepositorySetup"

/** The typed input of every flow a card raises with structured values. */
export interface FlowInput {
  readonly "app.experimental": { readonly on: boolean }
  readonly "experimental.set": { readonly cardId: string; readonly key: string; readonly value: string }
  readonly "runs.graph.select": { readonly runId: string; readonly nodeId?: string }
  readonly "flow.plan.select": { readonly cardId: string; readonly nodeId?: string }
  readonly "runs.graph.tab": { readonly runId: string; readonly tab: "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "flow.plan.tab": { readonly cardId: string; readonly tab: "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "issues.list": { readonly filter?: "open" | "closed" | "all"; readonly repo?: string }
  readonly "setup.configure": { readonly cardId: string; readonly field: string; readonly value: unknown }
  readonly "setup.view": { readonly cardId: string; readonly view: "flows" | "prompts" | "checks" | "evals" | "test" | "work"; readonly step?: string }
  readonly "setup.work": { readonly cardId: string; readonly stepId: string; readonly field?: "prompt" | "source" | "number"; readonly value?: unknown }
  readonly "setup.run": { readonly cardId: string; readonly operation: "inspect" | "evaluate" | "trial" | "apply" | "pause" | "run"; readonly manual?: SetupManualRequest }
  /** `<name> [owner/repo]` — a schedule's name holds no whitespace, so the repository trails it. */
  readonly "triggers.run": { readonly slug: string; readonly repo?: string }
  /** Carried as JSON: `triggers.pause` declares `grammar: carried(...)`, which reads one object and refuses a positional line. */
  readonly "triggers.pause": { readonly slug: string; readonly repo?: string }
  readonly "wiki.heading": { readonly line: string; readonly cardId?: string }
  readonly "workspace.desktop.open": { readonly bookmark?: string; readonly repo: string }
  readonly "billing.upgrade": { readonly plan: string }
  readonly "runs.list": { readonly repo?: string; readonly status?: string; readonly flow?: string; readonly lineage?: string; readonly sourceCard?: string }
  readonly "runs.attention": { readonly repo?: string; readonly sourceCard?: string }
  readonly "runs.open": { readonly runId: string; readonly repo?: string; readonly sourceCard?: string }
  readonly "runs.trace.select": { readonly runId: string; readonly nodeId: string; readonly seq?: number; readonly sourceCard?: string }
  readonly "approvals.open": { readonly runId: string; readonly sourceCard?: string }
  readonly "tutorial.live.inspect": { readonly cardId: string; readonly eventId: string }
  readonly "files.open-diff": { readonly cardId: string; readonly path: string }
  readonly "issues.view": { readonly number: number; readonly repo?: string; readonly source?: "smithers-cloud" | "github" }
  readonly "prs.view": { readonly number: number; readonly repo?: string }
  readonly "prs.tab": { readonly cardId: string; readonly tab: "conversation" | "commits" | "checks" | "files" }
  readonly "issue.flows": { readonly number: number; readonly repo?: string }
  readonly "issue.repro": { readonly number: number; readonly repo?: string }
  readonly "issue.poc": { readonly number: number; readonly repo?: string }
  readonly "issue.implement": { readonly number: number; readonly repo?: string }
  readonly "issue.add-flow": { readonly number: number; readonly repo?: string; readonly description?: string }
  /** Carried as JSON: a Markdown comment holds newlines, indentation and fences, and its repository need not be loaded. */
  readonly "issues.comment": { readonly number: number; readonly text: string; readonly repo?: string }

  /** Source-qualified launch uses the existing plan/approval/run path. */
  readonly "flow.run": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
    readonly input?: Readonly<Record<string, unknown>>
  }
  /** The same address as a launch, stopping at the plan. */
  readonly "flow.plan": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
    readonly against?: string
    readonly input?: Readonly<Record<string, unknown>>
  }
  /** `<changeId> [from] [to] [path]` — the path is the rest of the line, so it may hold a space. */
  readonly "change.diff": {
    readonly changeId: string
    readonly from?: string
    readonly to?: string
    readonly path?: string
  }
  /** `<changeId> <from> <to>` — a revision pin never holds whitespace. */
  readonly "change.pins": { readonly changeId: string; readonly from: string; readonly to: string }
  readonly "change.facet": { readonly changeId: string; readonly facet: string }
  /** `<changeId> <path>` — the path is the rest of the line. */
  readonly "change.resolve": { readonly changeId: string; readonly path: string }
  /** `<cardId> <field> [value]` — a blank value clears the field (THE FORM LAW). */
  readonly "form.set": { readonly cardId: string; readonly field: string; readonly value: string }
  /** `<runId> <body>` — the body is the rest of the line. */
  readonly "runs.steer": { readonly runId: string; readonly body: string }
  /** `<seat> <name|default>` — neither a seat nor a model name holds whitespace. */
  readonly "model.assign": { readonly seat: string; readonly recordId: string }
  /** The composer's edits (controller/modelCall.ts) ride as JSON: a prompt holds newlines and quotes. */
  readonly "model.prompt": { readonly id: string; readonly system?: string; readonly prompt?: string; readonly maxTokens?: number; readonly temperature?: string }
  readonly "model.state": { readonly id: string; readonly key?: string; readonly kind?: string; readonly value?: string; readonly was?: string; readonly remove?: boolean }
  readonly "model.question": { readonly id: string; readonly question?: string; readonly type?: string; readonly instructions?: string; readonly criteria?: unknown; readonly was?: string; readonly remove?: boolean }
  readonly "model.option": { readonly id: string; readonly question: string; readonly option?: string; readonly about?: string; readonly was?: string; readonly remove?: boolean }

}

/** A flow whose input the card seam hands over as values rather than as a line. */
export type FlowWithInput = keyof FlowInput

type Payload = Readonly<Record<string, unknown>>

/** A value as one token; absent when it is missing or blank, which is what every optional tail means. */
const token = (payload: Payload, key: string): string | undefined => {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === "" ? undefined : text
}

/**
 * `key=value` for a facet the caller named, including an EMPTY one: the
 * targets table clears a filter by giving it blank, which is not the same act
 * as leaving it alone.
 */
const keyed = (payload: Payload, key: string): string | undefined => {
  const value = payload[key]
  return value === undefined || value === null ? undefined : `${key}=${String(value).trim()}`
}

/** The present parts as one line. */
const line = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ")

/** Keep the human shorthand where lossless; JSON carries arbitrary engine IDs. */
const graphLine = (payload: Payload, target: string, value: string): string => {
  const parts = [payload[target], payload[value]].filter((part): part is string => typeof part === "string")
  return parts.some(part => /\s|["{}]/.test(part) || part.length === 0)
    ? JSON.stringify(payload) : parts.join(" ")
}

/**
 * One encoder per flow, in the shape its grammar reads. A tail that may hold
 * whitespace (a path, a label, a message, a template name) is always LAST, or
 * behind the `--name` flag, because that is where the grammar takes the rest
 * of the line.
 */
const ENCODERS: { readonly [N in FlowWithInput]: (payload: Payload) => string } = {
  "app.experimental": payload => payload.on ? "on" : "off",
  "experimental.set": payload => JSON.stringify(payload),
  "runs.graph.select": payload => graphLine(payload, "runId", "nodeId"),
  "flow.plan.select": payload => graphLine(payload, "cardId", "nodeId"),
  "runs.graph.tab": payload => graphLine(payload, "runId", "tab"),
  "flow.plan.tab": payload => graphLine(payload, "cardId", "tab"),
  "issues.list": (payload) => line(token(payload, "filter") ?? "open", token(payload, "repo")),
  "setup.configure": payload => JSON.stringify(payload),
  "setup.view": payload => JSON.stringify(payload),
  "setup.run": payload => JSON.stringify(payload),
  "setup.work": payload => JSON.stringify(payload),
  "billing.upgrade": (payload) => line(token(payload, "plan")),
  "runs.list": (payload) => line(token(payload, "status"), token(payload, "flow"), keyed(payload, "lineage"), keyed(payload, "sourceCard"), token(payload, "repo")),
  "runs.attention": (payload) => line(keyed(payload, "sourceCard"), token(payload, "repo")),
  "runs.open": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId"), token(payload, "repo")),
  "runs.trace.select": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId"), token(payload, "nodeId"), token(payload, "seq")),
  "approvals.open": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId")),
  "tutorial.live.inspect": (payload) => line(token(payload, "cardId"), token(payload, "eventId")),
  "files.open-diff": (payload) => JSON.stringify(payload),
  "issues.view": (payload) => line(token(payload, "number"), token(payload, "repo"), payload.source ? `--source ${payload.source}` : undefined),
  "prs.view": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "prs.tab": (payload) => line(token(payload, "cardId"), token(payload, "tab")),
  "issue.flows": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.repro": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.poc": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.implement": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.add-flow": (payload) => JSON.stringify(payload),
  "issues.comment": (payload) => JSON.stringify(payload),
  "flow.run": (payload) => line(keyed(payload, "sourceCard"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "flow.plan": (payload) => line(keyed(payload, "sourceCard"), keyed(payload, "against"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "change.diff": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to"), token(payload, "path")),
  "change.pins": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to")),
  "change.facet": (payload) => line(token(payload, "changeId"), token(payload, "facet")),
  "change.resolve": (payload) => line(token(payload, "changeId"), token(payload, "path")),
  "form.set": (payload) => line(token(payload, "cardId"), token(payload, "field"), token(payload, "value")),
  "runs.steer": (payload) => line(token(payload, "runId"), token(payload, "body")),
  "model.assign": (payload) => line(token(payload, "seat"), token(payload, "recordId")),
  "model.prompt": (payload) => JSON.stringify(payload),
  "model.state": (payload) => JSON.stringify(payload),
  "model.question": (payload) => JSON.stringify(payload),
  "model.option": (payload) => JSON.stringify(payload),
  "triggers.run": (payload) => line(token(payload, "slug"), token(payload, "repo")),
  "triggers.pause": (payload) => JSON.stringify(payload),
  "wiki.heading": (payload) => line(token(payload, "line"), token(payload, "cardId")),
  "workspace.desktop.open": (payload) => line(token(payload, "bookmark"), token(payload, "repo")),

}

/**
 * One flow's typed input as the slash line its grammar parses.
 *
 * `payloadFor(name, flowArgs(name, input))` gives the input back — FlowArgs.test.ts
 * pins that for every flow here, including the values that hold a space.
 *
 * @category conversions
 */
export const flowArgs = <N extends FlowWithInput>(name: N, input: FlowInput[N]): string =>
  ENCODERS[name]({ ...input } as Payload)

export const graphSelectArgs = (doors: { readonly select: "runs.graph.select" | "flow.plan.select"; readonly target: string }, nodeId?: string): string =>
  doors.select === "runs.graph.select"
    ? flowArgs(doors.select, { runId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })
    : flowArgs(doors.select, { cardId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })

export const graphTabArgs = (doors: { readonly tab: "runs.graph.tab" | "flow.plan.tab"; readonly target: string }, tab: FlowInput["flow.plan.tab"]["tab"]): string =>
  doors.tab === "runs.graph.tab"
    ? flowArgs(doors.tab, { runId: doors.target, tab })
    : flowArgs(doors.tab, { cardId: doors.target, tab })
