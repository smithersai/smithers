import { Schema } from "effect"
import {
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATUSES,
  HOST_KINDS,
  SESSION_HARNESSES,
  SESSION_STATUSES,
  TRANSCRIPT_ROLES,
} from "./globalContract"

const When = Schema.NullOr(Schema.String)
const Num = Schema.NullOr(Schema.Number)
const Text = Schema.NullOr(Schema.String)

export const TranscriptEntry = Schema.Struct({
  ts: When,
  role: Schema.Literals(TRANSCRIPT_ROLES),
  label: Text,
  text: Schema.String,
})
export type TranscriptEntry = typeof TranscriptEntry.Type

export const HostNode = Schema.Struct({
  nodeId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(HOST_KINDS),
  labels: Schema.Array(Schema.String),
  online: Schema.Boolean,
  held: Text,
  load1: Num,
  cpuCores: Num,
  memUsedGb: Num,
  memTotalGb: Num,
  diskFreeGb: Num,
  diskTotalGb: Num,
  activeSessions: Schema.Number,
  runnerCapacity: Schema.Number,
  version: Text,
  seenAt: Schema.String,
})
export type HostNode = typeof HostNode.Type

export const ObservedSession = Schema.Struct({
  sessionKey: Schema.String,
  nodeId: Schema.String,
  managed: Schema.Boolean,
  harness: Schema.Literals(SESSION_HARNESSES),
  model: Text,
  accountLabel: Text,
  repo: Text,
  project: Text,
  lane: Text,
  title: Text,
  summary: Text,
  cwd: Text,
  transcriptJson: Schema.optional(Schema.NullOr(Schema.Unknown)),
  status: Schema.Literals(SESSION_STATUSES),
  pid: Num,
  cpuSeconds: Num,
  tokensUsed: Num,
  startedAt: When,
  lastActivityAt: When,
  endedAt: When,
})
export type ObservedSession = typeof ObservedSession.Type

export const ProviderAccount = Schema.Struct({
  accountKey: Schema.String,
  provider: Schema.Literals(ACCOUNT_PROVIDERS),
  label: Schema.String,
  plan: Text,
  status: Schema.Literals(ACCOUNT_STATUSES),
  fiveHourPct: Num,
  weeklyPct: Num,
  scopedPct: Num,
  resetsAt: When,
  grantsJson: Schema.NullOr(Schema.Unknown),
  creditsBalance: Num,
  activeSessions: Schema.Number,
  pools: Schema.Array(Schema.String),
  coolReason: Text,
  coolUntil: When,
  sourceNode: Text,
  checkedAt: Schema.String,
})
export type ProviderAccount = typeof ProviderAccount.Type

const nullable = (type: string) => ({ type: [type, "null"] })

export const HOST_NODE_ROW = {
  type: "object",
  properties: {
    nodeId: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", enum: [...HOST_KINDS] },
    labels: { type: "array", items: { type: "string" } },
    online: { type: "boolean" },
    held: nullable("string"),
    load1: nullable("number"),
    cpuCores: nullable("number"),
    memUsedGb: nullable("number"),
    memTotalGb: nullable("number"),
    diskFreeGb: nullable("number"),
    diskTotalGb: nullable("number"),
    activeSessions: { type: "integer" },
    runnerCapacity: { type: "integer" },
    version: nullable("string"),
    seenAt: { type: "string" },
  },
  required: ["nodeId", "name", "kind", "online", "seenAt"],
  additionalProperties: false,
} as const

export const OBSERVED_SESSION_ROW = {
  type: "object",
  properties: {
    sessionKey: { type: "string" },
    nodeId: { type: "string" },
    managed: { type: "boolean" },
    harness: { type: "string", enum: [...SESSION_HARNESSES] },
    model: nullable("string"),
    accountLabel: nullable("string"),
    repo: nullable("string"),
    project: nullable("string"),
    lane: nullable("string"),
    title: nullable("string"),
    summary: nullable("string"),
    cwd: nullable("string"),
    transcriptJson: {},
    status: { type: "string", enum: [...SESSION_STATUSES] },
    pid: nullable("number"),
    cpuSeconds: nullable("number"),
    tokensUsed: nullable("number"),
    startedAt: nullable("string"),
    lastActivityAt: nullable("string"),
    endedAt: nullable("string"),
  },
  required: ["sessionKey", "nodeId", "managed", "harness", "status"],
  additionalProperties: false,
} as const

export const PROVIDER_ACCOUNT_ROW = {
  type: "object",
  properties: {
    accountKey: { type: "string" },
    provider: { type: "string", enum: [...ACCOUNT_PROVIDERS] },
    label: { type: "string" },
    plan: nullable("string"),
    status: { type: "string", enum: [...ACCOUNT_STATUSES] },
    fiveHourPct: nullable("number"),
    weeklyPct: nullable("number"),
    scopedPct: nullable("number"),
    resetsAt: nullable("string"),
    grantsJson: {},
    creditsBalance: nullable("number"),
    activeSessions: { type: "integer" },
    pools: { type: "array", items: { type: "string" } },
    coolReason: nullable("string"),
    coolUntil: nullable("string"),
    sourceNode: nullable("string"),
    checkedAt: { type: "string" },
  },
  required: ["accountKey", "provider", "label", "status", "checkedAt"],
  additionalProperties: false,
} as const
