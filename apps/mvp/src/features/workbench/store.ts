import { PlanTree as PlanTreeSchema, type PlanNodeState, type PlanTree } from "@smthrs/app-state"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import type { AttachTransportMode, AudienceRole, PlanTreeNodeItem, WaitlistStatus } from "@smthrs/ui"
import { Context, Data, type Duration, Effect, Layer, Option, Schema, type Scope } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { runners } from "../../boundary"
import type { Role } from "../auth/contract"
import { submitWaitlist as submitWaitlistRequest, waitlistErrorMessage } from "../waitlist/api"

// Workbench state on this tab: three local-only TanStack DB collections of one row each, kept strictly in memory
// (never persisted on disk). Layout state (pane, size, frame, node, cause, audience, diffScope) stays in the URL
// via TanStack Router. All HTTP calls go through Effect HttpClient.

export const PLAN_ROW_ID = "plan"
export const ATTACH_ROW_ID = "attach"
export const WAITLIST_ROW_ID = "waitlist"

export const PLAN_STATUSES = ["idle", "loading", "ready", "empty", "failed"] as const
export type PlanLoadStatus = (typeof PLAN_STATUSES)[number]

const PlanAssumptionRow = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  verified: Schema.Boolean,
})

const PlanTreeItemRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  milestone: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "blocked_on_will", "done", "failed"]),
  depth: Schema.Number,
  sources: Schema.Array(Schema.String),
  assumptions: Schema.Array(PlanAssumptionRow),
})

export const PlanRow = Schema.Struct({
  id: Schema.Literal(PLAN_ROW_ID),
  repoSlug: Schema.String,
  status: Schema.Literals(PLAN_STATUSES),
  nodes: Schema.Array(PlanTreeItemRow),
  totalFrames: Schema.Number,
  error: Schema.NullOr(Schema.String),
})
export type PlanRow = typeof PlanRow.Type

export const AttachRow = Schema.Struct({
  id: Schema.Literal(ATTACH_ROW_ID),
  mode: Schema.Literals(["local-stdio", "remote-http"]),
  state: Schema.Literals(["unattached", "consent_pending", "connected", "revoked"]),
  copied: Schema.Boolean,
})
export type AttachRow = typeof AttachRow.Type

export const WaitlistRow = Schema.Struct({
  id: Schema.Literal(WAITLIST_ROW_ID),
  repoUrl: Schema.String,
  workflowNote: Schema.String,
  status: Schema.Literals(["idle", "submitting", "submitted", "error"]),
  position: Schema.NullOr(Schema.Number),
  errorMessage: Schema.NullOr(Schema.String),
})
export type WaitlistRow = typeof WaitlistRow.Type

export const WORKBENCH_WITHIN: Duration.Input = "15 seconds"

export class PlanSnapshotFailed extends Data.TaggedError("PlanSnapshotFailed")<{
  readonly status?: number
  readonly code: string
}> {}

const SnapshotEnvelope = Schema.Struct({
  hubSeq: Schema.Number,
  state: Schema.NullOr(
    Schema.Struct({
      tree: PlanTreeSchema,
    }),
  ),
})
const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotEnvelope)

/** Convert a PlanTree shard snapshot into ordered, depth-annotated items for @smthrs/ui PlanTree. */
export const planNodesFromTree = (tree: PlanTree): ReadonlyArray<PlanTreeNodeItem> => {
  const byParent = new Map<string | null, Array<PlanNodeState>>()
  for (const node of Object.values(tree.nodes)) {
    const parentKey = node.parent !== null && Object.hasOwn(tree.nodes, node.parent) ? node.parent : null
    const bucket = byParent.get(parentKey)
    if (bucket === undefined) {
      byParent.set(parentKey, [node])
    } else {
      bucket.push(node)
    }
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)))
  }
  const items: Array<PlanTreeNodeItem> = []
  const visited = new Set<string>()
  const walk = (parentId: string | null, depth: number) => {
    const children = byParent.get(parentId)
    if (children === undefined) return
    for (const node of children) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      items.push({
        id: node.id,
        title: node.title,
        milestone: node.milestone,
        status: node.status,
        depth,
        sources: [...node.sources],
        assumptions: node.assumptions.map((assumption, index) => ({
          id: `${node.id}#${index}`,
          text: assumption.text,
          verified: assumption.verified,
        })),
      })
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return items
}

/** Map a repository role strictly downward to a workbench AudienceRole. */
export const roleToAudience = (role: Role | null | undefined): AudienceRole => {
  if (role === "admin" || role === "maintainer") return "maintainer"
  if (role === "member") return "contributor"
  return "visitor"
}

/** Build the zero-secret BYOA MCP attach prompt for a repository and branch. */
export const attachPromptFor = (
  mode: AttachTransportMode,
  origin: string,
  owner: string,
  repo: string,
  branch: string,
): string => {
  const slug = `${owner}/${repo}`
  if (mode === "local-stdio") {
    return `Attach to ${slug} on branch ${branch} using the local Smithers MCP node: smthrs attach --repo ${slug} --branch ${branch}`
  }
  return `Attach to ${slug} on branch ${branch} over Streamable HTTP MCP: ${origin}/api/attach/mcp/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`
}

