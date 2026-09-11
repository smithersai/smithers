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

/** The typed input of every flow a card raises with structured values. */
export interface FlowInput {
  /** Source-qualified launch uses the existing plan/approval/run path. */
  readonly "flow.run": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
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
  /** `<changeId> <path>` — the path is the rest of the line. */
  readonly "change.resolve": { readonly changeId: string; readonly path: string }
  /** `<cardId> <field> [value]` — a blank value clears the field (THE FORM LAW). */
  readonly "form.set": { readonly cardId: string; readonly field: string; readonly value: string }
  /** `<runId> <body>` — the body is the rest of the line. */
  readonly "runs.steer": { readonly runId: string; readonly body: string }
  /** `<repoId> [key=value…]` — a facet given as an empty value clears it. */
  readonly "target.filter": {
    readonly repoId: string
    readonly mode?: string
    readonly query?: string
    readonly kind?: string
    readonly state?: string
    readonly workspace?: string
  }
  /** `<repoId> [label]` — no label selects the repository's table itself. */
  readonly "target.select": { readonly repoId: string; readonly label?: string }
  /** `<snapshotId> [workspaceId] --name <name>` — the name is the rest of the line. */
  readonly "workspace.template": {
    readonly snapshotId: string
    readonly name: string
    readonly workspaceId?: string
  }
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

/**
 * One encoder per flow, in the shape its grammar reads. A tail that may hold
 * whitespace (a path, a label, a message, a template name) is always LAST, or
 * behind the `--name` flag, because that is where the grammar takes the rest
 * of the line.
 */
const ENCODERS: { readonly [N in FlowWithInput]: (payload: Payload) => string } = {
  "flow.run": (payload) => line(keyed(payload, "sourceCard"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "change.diff": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to"), token(payload, "path")),
  "change.pins": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to")),
  "change.resolve": (payload) => line(token(payload, "changeId"), token(payload, "path")),
  "form.set": (payload) => line(token(payload, "cardId"), token(payload, "field"), token(payload, "value")),
  "runs.steer": (payload) => line(token(payload, "runId"), token(payload, "body")),
  "target.filter": (payload) =>
    line(
      token(payload, "repoId"),
      keyed(payload, "mode"),
      keyed(payload, "kind"),
      keyed(payload, "state"),
      keyed(payload, "workspace"),
      keyed(payload, "query")
    ),
  "target.select": (payload) => line(token(payload, "repoId"), token(payload, "label")),
  "workspace.template": (payload) => {
    const name = token(payload, "name")
    return line(token(payload, "snapshotId"), token(payload, "workspaceId"), name === undefined ? undefined : `--name ${name}`)
  }
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
