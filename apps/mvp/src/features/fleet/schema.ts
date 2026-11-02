import { Schema } from "effect"
import { RUN_STATES } from "./contract"

// The fleet's rows as Electric delivers them, columns in camelCase (decision 0143, docs/features/fleet.md): one agent
// run (`agent_runs`) and one runner machine (`runners`). Times are ISO strings; a value an agent or runner didn't report
// is null, never zero.

const When = Schema.NullOr(Schema.String)
const Count = Schema.NullOr(Schema.Number)

/** One generation of an external agent's job: its TODO, agent, runner, state and what it reported. */
export const AgentRun = Schema.Struct({
  key: Schema.String,
  repoId: Schema.String,
  agent: Schema.String,
  generation: Schema.Number,
  runId: Schema.NullOr(Schema.String),
  number: Count,
  title: Schema.NullOr(Schema.String),
  runner: Schema.NullOr(Schema.String),
  /** Only a Maintainer's or Admin's shape carries it. */
  accountLabel: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.Literals(RUN_STATES),
  reason: Schema.NullOr(Schema.String),
  queuedAt: Schema.String,
  claimedAt: When,
  firstEventAt: When,
  lastEventAt: When,
  activityAt: When,
  endedAt: When,
  contextTokens: Count,
  costUsd: Count,
  transcriptBytes: Count,
})
export type AgentRun = typeof AgentRun.Type

/** One runner machine a repository registered: its labels, capacity, last request and the machine's own facts. */
export const Machine = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  capacity: Schema.Number,
  seenAt: When,
  removedAt: When,
  version: Schema.NullOr(Schema.String),
  load1: Count,
  diskFreeGb: Count,
  /** Why the runner takes no job by its own admission rule (`load 31/24`), or null while it admits. */
  held: Schema.optional(Schema.NullOr(Schema.String)),
  /** When a registration through the repository's Admin role authorized it (decision 0148); null: it needs one. */
  repoAuthorizedAt: Schema.optional(When),
})
export type Machine = typeof Machine.Type

/** What `core/agent-runs` and `core/machines` serve a plugin: the rows above, as JSON Schema (`Load.HostFacts`). */
const nullable = (type: string) => ({ type: [type, "null"] })
export const AGENT_RUN_ROW = {
  type: "object",
  properties: {
    key: { type: "string" },
    repoId: { type: "string" },
    agent: { type: "string" },
    generation: { type: "integer" },
    runId: nullable("string"),
    number: nullable("integer"),
    title: nullable("string"),
    runner: nullable("string"),
    accountLabel: nullable("string"),
    state: { type: "string", enum: [...RUN_STATES] },
    reason: nullable("string"),
    queuedAt: { type: "string" },
    claimedAt: nullable("string"),
    firstEventAt: nullable("string"),
    lastEventAt: nullable("string"),
    activityAt: nullable("string"),
    endedAt: nullable("string"),
    contextTokens: nullable("number"),
    costUsd: nullable("number"),
    transcriptBytes: nullable("number"),
  },
  required: ["key", "repoId", "agent", "generation", "state", "queuedAt"],
  additionalProperties: false,
} as const

export const MACHINE_ROW = {
  type: "object",
  properties: {
    id: { type: "string" },
    repoId: { type: "string" },
    name: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    capacity: { type: "integer" },
    seenAt: nullable("string"),
    removedAt: nullable("string"),
    version: nullable("string"),
    load1: nullable("number"),
    diskFreeGb: nullable("number"),
    held: nullable("string"),
    repoAuthorizedAt: nullable("string"),
  },
  required: ["id", "repoId", "name", "labels", "capacity"],
  additionalProperties: false,
} as const
