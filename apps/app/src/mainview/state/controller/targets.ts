import type { TargetRunState, TargetsView, TargetsViewMode } from "@smthrs/rpc/Cards"
import { TARGET_RUN_STATES, TARGETS_VIEW_MODES } from "@smthrs/rpc/Cards"
import type { Repo, TargetRunFrame } from "@smthrs/rpc/LocalApp"
import { RepoSchema, TargetRunResponseSchema, TargetsQueryResponseSchema } from "@smthrs/rpc/LocalApp"
import {
  reachable,
  RunHistoryResponseSchema,
  TARGET_GRAPH_ROUTES,
  TargetGraphResponseSchema
} from "@smthrs/rpc/TargetGraph"
import { groupLabel, groupRows, isGroupLabel, pickedMembers, targetRows, toggled } from "../../cards/TargetsTable"
import type { Card } from "../AppState"
import { resolveOpenRepo } from "../RepoContext"
import { repoKeyOf, starredTargetId } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import type { ControllerContext } from "./context"

/*
 * Lane L3 (docs/LOCAL-APP.md "Target presentation"): opening a repository
 * through the local origin, and listing its Smithers targets into a trusted
 * typed card. Opening renders nothing; listing is the explicit act that draws
 * the card. The card owns its Run buttons; model output never supplies
 * executable UI. Every store change goes through the dispatcher with its actor.
 */

export interface TargetsController {
  /**
   * `POST /api/repo/open`, then refresh the sidebar's repository mirror.
   * Registering the repository renders nothing; `listTargets` is the explicit
   * act that draws a card.
   */
  readonly openRepo: (request: RepositoryOpenRequest) => Promise<string | void>
  /** List the repository's Smithers targets as the trusted targets card (the explicit act; opening renders nothing). */
  readonly listTargets: (repoId?: string) => Promise<string | void>
  /** `POST /api/targets/run`, then a target-run card fed from the run topic. */
  readonly runTarget: (repoId: string, workspace: string, label: string) => Promise<string | void>
  /**
   * A pattern run (`ci //packages/...`): the verb over a subtree pattern or
   * label, the way CI runs everything. Same card, fed the same way; the CLI
   * resolves the pattern, so no target grant is involved.
   */
  readonly runPattern: (repoId: string, workspace: string, verb: string, pattern: string) => Promise<string | void>
  /** Highlight (and scroll to) the target's row in its targets card. */
  readonly openTarget: (repoId: string, label: string) => string | void
  /**
   * Change the targets table's filter (docs/LOCAL-APP.md "Cards"). `kind` and
   * `state` toggle their chip; `query` and `workspace` replace (blank clears).
   */
  readonly filterTargets: (repoId: string, change: TargetsFilterChange) => string | void
  /**
   * Select a row and open its drawer; the first selection of a label reads
   * its facts (`graph <label> --plan`: declaration site, plan, deps/rdeps).
   * No label closes the drawer.
   */
  readonly selectTarget: (repoId: string, label?: string) => Promise<string | void>
  /** Star a target for the Featured view (persisted per repository path), or take the star back. */
  readonly starTarget: (repoId: string, label: string, starred: boolean) => string | void
  /** Expand or collapse a name group's row (`//...:name`). */
  readonly expandTargetGroup: (repoId: string, group: string) => string | void
  /** Pick which members of a name group run: a member label toggles, `all` / `none` set the lot. */
  readonly pickTargets: (repoId: string, group: string, member: string) => string | void
  /** Run every picked member of a name group, one target.run each (the CLI has no `:name` wildcard). */
  readonly runTargetSet: (repoId: string, group: string) => Promise<string | void>
}

export interface TargetsFilterChange {
  /** Featured / All / Recent. */
  readonly mode?: string
  readonly query?: string
  readonly kind?: string
  readonly state?: string
  readonly workspace?: string
}

export type RepositoryOpenRequest =
  | { readonly authorizationId: string; readonly displayName: string }
  | { readonly path: string }

export interface TargetsControllerDependencies {
  readonly nextOrdinal: () => number
  readonly loadRepos: () => Promise<void>
  readonly runs: TargetRunClient
  /** A run's start, announced so a graph card of the same repo can overlay it (controller/targetGraph.ts). */
  readonly onRunStarted?: (repoId: string, runId: string, label: string) => void
}

