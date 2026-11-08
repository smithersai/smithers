/**
 * Answer a business question with schema discovery, a checked read-only SQL loop, and a chart spec.
 *
 * Port of the 0.x `sql-analyst-dashboard.jsx`. A schema agent maps the
 * database and a planner turns the question into a query plan. A writer drafts
 * SQL and a checker reviews it, told the previous check each round, until the
 * check approves read-only SQL with a LIMIT or `maxSqlAttempts` rounds
 * (default 3) are spent; the last check stands either way. A check that is not
 * approved or not low risk asks a person first, and only an approved or
 * low-risk query runs. A BI agent then writes the dashboard, saying when
 * execution was skipped.
 *
 * 0.x's `<Loop until onMaxReached="return-last">` is the planned recursion `17-review-loop.ts` uses. `ReviewLoop` does not fit: it stops on `approved` alone, while 0.x also requires `readOnly` and `hasLimit`.
 * 0.x's `<Approval>` is a `HumanTask` asked for a typed decision: the run parks until a person answers it.
 * 0.x's prompts ended by asking for the task's output shape; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The approval question's name, which is also the wait point a person answers. */
export const approvalName = "approve-query"

/** The tables, columns and joins the schema agent found. */
export const SchemaMap = Schema.Struct({
  tables: Schema.Array(Schema.Struct({
    name: Schema.String,
    columns: Schema.Array(Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      nullable: Schema.optional(Schema.Boolean)
    })),
    notes: Schema.String
  })),
  joins: Schema.Array(Schema.String)
})

/** How the question will be answered. */
export const QueryPlan = Schema.Struct({
  question: Schema.String,
  requiredTables: Schema.Array(Schema.String),
  metrics: Schema.Array(Schema.String),
  filters: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String)
})

/** One SQL draft. */
export const SqlDraft = Schema.Struct({
  sql: Schema.String,
  rowLimit: Schema.Number,
  explanation: Schema.String
})

/** The checker's verdict on a draft. */
export const SqlCheck = Schema.Struct({
  approved: Schema.Boolean,
  readOnly: Schema.Boolean,
  hasLimit: Schema.Boolean,
  risk: Schema.Literals(["low", "medium", "high"]),
  safeSql: Schema.String,
  rejectedReasons: Schema.Array(Schema.String)
})

/** What running the query returned. */
export const QueryResult = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rowsPreview: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  rowCount: Schema.Number,
  executionMs: Schema.Number
})

/** A person's decision on a risky or rejected query. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reviewer: Schema.String,
  note: Schema.String
})

/** The dashboard the flow settles with. */
export const Dashboard = Schema.Struct({
  answer: Schema.String,
  chartSpec: Schema.Struct({
    type: Schema.Literals(["table", "bar", "line", "scatter", "none"]),
    x: Schema.optional(Schema.String),
    y: Schema.optional(Schema.String),
    series: Schema.optional(Schema.String)
  }),
  caveats: Schema.Array(Schema.String),
  sqlUsed: Schema.String
})

type SqlCheck = typeof SqlCheck.Type
type Approval = typeof Approval.Type

/** The JSON Schema the approval answer must fit; `HumanTask` checks it where the answer arrives. */
const approvalSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    reviewer: { type: "string" },
    note: { type: "string" }
  },
  required: ["approved", "reviewer", "note"]
}

/** Maps the database's tables, columns and joins. */
export const InspectSchema = AgentAction.make("examples/SqlAnalystDashboard/InspectSchema", {
  payload: { database: Schema.String, dialect: Schema.String },
  output: SchemaMap,
  seat,
  system: [
    `You are a database schema analyst. Inspect the available SQLite,
DuckDB, or warehouse schema and summarize tables, columns, join keys, and caveats.`
  ],
  prompt: (input) =>
    `Inspect the database schema. Return tables, columns, likely joins, and caveats for analytics use.\n\nInput: ${
      JSON.stringify(input)
    }`
})

/** Turns the question into a query plan. */
export const PlanQuery = AgentAction.make("examples/SqlAnalystDashboard/PlanQuery", {
  payload: { question: Schema.String, schemaMap: SchemaMap },
  output: QueryPlan,
  seat,
  system: [
    `You are an analytics planner. Convert the business question into a
query plan with required tables, metrics, filters, and data-quality risks.`
  ],
  prompt: (input) =>
    `Plan the analytics query. Identify tables, metrics, filters, and risks needed to answer the business question.\n\nInput: ${
      JSON.stringify(input)
    }`
})