export const planSnapshotRoute = (origin: string, owner: string, repo: string): string => {
  const shard = `repo:${owner}/${repo}`
  return `${origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/plan/snapshot?shard=${encodeURIComponent(shard)}`
}

export class WorkbenchClient extends Context.Service<
  WorkbenchClient,
  {
    readonly fetchPlan: (
      owner: string,
      repo: string,
    ) => Effect.Effect<{ readonly hubSeq: number; readonly tree: PlanTree | null }, PlanSnapshotFailed>
    readonly joinWaitlist: (input: {
      readonly repoUrl: string
      readonly workflowNote?: string
    }) => Effect.Effect<{ readonly position: number }, string>
  }
>()("@smthrs/mvp/workbench/WorkbenchClient") {
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      WorkbenchClient,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const within = options.within ?? WORKBENCH_WITHIN
        return WorkbenchClient.of({
          fetchPlan: (owner, repo) =>
            http.execute(HttpClientRequest.get(planSnapshotRoute(options.origin, owner, repo))).pipe(
              Effect.timeoutOrElse({
                duration: within,
                orElse: () => Effect.fail(new PlanSnapshotFailed({ code: "timeout" })),
              }),
              Effect.mapError((error) =>
                error instanceof PlanSnapshotFailed ? error : new PlanSnapshotFailed({ code: "unavailable" }),
              ),
              Effect.flatMap((response) => {
                if (response.status === 401) {
                  return Effect.fail(new PlanSnapshotFailed({ status: 401, code: "sign_in_required" }))
                }
                if (response.status === 403) {
                  return Effect.fail(new PlanSnapshotFailed({ status: 403, code: "forbidden" }))
                }
                if (response.status === 404) return Effect.succeed({ hubSeq: 0, tree: null })
                if (response.status !== 200) {
                  return Effect.fail(new PlanSnapshotFailed({ status: response.status, code: "unavailable" }))
                }
                return response.json.pipe(
                  Effect.flatMap((raw) => decodeSnapshot(raw)),
                  Effect.map((body) => ({
                    hubSeq: body.hubSeq,
                    tree: body.state === null ? null : body.state.tree,
                  })),
                  Effect.mapError(() => new PlanSnapshotFailed({ status: 200, code: "invalid_snapshot" })),
                )
              }),
            ),
          joinWaitlist: (input) =>
            submitWaitlistRequest({ origin: options.origin, ...input }).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.map((res) => ({ position: res.position })),
              Effect.mapError((err) => waitlistErrorMessage(err)),
            ),
        })
      }),
    )
}

const planQuery = (rows: Collection.Collection<PlanRow, string>) =>
  LiveQuery.make((q) => q.from({ row: rows.tanstack }).findOne())
const attachQuery = (rows: Collection.Collection<AttachRow, string>) =>
  LiveQuery.make((q) => q.from({ row: rows.tanstack }).findOne())
const waitlistQuery = (rows: Collection.Collection<WaitlistRow, string>) =>
  LiveQuery.make((q) => q.from({ row: rows.tanstack }).findOne())

type Query<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

export class WorkbenchStore extends Context.Service<
  WorkbenchStore,
  {
    readonly plan: Collection.Collection<PlanRow, string>
    readonly planState: Query<typeof planQuery>
    readonly attach: Collection.Collection<AttachRow, string>
    readonly attachState: Query<typeof attachQuery>
    readonly waitlist: Collection.Collection<WaitlistRow, string>
    readonly waitlistState: Query<typeof waitlistQuery>
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/workbench/WorkbenchStore") {
  static readonly layer = Layer.effect(
    WorkbenchStore,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const plan = yield* Collection.local<PlanRow, string>({
        id: "workbench-plan",
        schema: PlanRow,
        getKey: (row) => row.id,
        initialData: [{ id: PLAN_ROW_ID, repoSlug: "", status: "idle", nodes: [], totalFrames: 1, error: null }],
      })
      const attach = yield* Collection.local<AttachRow, string>({
        id: "workbench-attach",
        schema: AttachRow,
        getKey: (row) => row.id,
        initialData: [{ id: ATTACH_ROW_ID, mode: "local-stdio", state: "unattached", copied: false }],
      })
      const waitlist = yield* Collection.local<WaitlistRow, string>({
        id: "workbench-waitlist",
        schema: WaitlistRow,
        getKey: (row) => row.id,
        initialData: [
          {
            id: WAITLIST_ROW_ID,
            repoUrl: "",
            workflowNote: "",
            status: "idle",
            position: null,
            errorMessage: null,
          },
        ],
      })
      return WorkbenchStore.of({
        plan,
        planState: yield* planQuery(plan),
        attach,
        attachState: yield* attachQuery(attach),
        waitlist,
        waitlistState: yield* waitlistQuery(waitlist),
        scope,
      })
    }),
  )
}

const setPlan = (change: Partial<Omit<PlanRow, "id">>) =>
  Effect.flatMap(WorkbenchStore, ({ plan }) =>
    Effect.asVoid(Effect.orDie(plan.update(PLAN_ROW_ID, (draft) => void Object.assign(draft, change)))),
  )