export const targetsCardId = (repoId: string): string => `targets-${repoId}`
export const targetRunCardId = (runId: string): string => `target-run-${runId}`

/** The transcript can hold the whole run; past this the card keeps the tail. */
const MAX_OUTPUT_CHARS = 200_000

const isRunState = (value: string): value is TargetRunState =>
  (TARGET_RUN_STATES as ReadonlyArray<string>).includes(value)

const isViewMode = (value: string): value is TargetsViewMode =>
  (TARGETS_VIEW_MODES as ReadonlyArray<string>).includes(value)

export const createTargetsController = (
  ctx: ControllerContext,
  dependencies: TargetsControllerDependencies
): TargetsController => {
  const { store, baseUrl } = ctx
  const { nextOrdinal, loadRepos, runs, onRunStarted } = dependencies

  const upsert = (card: Card): void => {
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const patch = <K extends Card["kind"]>(
    id: string,
    kind: K,
    update: (card: Extract<Card, { kind: K }>) => { payload: Extract<Card, { kind: K }>["payload"]; status?: Card["status"] }
  ): void => {
    const existing = store.collections.cards.get(id)
    if (existing === undefined || existing.kind !== kind) return
    const next = update(existing as unknown as Extract<Card, { kind: K }>)
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id,
      patch: { payload: next.payload, ...(next.status === undefined ? {} : { status: next.status }) }
    })
  }

  const loadTargets = async (repo: Repo): Promise<void> => {
    const id = targetsCardId(repo.id)
    /* The Featured view's second source beside the declarations' own `featured`: this user's stars for the path. */
    const starred = starsFor(repo.path)
    upsert({
      id,
      kind: "targets",
      title: `${repo.name} targets`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId: repo.id, repoName: repo.name, status: "pending", targets: [], warnings: [], starred }
    })
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/targets/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id })
      })
    } catch (error) {
      patch(id, "targets", (card) => ({
        payload: { ...card.payload, status: "failed", warnings: [error instanceof Error ? error.message : String(error)] },
        status: "error"
      }))
      return
    }
    if (!response.ok) {
      const message = await ctx.errorMessageOf(response, `The targets query answered ${response.status}`)
      patch(id, "targets", (card) => ({ payload: { ...card.payload, status: "failed", warnings: [message] }, status: "error" }))
      return
    }
    const parsed = TargetsQueryResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) {
      patch(id, "targets", (card) => ({
        payload: { ...card.payload, status: "failed", warnings: ["The targets query answered an unexpected shape."] },
        status: "error"
      }))
      return
    }
    const { targets, warnings } = parsed.data
    patch(id, "targets", (card) => ({ payload: { ...card.payload, status: "done", targets, warnings }, status: "acted" }))
    void loadRuns(repo.id)
  }

  /*
   * The table's "last run" column reads the repository's recorded runs. A
   * read that fails leaves the column at "never run" for every row — the
   * history card is where a failed history read states itself; this column
   * never invents a status.
   */
  const loadRuns = async (repoId: string): Promise<void> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}${TARGET_GRAPH_ROUTES.runs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId })
      })
    } catch {
      return
    }
    if (!response.ok) return
    const parsed = RunHistoryResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return
    patch(targetsCardId(repoId), "targets", (card) => ({ payload: { ...card.payload, runs: parsed.data.runs } }))
  }

  const starsFor = (path: string): Array<string> => {
    const repoKey = repoKeyOf(path)
    return [...store.collections.starredTargets.values()]
      .filter((star) => star.repoKey === repoKey)
      .map((star) => star.label)
      .sort()
  }

  const patchView = (repoId: string, update: (view: TargetsView) => TargetsView): string | void => {
    const id = targetsCardId(repoId)
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    patch(id, "targets", (current) => ({ payload: { ...current.payload, view: update(current.payload.view ?? {}) } }))
  }

  const filterTargets: TargetsController["filterTargets"] = (repoId, change) =>
    patchView(repoId, (view) => {
      const next: TargetsView = { ...view }
      if (change.mode !== undefined) {
        if (isViewMode(change.mode)) next.mode = change.mode
        else delete next.mode
      }
      if (change.query !== undefined) {
        if (change.query.trim() === "") delete next.query
        else next.query = change.query
      }
      if (change.workspace !== undefined) {
        if (change.workspace === "" || change.workspace === "*") delete next.workspace
        else next.workspace = change.workspace
      }
      if (change.kind !== undefined) next.kinds = toggled(view.kinds, change.kind)
      if (change.state !== undefined) {
        next.states = toggled(view.states, change.state).filter(isRunState)
      }
      return next
    })

  const selectTarget: TargetsController["selectTarget"] = async (repoId, label) => {
    const id = targetsCardId(repoId)
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    if (label === undefined || label === "") {
      patchView(repoId, (view) => {
        const { selected: _closed, ...rest } = view
        return rest
      })
      return
    }
    if (!card.payload.targets.some((target) => target.label === label)) {
      return `${label} is not a target of ${card.payload.repoName}.`
    }
    patchView(repoId, (view) => ({ ...view, selected: label }))
    if (card.payload.details?.[label] !== undefined && card.payload.details[label]?.status !== "failed") return
    const setDetail = (detail: NonNullable<Extract<Card, { kind: "targets" }>["payload"]["details"]>[string]): void => {
      patch(id, "targets", (current) => ({
        payload: { ...current.payload, details: { ...current.payload.details, [label]: detail } }
      }))
    }
    setDetail({ status: "pending" })
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}${TARGET_GRAPH_ROUTES.graph}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId, labels: [label], plan: true })
      })
    } catch (error) {
      setDetail({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!response.ok) {
      setDetail({ status: "failed", error: await ctx.errorMessageOf(response, `The graph route answered ${response.status}`) })
      return
    }
    const parsed = TargetGraphResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) {
      setDetail({ status: "failed", error: "The graph route answered an unexpected shape." })
      return
    }
    const node = parsed.data.nodes.find((candidate) => candidate.label === label)
    if (node === undefined) {
      setDetail({ status: "failed", error: `The graph did not include ${label}.` })
      return
    }
    setDetail({
      status: "done",
      node,
      deps: [...reachable(parsed.data.edges, label, "deps")].sort(),
      rdeps: [...reachable(parsed.data.edges, label, "rdeps")].sort()
    })
  }

  const starTarget: TargetsController["starTarget"] = (repoId, label, starred) => {
    const card = store.collections.cards.get(targetsCardId(repoId))
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    const known = isGroupLabel(label)
      ? groupOf(card, label) !== undefined
      : card.payload.targets.some((target) => target.label === label)
    if (!known) return `${label} is not a target of ${card.payload.repoName}.`
    const repo = store.collections.repos.get(repoId)
    const repoKey = repoKeyOf(repo?.path ?? repoId)
    const id = starredTargetId(repoKey, label)
    if (starred) {
      store.dispatch({ type: "target.starred", actor: "user", repoId, star: { id, repoKey, label, starredAt: Date.now() } })
    } else {
      store.dispatch({ type: "target.unstarred", actor: "user", repoId, id })
    }
  }

  /** The name group a `//...:name` label (or a bare name) stands for in a card. */
  const groupOf = (card: Extract<Card, { kind: "targets" }>, group: string) => {
    const label = isGroupLabel(group) ? group : groupLabel(group)
    return groupRows(targetRows(card.payload.targets, card.payload.runs)).find((row) => row.group?.label === label)?.group
  }

  const expandTargetGroup: TargetsController["expandTargetGroup"] = (repoId, group) => {
    const card = store.collections.cards.get(targetsCardId(repoId))
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    const found = groupOf(card, group)
    if (found === undefined) return `${group} is not a group of ${card.payload.repoName}'s targets.`
    patchView(repoId, (view) => ({ ...view, expanded: toggled(view.expanded, found.label) }))
  }

  const pickTargets: TargetsController["pickTargets"] = (repoId, group, member) => {
    const card = store.collections.cards.get(targetsCardId(repoId))
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    const found = groupOf(card, group)
    if (found === undefined) return `${group} is not a group of ${card.payload.repoName}'s targets.`
    const all = found.members.map((row) => row.target.label)
    if (member !== "all" && member !== "none" && !all.includes(member)) {
      return `${member} is not a member of ${found.label}.`
    }
    patchView(repoId, (view) => {
      const picked = { ...view.picked }
      if (member === "all") delete picked[found.label]
      else if (member === "none") picked[found.label] = []
      else picked[found.label] = toggled(picked[found.label] ?? all, member)
      return { ...view, picked }
    })
  }

  const runTargetSet: TargetsController["runTargetSet"] = async (repoId, group) => {
    const card = store.collections.cards.get(targetsCardId(repoId))
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    const found = groupOf(card, group)
    if (found === undefined) return `${group} is not a group of ${card.payload.repoName}'s targets.`
    const members = pickedMembers(found, card.payload.view?.picked)
    if (members.length === 0) return `Nothing picked in ${found.label}.`
    const refusals = await Promise.all(
      members.map((member) => runTarget(repoId, member.target.workspace, member.target.label))
    )
    const failed = refusals.filter((refusal): refusal is string => typeof refusal === "string")
    return failed.length === 0 ? undefined : failed.join("\n")
  }

  const openRepo: TargetsController["openRepo"] = async (request) => {
    const label = "path" in request ? request.path : request.displayName
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/repo/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("path" in request
          ? { path: request.path }
          : { authorizationId: request.authorizationId })
      })
    } catch (error) {
      return `Could not open ${label}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return await ctx.errorMessageOf(response, `Could not open ${label}`)
    const body = (await response.json().catch(() => undefined)) as { repo?: unknown } | undefined
    const parsed = RepoSchema.safeParse(body?.repo)
    if (!parsed.success) return "The server's answer carried no repository."
    /*
     * Opening renders nothing in the transcript (will, 2026-09-01: "remove
     * everything that shows up automatically"). The sidebar pin and the
     * composer's selector name the repository; its targets are an explicit
     * act — /target.list, or the model's target.list — never a card that
     * arrives on its own.
     */
    await loadRepos()
    // An open repository satisfies the files flows' repo-source requirement:
    // a command parked on it (files.read while signed out, nothing open)
    // re-enters the run path now, the way sign-in resumes one.
    ctx.resumeDeferredCommand()
  }

  const listTargets: TargetsController["listTargets"] = async (repoIdArg) => {
    let repo: Repo | undefined
    if (repoIdArg !== undefined && repoIdArg !== "") {
      repo = [...store.collections.repos.values()].find((candidate) => candidate.id === repoIdArg)
      if (repo === undefined) return `No open repository has id ${repoIdArg}.`
    } else {
      const open = resolveOpenRepo(store)
      if ("error" in open) return "Open a repository first — there are no targets to list."
      repo = open.repo
    }
    if (!repo.smithers.detected) return `${repo.name} has no Smithers workspace (${repo.smithers.reason}).`
    await loadTargets(repo)
  }

  /*
   * One run, single target or pattern: the request card appears at once
   * (the server's revalidation can take seconds on a large checkout), adopts
   * the server's run id, then folds every frame of the run topic into the
   * card — per-target rows from the `node` frames, the totals from
   * `summary`, attributed chunks into `nodeOutput`, the raw stream into
   * `output`. The card keeps its stable UI id throughout.
   */
  const startRun = async (request: {
    readonly repoId: string
    readonly label: string
    readonly verb?: string
    readonly pattern?: string
    readonly body: Record<string, unknown>
  }): Promise<string | void> => {
    const { repoId, label } = request
    const id = targetRunCardId(`pending-${crypto.randomUUID()}`)
    upsert({
      id,
      kind: "target-run",
      title: label,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: {
        runId: "",
        repoId,
        label,
        ...(request.verb === undefined ? {} : { verb: request.verb }),
        ...(request.pattern === undefined ? {} : { pattern: request.pattern }),
        status: "running",
        exitCode: null,
        output: "Validating the target against the current repository…\n",
        nodes: [],
        nodeOutput: {}
      }
    })
    const failStart = (message: string): string => {
      patch(id, "target-run", (card) => ({
        payload: { ...card.payload, status: "failed", output: `error: ${message}\n`, endedAt: Date.now() },
        status: "error"
      }))
      return message
    }
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/targets/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body)
      })
    } catch (error) {
      return failStart(`Could not run ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) return failStart(await ctx.errorMessageOf(response, `Could not run ${label}`))
    const parsed = TargetRunResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return failStart("The server's answer carried no run id.")
    const { runId } = parsed.data
    patch(id, "target-run", (card) => ({
      payload: { ...card.payload, runId, output: "", startedAt: Date.now() },
      status: "active"
    }))
    onRunStarted?.(repoId, runId, label)
    const append = (current: string, data: string): string => {
      const joined = current + data
      return joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
    }
    const detach = runs.attach(runId, (frame: TargetRunFrame) => {
      if (frame.type === "stdout" || frame.type === "stderr") {
        patch(id, "target-run", (card) => ({
          payload: {
            ...card.payload,
            output: append(card.payload.output, frame.data),
            ...(frame.label === undefined ? {} : {
              nodeOutput: {
                ...card.payload.nodeOutput,
                [frame.label]: append(card.payload.nodeOutput?.[frame.label] ?? "", frame.data)
              }
            })
          }
        }))
        return
      }
      if (frame.type === "error") {
        patch(id, "target-run", (card) => ({
          payload: { ...card.payload, status: "failed", output: append(card.payload.output, `error: ${frame.message}\n`) },
          status: "error"
        }))
        return
      }
      if (frame.type === "started") {
        patch(id, "target-run", (card) => ({ payload: { ...card.payload, startedAt: frame.at } }))
        return
      }
      if (frame.type === "node") {
        patch(id, "target-run", (card) => {
          const nodes = card.payload.nodes ?? []
          const index = nodes.findIndex((node) => node.label === frame.node.label)
          const merged = index < 0 ? [...nodes, frame.node] : nodes.map((node, at) => (at === index ? { ...node, ...frame.node } : node))
          return { payload: { ...card.payload, nodes: merged } }
        })
        return
      }
      if (frame.type === "summary") {
        patch(id, "target-run", (card) => ({ payload: { ...card.payload, summary: frame.summary } }))
        return
      }
      if (frame.type !== "exit") return
      const failed = frame.code !== 0
      patch(id, "target-run", (card) => ({
        payload: { ...card.payload, status: failed ? "failed" : "done", exitCode: frame.code, endedAt: Date.now() },
        status: failed ? "error" : "acted"
      }))
      detach()
      /* The table's last-run column follows the recording, not this card's fold. */
      void loadRuns(repoId)
    })
    /* Until the recording lands, the row reads "running" from the history's pending record. */
    void loadRuns(repoId)
  }

  const runTarget: TargetsController["runTarget"] = async (repoId, workspace, label) => {
    const targets = store.collections.cards.get(targetsCardId(repoId))
    const target = targets?.kind === "targets"
      ? targets.payload.targets.find(
        (candidate) => candidate.workspace === workspace && candidate.label === label
      )
      : undefined
    if (target?.id === undefined) return `Could not run ${label}: reload repository targets first.`
    return startRun({ repoId, label, body: { repoId, targetId: target.id } })
  }

  const runPattern: TargetsController["runPattern"] = async (repoId, workspace, verb, pattern) =>
    startRun({
      repoId,
      label: `${verb} ${pattern}`,
      verb,
      pattern,
      body: { repoId, workspace, verb, pattern }
    })

  const openTarget: TargetsController["openTarget"] = (repoId, label) => {
    const id = targetsCardId(repoId)
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    if (!card.payload.targets.some((target) => target.label === label)) return `${label} is not a target of ${card.payload.repoName}.`
    /* A filter that hides the row would make the highlight invisible; the pointed-at row wins. */
    patch(id, "targets", (current) => ({
      payload: { ...current.payload, highlighted: label, view: { selected: label } }
    }))
    if (typeof document !== "undefined" && typeof CSS !== "undefined") {
      document.querySelector(`[data-target-row="${CSS.escape(label)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
    void selectTarget(repoId, label)
  }

  return { openRepo, listTargets, runTarget, runPattern, openTarget, filterTargets, selectTarget, starTarget, expandTargetGroup, pickTargets, runTargetSet }
}