/** Drafts read-only SQL, told the previous round's check. */
export const WriteSql = AgentAction.make("examples/SqlAnalystDashboard/WriteSql", {
  payload: {
    queryPlan: QueryPlan,
    schemaMap: SchemaMap,
    dialect: Schema.String,
    rowLimit: Schema.Number,
    previousCheck: Schema.optional(SqlCheck)
  },
  output: SqlDraft,
  seat,
  system: [
    `You are a SQL writer. Draft read-only SQL for the requested dialect.
Prefer CTEs, clear aliases, and explicit LIMIT clauses. Do not write mutating SQL.`
  ],
  prompt: (input) =>
    `Draft read-only SQL for the supplied dialect. Include a LIMIT and explain how the query answers the plan.\n\nInput: ${
      JSON.stringify(input)
    }`
})

/** Checks a draft and rewrites it safely when it can. */
export const CheckSql = AgentAction.make("examples/SqlAnalystDashboard/CheckSql", {
  payload: { draft: SqlDraft, queryPlan: QueryPlan, dialect: Schema.String, rowLimit: Schema.Number },
  output: SqlCheck,
  seat,
  system: [
    `You are a SQL safety checker. Reject INSERT, UPDATE, DELETE, DROP,
ALTER, CREATE, unsafe functions, missing LIMITs, and queries that ignore the plan.
Return a safe rewritten SQL query when possible.`
  ],
  prompt: (input) =>
    `Check SQL safety. Reject mutating statements, missing LIMIT clauses, and plan drift. Provide safe SQL when approved.\n\nInput: ${
      JSON.stringify(input)
    }`
})

/** Runs the checked SQL read-only. */
export const ExecuteQuery = AgentAction.make("examples/SqlAnalystDashboard/ExecuteQuery", {
  payload: { database: Schema.String, dialect: Schema.String, sql: Schema.String },
  output: QueryResult,
  seat,
  system: [
    `You are a read-only query executor. Run only SQL approved by the
checker against the requested database. Capture columns, row count, preview rows,
and duration. Never execute mutating SQL.`
  ],
  prompt: (input) =>
    `Execute only the approved read-only SQL. Capture columns, preview rows, row count, and duration.\n\nInput: ${
      JSON.stringify(input)
    }`
})

/** Writes the dashboard, executed or not. */
export const MakeDashboard = AgentAction.make("examples/SqlAnalystDashboard/MakeDashboard", {
  payload: {
    question: Schema.optional(Schema.String),
    queryPlan: QueryPlan,
    sqlCheck: SqlCheck,
    queryResult: Schema.NullOr(QueryResult),
    approval: Schema.NullOr(Approval)
  },
  output: Dashboard,
  seat,
  system: [
    `You are a BI analyst. Turn query results into a concise answer,
chart spec, caveats, and the SQL used so a human can audit the result.`
  ],
  prompt: (input) =>
    `Create a concise dashboard answer with chart spec, caveats, and SQL used. Mention when execution was skipped.\n\nInput: ${
      JSON.stringify(input)
    }`
})

type Requirements = Action.Requirement<
  | "examples/SqlAnalystDashboard/WriteSql"
  | "examples/SqlAnalystDashboard/CheckSql"
  | "examples/SqlAnalystDashboard/ExecuteQuery"
>

type Failure = AgentAction.AgentFailure | HumanTask.HumanTaskFailed

/** What the loop ends on: approved, read-only SQL with a LIMIT. */
const querySafe = (check: SqlCheck) => check.approved && check.readOnly && check.hasLimit

/** A check a person must see before the query runs. */
const needsApproval = (check: SqlCheck) => !check.approved || check.risk !== "low"

/** The approval question. Pure, so it is a `Node.map`. */
const question = ({ check }: { readonly check: SqlCheck }) =>
  `Approve SQL analyst query\n\nSQL check risk ${check.risk}; reasons: ${check.rejectedReasons.join(", ") || "none"}`

/** Whether the query may run. Pure, so the branch decides on it. */
const mayExecute = ({ approval, check }: { readonly check: SqlCheck; readonly approval: Approval | null }) =>
  !needsApproval(check) || approval?.approved === true

interface Context {
  readonly queryPlan: Planned.Planned<typeof QueryPlan.Type>
  readonly schemaMap: Planned.Planned<typeof SchemaMap.Type>
  readonly dialect: string
  readonly rowLimit: number
  readonly maxSqlAttempts: number
}

/**
 * Attempt `attempt`: draft, check, and settle on a safe check or the last
 * attempt's check; otherwise draft again, told this check.
 */