const setAttach = (change: Partial<Omit<AttachRow, "id">>) =>
  Effect.flatMap(WorkbenchStore, ({ attach }) =>
    Effect.asVoid(Effect.orDie(attach.update(ATTACH_ROW_ID, (draft) => void Object.assign(draft, change)))),
  )

const setWaitlist = (change: Partial<Omit<WaitlistRow, "id">>) =>
  Effect.flatMap(WorkbenchStore, ({ waitlist }) =>
    Effect.asVoid(Effect.orDie(waitlist.update(WAITLIST_ROW_ID, (draft) => void Object.assign(draft, change)))),
  )

export const loadPlan = (owner: string, repo: string) =>
  Effect.gen(function* () {
    const slug = `${owner}/${repo}`
    yield* setPlan({ repoSlug: slug, status: "loading", error: null })
    const client = yield* WorkbenchClient
    const outcome = yield* client.fetchPlan(owner, repo).pipe(Effect.result)
    if (outcome._tag === "Failure") {
      yield* setPlan({ repoSlug: slug, status: "failed", nodes: [], totalFrames: 1, error: outcome.failure.code })
      return
    }
    const { hubSeq, tree } = outcome.success
    if (tree === null) {
      yield* setPlan({ repoSlug: slug, status: "empty", nodes: [], totalFrames: Math.max(1, hubSeq + 1), error: null })
      return
    }
    const nodes = planNodesFromTree(tree).map((node) => ({
      id: node.id,
      title: node.title,
      milestone: node.milestone,
      status: node.status,
      depth: node.depth,
      sources: [...(node.sources ?? [])],
      assumptions: [...(node.assumptions ?? [])],
    }))
    yield* setPlan({
      repoSlug: slug,
      status: nodes.length === 0 ? "empty" : "ready",
      nodes,
      totalFrames: Math.max(1, hubSeq + 1),
      error: null,
    })
  }).pipe(Effect.annotateLogs({ feature: "workbench" }))

export const submitWaitlistDraft = Effect.gen(function* () {
  const store = yield* WorkbenchStore
  const current = yield* Effect.sync(() => Option.fromNullishOr(store.waitlist.tanstack.get(WAITLIST_ROW_ID)))
  if (Option.isNone(current)) return
  const { repoUrl, workflowNote } = current.value
  yield* setWaitlist({ status: "submitting", errorMessage: null })
  const client = yield* WorkbenchClient
  const outcome = yield* client
    .joinWaitlist({
      repoUrl,
      ...(workflowNote.trim().length > 0 ? { workflowNote } : {}),
    })
    .pipe(Effect.result)
  if (outcome._tag === "Failure") {
    yield* setWaitlist({ status: "error", errorMessage: outcome.failure })
    return
  }
  yield* setWaitlist({ status: "submitted", position: outcome.success.position, errorMessage: null })
}).pipe(Effect.annotateLogs({ feature: "workbench" }))

type Store = WorkbenchStore["Service"]

export interface WorkbenchQueries {
  readonly plan: Store["planState"]["tanstack"]
  readonly attach: Store["attachState"]["tanstack"]
  readonly waitlist: Store["waitlistState"]["tanstack"]
}

export interface WorkbenchActions {
  readonly loadPlan: (owner: string, repo: string) => Promise<void>
  readonly setTransport: (mode: AttachTransportMode) => void
  readonly markCopied: () => void
  readonly setWaitlistRepoUrl: (repoUrl: string) => void
  readonly setWaitlistWorkflowNote: (workflowNote: string) => void
  readonly submitWaitlist: () => Promise<void>
}

export class Workbench extends Context.Service<
  Workbench,
  { readonly queries: WorkbenchQueries; readonly actions: WorkbenchActions }
>()("@smthrs/mvp/workbench/Workbench") {
  static readonly layer = Layer.effect(
    Workbench,
    Effect.gen(function* () {
      const store = yield* WorkbenchStore
      const context = yield* Effect.context<WorkbenchStore | WorkbenchClient>()
      const { runSync: run, runPromise: promise } = runners(context, "workbench")
      return Workbench.of({
        queries: {
          plan: store.planState.tanstack,
          attach: store.attachState.tanstack,
          waitlist: store.waitlistState.tanstack,
        },
        actions: {
          loadPlan: (owner, repo) => promise(loadPlan(owner, repo)),
          setTransport: (mode) => run(setAttach({ mode, copied: false })),
          markCopied: () => run(setAttach({ copied: true })),
          setWaitlistRepoUrl: (repoUrl) => run(setWaitlist({ repoUrl, status: "idle" as WaitlistStatus, errorMessage: null })),
          setWaitlistWorkflowNote: (workflowNote) => run(setWaitlist({ workflowNote })),
          submitWaitlist: () => promise(submitWaitlistDraft),
        },
      })
    }),
  ).pipe(Layer.provideMerge(WorkbenchStore.layer))

  static readonly live = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Workbench.layer.pipe(Layer.provide(WorkbenchClient.layer(options)))
}

export type WorkbenchView = Workbench["Service"]