const draftAndCheck = (
  context: Context,
  attempt: number,
  previousCheck: Planned.Planned<SqlCheck> | undefined
): Node.Node<SqlCheck, AgentAction.AgentFailure, Requirements> => {
  const { dialect, maxSqlAttempts, queryPlan, rowLimit, schemaMap } = context
  return Node.bindPlanned(
    WriteSql.call({ queryPlan, schemaMap, dialect, rowLimit, previousCheck }),
    Node.capture(
      { dialect, maxSqlAttempts, rowLimit, attempt },
      (draft: Planned.Planned<typeof SqlDraft.Type>) =>
        Node.branch(CheckSql.call({ draft, queryPlan, dialect, rowLimit }), {
          if: querySafe,
          then: Node.capture({}, (check) => Node.succeed(check)),
          else: Node.capture(
            { maxSqlAttempts, attempt },
            (check) => attempt >= maxSqlAttempts ? Node.succeed(check) : draftAndCheck(context, attempt + 1, check)
          )
        })
    )
  )
}

/** Asks a person about `check` when it needs it, and settles with their decision or `null`. */
const approve = (check: Planned.Planned<SqlCheck>): Node.Node<Approval | null, Failure, Requirements> =>
  Node.branch(Node.succeed(check), {
    if: needsApproval,
    then: Node.capture({}, () =>
      Node.bindPlanned(
        Node.map(Node.succeed({ check }), question),
        Node.capture({}, (prompt: Planned.Planned<string>) =>
          HumanTask.decode(Approval)(
            HumanTask.action.call({ name: approvalName, kind: "json", prompt, schema: approvalSchema })
          ))
      )),
    else: Node.capture({}, () => Node.succeed(null))
  })

/** The flow: inspect, plan, draft and check, approve when needed, execute when allowed, report. */
export const SqlAnalystDashboard = Flow.make("examples/SqlAnalystDashboard", {
  payload: {
    question: Schema.optional(Schema.String),
    database: Schema.optional(Schema.String),
    dialect: Schema.optional(Schema.String),
    rowLimit: Schema.optional(Schema.Number),
    maxSqlAttempts: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Dashboard,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: Node.capture({}, ({
    database = "fixtures/sql-analyst/orders.sqlite",
    dialect = "sqlite",
    maxSqlAttempts = 3,
    question: asked,
    rowLimit = 500
  }) =>
    Node.bindPlanned(
      InspectSchema.call({ database, dialect }),
      Node.capture(
        { database, dialect, maxSqlAttempts, asked: asked ?? null, rowLimit },
        (schemaMap: Planned.Planned<typeof SchemaMap.Type>) =>
          Node.bindPlanned(
            PlanQuery.call({
              question: asked ??
                "Which acquisition channel has the highest 90-day gross margin, and is it trending up or down?",
              schemaMap
            }),
            Node.capture(
              { database, dialect, maxSqlAttempts, asked: asked ?? null, rowLimit },
              (queryPlan: Planned.Planned<typeof QueryPlan.Type>) =>
                Node.bindPlanned(
                  draftAndCheck({ queryPlan, schemaMap, dialect, rowLimit, maxSqlAttempts }, 1, undefined),
                  Node.capture({ database, dialect, asked: asked ?? null }, (check: Planned.Planned<SqlCheck>) =>
                    Node.bindPlanned(
                      approve(check),
                      Node.capture(
                        { database, dialect, asked: asked ?? null },
                        (approval: Planned.Planned<Approval | null>) =>
                          Node.bindPlanned(
                            Node.branch(Node.succeed({ check, approval }), {
                              if: mayExecute,
                              then: Node.capture(
                                { database, dialect },
                                () => ExecuteQuery.call({ database, dialect, sql: check.safeSql })
                              ),
                              else: Node.capture({}, () => Node.succeed(null))
                            }),
                            Node.capture(
                              { asked: asked ?? null },
                              (queryResult: Planned.Planned<typeof QueryResult.Type | null>) =>
                                // 0.x handed the dashboard the raw question, without the planner's default.
                                MakeDashboard.call({
                                  ...(asked === undefined ? {} : { question: asked }),
                                  queryPlan,
                                  sqlCheck: check,
                                  queryResult,
                                  approval
                                })
                            )
                          )
                      )
                    ))
                )
            )
          )
      )
    ))
})

/** Every step the flow calls, and the human task that parks for the approval. */
export const layer = Layer.mergeAll(
  InspectSchema.layer,
  PlanQuery.layer,
  WriteSql.layer,
  CheckSql.layer,
  ExecuteQuery.layer,
  MakeDashboard.layer
)
