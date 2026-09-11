/*
 * The repository welcome and its three answers.
 *
 * Any time a repository is opened the transcript opens on one card: "Welcome
 * to Smithers. owner/repo is <the catalog's one sentence>." followed by "I am"
 * and three buttons. Each button is the button door of one flow
 * (repo.maintain, repo.contribute, repo.explore), which the slash menu and the
 * agent reach through the same registry entry (THE THREE-DOOR LAW).
 *
 * Maintaining and contributing need GitHub: a human's invocation while the
 * identity answer is definitively signed-out parks the flow (the requirement
 * axis' durable deferral) and renders the sign-in step (auth.prompt); the
 * signed-in answer resumes the parked flow across the OAuth redirect, so the
 * button the visitor pressed is what runs once they are back. The model's
 * invocation renders the step and fails honestly, since a model must not
 * enqueue work that fires after its turn ends.
 *
 * Nothing here is invented: the activity sentence comes from the public
 * activity route or the card says it is not available yet; the guide
 * documents are the ones the repository holds, read through the same public
 * contents route files.read uses.
 *
 * The home pane (repo.home) is the repository's own first card, above the
 * welcome: the blocks its .smithers/FACTORY.ts declares with
 * `export const home = Smithers.Factory.Home`, projected to
 * .smithers/home.json and read through the same public contents route. A
 * repository without the file has no home card; a file that is not a home
 * pane (raw HTML included) renders nothing and the flow says why. The
 * featured flows a flows block shows come from the `flows` rows of
 * .smithers/factory.json, never from the block.
 *
 * The feature sketch (feature.prototype) is a run of kind prototype (Factory
 * design session 2026-09-07 §6b): the same launch path flow.run proves, on
 * the workspace's `prototype` flow, tracked by the same run card. The same
 * sign-in gate as contributing parks a signed-out visitor on the auth.prompt
 * step before anything is provisioned.
 */
import { publicRepoActivityPath } from "@smthrs/rpc/AgentApiRoutes"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, featuredFlows } from "@smthrs/rpc/FactoryProjection"
import { HOME_PANE_PATH, parseHomeDocument } from "@smthrs/rpc/HomePane"
import type { HomeBlock } from "@smthrs/rpc/HomePane"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "../seams/SeamContext"
import type { ControllerContext } from "./context"
import { isFlowNotFound } from "./gateway"
import type { WorkflowController } from "./workflows"

type OnboardingCard = Extract<Card, { kind: "repo-onboarding" }>
type OnboardingPayload = OnboardingCard["payload"]
type HomeCard = Extract<Card, { kind: "repo-home" }>
type HomePayload = HomeCard["payload"]
type Activity = NonNullable<Extract<OnboardingPayload, { stage: "maintain" }>["activity"]>

export type Answer = Promise<string | void | { readonly value: string }>

export interface OnboardingController {
  /** `repo.welcome [owner/repo]`: the opener card with the three doors. */
  readonly welcomeRepo: (repo?: string) => Answer
  /** `repo.maintain [owner/repo]`: sign-in when signed out, then the activity sentence and the maintainer's reads. */
  readonly maintainRepo: (repo?: string) => Answer
  /** `repo.contribute [owner/repo]`: sign-in when signed out, then the three contributor doors. */
  readonly contributeRepo: (repo?: string) => Answer
  /** `repo.explore [owner/repo]`: what the wiki is, the repository's guide documents, and the invitation to ask. */
  readonly exploreRepo: (repo?: string) => Answer
  /** `repo.home [owner/repo]`: the repository's home pane, the blocks its .smithers/FACTORY.ts declares, read from .smithers/home.json. */
  readonly homeRepo: (repo?: string) => Answer
  /** `feature.prototype <request> [owner/repo]`: start a run of kind prototype on the request. */
  readonly prototypeFeature: (request: string, repo?: string) => Answer
}

/*
 * Run kinds and seats (factory-spec review RULINGS 42, Will, 2026-09-08).
 * `prototype` is the throwaway kind: exploration nobody promotes. Choosing it
 * over implement is the cost lever the ruling allows on this path, and the
 * only one. Its sibling kind `implement` runs on the smart seat, first try
 * included, so a lane adding an implement launch here must not send a
 * `fast`/`cheap` seat, a `tier` hint, or a model id with it. Nothing on this
 * path names a seat at all: the launch names the flow and
 * the kind, and the workspace flow's own declaration is the seat authority
 * (a markdown flow with no `model:` frontmatter asks for `smart`,
 * packages/smithers/flows/core/src/Markdown.ts). Pinned by
 * implementSeat.test.ts and by the launch-payload test in onboarding.test.ts.
 */
/** The flow a prototype run launches on the workspace (design session §6: `/prototype <goal>`). */
export const PROTOTYPE_FLOW_ID = "prototype"
/** The run kind the prototype's card carries. */
export const PROTOTYPE_RUN_KIND = "prototype"

export interface OnboardingDependencies {
  readonly nextOrdinal: () => number
  /** The requirement axis' durable park (AppController.deferCommand). */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  /** The sign-in step, rendered into the chat (auth.prompt). */
  readonly promptSignIn: () => void
  /** The one launch path (flow.run's): guards, the workspace, the launch, the run card. */
  readonly workflows: Pick<
    WorkflowController,
    "workflowIdentityGuard" | "workflowBalanceGuard" | "provisionWorkspace" | "launchWorkflow"
  >
}

/** The maintainer's reads, in button order; only the ones this host registers reach the card. */
export const MAINTAINER_FLOWS: ReadonlyArray<string> = ["issues.list", "prs.list", "runs.list", "triggers.list"]

/** The guide documents an explore looks for at the repository root, in display order. */
const ROOT_GUIDES: ReadonlyArray<string> = ["README.md", "CONTRIBUTING.md", "llms.txt"]
/** The docs index an explore looks for inside a `docs` directory. */
const DOCS_INDEXES: ReadonlyArray<string> = ["README.md", "index.md"]

export const ACTIVITY_UNAVAILABLE = "Recent activity is not available yet."
export const noHomePane = (repo: string): string => `${repo} declares no home pane: it has no ${HOME_PANE_PATH}.`
export const noFlowCatalog = (repo: string): string =>
  `${repo} has no ${FACTORY_PROJECTION_PATH}, so its featured flows are not published yet.`
export const NO_CONTRIBUTING_GUIDE = "This repository has no CONTRIBUTING.md."

/** The sentence the welcome speaks: the catalog's summary as a predicate of the repository name. */
export const welcomeSentence = (repo: string, summary: string | null): string =>
  summary === null ? `Welcome to Smithers. This is ${repo}.` : `Welcome to Smithers. ${repo} is ${summary}`

/**
 * The catalog's sentence names the product ("Smithers is a durable …"); the
 * welcome names the repository ("smithersai/smithers is a durable …"), so a
 * leading "<name> is " comes off when it is the repository's own short name.
 */
export const summaryPredicate = (repo: string, summary: string | undefined): string | null => {
  if (summary === undefined) return null
  const text = summary.trim()
  if (text === "") return null
  const name = repo.slice(repo.indexOf("/") + 1).toLowerCase()
  const match = /^(\S+)\s+is\s+(.+)$/s.exec(text)
  if (match !== null && match[1]!.toLowerCase() === name) return match[2]!
  return text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The text of one contents-route file record, decoding base64 when the route says so; null for a directory or an unreadable body. */
export const fileText = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.content !== "string") return null
  if (body.encoding !== "base64") return body.content
  try {
    const bytes = Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** The featured rows of a .smithers/factory.json text, in catalog order, or null when the text is not a factory projection. */
export const featuredRows = (text: string): Array<{ id: string; summary: string | null }> | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const projection = FactoryProjectionSchema.safeParse(value)
  if (!projection.success) return null
  return featuredFlows(projection.data).map((flow) => ({ id: flow.id, summary: flow.summary }))
}

/** A count as the route states it: a non-negative integer, or null when the mirror could not answer. */
const asCount = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined

/** The activity answer as the card carries it, or null when the body is not the route's contract. */
export const parseActivity = (body: unknown): Activity | null => {
  if (!isRecord(body) || typeof body.sentence !== "string" || body.sentence.trim() === "") return null
  if (!isRecord(body.counts)) return null
  const commits = asCount(body.counts.commits)
  const pullRequests = asCount(body.counts.pullRequests)
  const issues = asCount(body.counts.issues)
  if (commits === undefined || pullRequests === undefined || issues === undefined) return null
  return {
    sentence: body.sentence.trim(),
    counts: { commits, pullRequests, issues },
    since: typeof body.since === "string" ? body.since : ""
  }
}

export const createOnboardingController = (ctx: ControllerContext, deps: OnboardingDependencies): OnboardingController => {
  const { store } = ctx

  const upsert = (id: string, title: string, payload: OnboardingPayload, ordinal = deps.nextOrdinal()): void => {
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id,
        kind: "repo-onboarding",
        title,
        status: "active",
        createdAt: Date.now(),
        ordinal,
        payload
      }
    })
  }

  const upsertHome = (repo: string, payload: HomePayload, ordinal: number): void => {
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: `repo-home-${repo}`,
        kind: "repo-home",
        title: `Home · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal,
        payload
      }
    })
  }

  const contentsUrl = (repo: string, path: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    return path === "" ? base : `${base}/${path.split("/").map(encodeURIComponent).join("/")}`
  }

  /**
   * The definitive signed-out answer gates; unknown or unavailable identity
   * never blocks (the seam discipline: gate on answers, not on silence).
   * Answers the refusal to hand back, or undefined when the flow may run.
   */
  const gate = (flow: string, explicit: string | undefined): string | void => {
    if (!ctx.commands.state().signedOut) return
    if (ctx.commandActor === "user") deps.deferCommand(flow, explicit ?? null, "signed-in")
    deps.promptSignIn()
    return ctx.commandActor === "user"
      ? undefined
      : "Sign in with GitHub first. The sign-in step is already rendered in the chat; point the user at it."
  }

  /** The directory listing's entry names, or the refusal for why it could not be read. */
  const listNames = async (repo: string, path: string): Promise<ReadonlyArray<{ name: string; type: string }> | string> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(contentsUrl(repo, path))
    } catch (error) {
      return `The repository's files could not be listed: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return readErrorMessage(response, `The repository's files could not be listed (HTTP ${response.status}).`)
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return "The repository's file listing was unreadable."
    return body.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === "string" && typeof entry.type === "string" ? [{ name: entry.name, type: entry.type }] : []
    )
  }

  /** One file's text through the public contents route: null when the path is absent, the refusal when it could not be read. */
  const readText = async (repo: string, path: string): Promise<string | null | { readonly refusal: string }> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(contentsUrl(repo, path))
    } catch (error) {
      return { refusal: `${path} in ${repo} could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (response.status === 404) return null
    if (!response.ok) return { refusal: await readErrorMessage(response, `${path} in ${repo} could not be read (HTTP ${response.status}).`) }
    const text = fileText(await response.json().catch(() => null))
    return text === null ? { refusal: `${path} in ${repo} was unreadable.` } : text
  }

  /**
   * The home pane as the card carries it: null when the repository declares
   * none, the refusal when the file is not a home pane or could not be read.
   * A flows block asks the factory projection for the featured rows; an
   * absent or unreadable projection leaves them null with the reason on the
   * payload.
   */
  const readHome = async (repo: string): Promise<HomePayload | null | { readonly refusal: string }> => {
    const text = await readText(repo, HOME_PANE_PATH)
    if (text === null || typeof text !== "string") return text
    const parsed = parseHomeDocument(text)
    if (!parsed.ok) return { refusal: `${repo}: ${parsed.reason}` }
    const blocks: Array<HomeBlock> = parsed.document.blocks
    let featuredFlows: HomePayload["featuredFlows"] = null
    let featuredReason: string | undefined
    if (blocks.some((block) => block.type === "flows")) {
      const projection = await readText(repo, FACTORY_PROJECTION_PATH)
      if (projection === null) featuredReason = noFlowCatalog(repo)
      else if (typeof projection !== "string") featuredReason = projection.refusal
      else {
        featuredFlows = featuredRows(projection)
        if (featuredFlows === null) featuredReason = `${FACTORY_PROJECTION_PATH} in ${repo} is not a factory projection.`
      }
    }
    return { repo, path: HOME_PANE_PATH, blocks, featuredFlows, ...(featuredReason === undefined ? {} : { featuredReason }) }
  }

  /** What the model is told the pane shows: every block, in order, by what it says. */
  const homeValue = (payload: HomePayload): string => {
    const parts = payload.blocks.map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "links":
          return `${block.title ?? "Links"}: ${block.links.map((link) => `${link.label} (${link.url})`).join(", ")}`
        case "flows":
          return payload.featuredFlows === null
            ? payload.featuredReason ?? noFlowCatalog(payload.repo)
            : `${block.title ?? "Featured flows"}: ${
              payload.featuredFlows.map((flow) => (flow.summary === null ? flow.id : `${flow.id} (${flow.summary})`)).join("; ")
            }`
        case "ci-benchmark":
          return `${block.title ?? "CI benchmark"}: ${block.measures.join(", ")} are not measured yet.`
      }
    })
    return `The home pane of ${payload.repo}, declared in its .smithers/FACTORY.ts: ${parts.join(" ")}`
  }

  const welcomeRepo: OnboardingController["welcomeRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const summary = summaryPredicate(repo, store.collections.repositories.get(repo)?.summary)
    // The home pane sits above the welcome. Ordinals are read off the transcript
    // (highest + 1), so the welcome takes the slot after the pane's and the
    // pane, read after the welcome renders, fills the one below it.
    const homeOrdinal = deps.nextOrdinal()
    upsert(`repo-welcome-${repo}`, `Welcome · ${repo}`, { stage: "welcome", repo, summary }, homeOrdinal + 1)
    const home = await readHome(repo)
    if (home !== null && !("refusal" in home)) upsertHome(repo, home, homeOrdinal)
    return {
      value: `${welcomeSentence(repo, summary)} The card asks whether they are maintaining this repo (repo.maintain), contributing to it (repo.contribute), or just exploring (repo.explore).${
        home !== null && !("refusal" in home) ? ` Above it, the repository's home pane (repo.home) shows what it declares.` : ""
      }`
    }
  }

  const homeRepo: OnboardingController["homeRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const home = await readHome(repo)
    if (home === null) return noHomePane(repo)
    if ("refusal" in home) return home.refusal
    upsertHome(repo, home, deps.nextOrdinal())
    return { value: homeValue(home) }
  }

  const maintainRepo: OnboardingController["maintainRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const gated = gate("repo.maintain", explicit)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    let activity: Activity | null = null
    let reason: string | undefined
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${publicRepoActivityPath(repo)}`)
      if (response.status === 404) reason = ACTIVITY_UNAVAILABLE
      else if (!response.ok) reason = await readErrorMessage(response, `Recent activity could not be read (HTTP ${response.status}).`)
      else {
        activity = parseActivity(await response.json().catch(() => null))
        if (activity === null) reason = "The recent-activity answer was malformed."
      }
    } catch (error) {
      reason = `Recent activity could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
    const flows = MAINTAINER_FLOWS.filter((name) => ctx.commands.find(name) !== undefined)
    upsert(`repo-maintain-${repo}`, `Maintaining · ${repo}`, {
      stage: "maintain",
      repo,
      activity,
      ...(reason === undefined ? {} : { reason }),
      flows
    })
    return {
      value: `${activity?.sentence ?? reason ?? ACTIVITY_UNAVAILABLE}${
        flows.length === 0 ? "" : ` The card offers ${flows.join(", ")}.`
      }`
    }
  }

  const contributeRepo: OnboardingController["contributeRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const gated = gate("repo.contribute", explicit)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    const names = await listNames(repo, "")
    const guide = typeof names === "string"
      ? null
      : names.find((entry) => entry.type === "file" && entry.name.toLowerCase() === "contributing.md")?.name ?? null
    const reason = typeof names === "string" ? names : guide === null ? NO_CONTRIBUTING_GUIDE : undefined
    upsert(`repo-contribute-${repo}`, `Contributing · ${repo}`, {
      stage: "contribute",
      repo,
      guide,
      ...(reason === undefined ? {} : { reason })
    })
    return {
      value: `The card offers issues.create (report an issue), feature.prototype (prototype a feature request)${
        guide === null ? `; ${reason}` : `, and files.read ${guide} (learn more about contributing)`
      }`
    }
  }

  const exploreRepo: OnboardingController["exploreRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const root = await listNames(repo, "")
    const guides: Array<{ path: string }> = []
    let reason: string | undefined
    if (typeof root === "string") reason = root
    else {
      for (const wanted of ROOT_GUIDES) {
        const found = root.find((entry) => entry.type === "file" && entry.name.toLowerCase() === wanted.toLowerCase())
        if (found !== undefined) guides.push({ path: found.name })
      }
      const docs = root.find((entry) => entry.type === "dir" && entry.name.toLowerCase() === "docs")
      if (docs !== undefined) {
        const inside = await listNames(repo, docs.name)
        if (typeof inside !== "string") {
          for (const wanted of DOCS_INDEXES) {
            const found = inside.find((entry) => entry.type === "file" && entry.name.toLowerCase() === wanted.toLowerCase())
            if (found !== undefined) {
              guides.push({ path: `${docs.name}/${found.name}` })
              break
            }
          }
        }
      }
      if (guides.length === 0) reason = `${repo} holds none of the guide documents Smithers looks for (README.md, CONTRIBUTING.md, llms.txt, a docs index).`
    }
    upsert(`repo-explore-${repo}`, `Exploring · ${repo}`, {
      stage: "explore",
      repo,
      guides,
      ...(reason === undefined ? {} : { reason })
    })
    return {
      value: guides.length === 0
        ? `${reason ?? ""} Ask any question about ${repo} in the chat.`.trim()
        : `The wiki is ${repo}'s generated guide for humans and agents; Smithers has not generated one yet, so the card lists the repository's guide documents: ${
          guides.map((guide) => guide.path).join(", ")
        }. Ask any question about ${repo} in the chat.`
    }
  }

  /*
   * A run of kind prototype on the request. The sign-in gate parks a
   * signed-out human on the auth.prompt step (resumed after the redirect) and
   * refuses the model; after it, the guards are the ones flow.run applies:
   * the allowlist and the balance. The launch is flow.run's own (provision,
   * then Plan, approve, Run through the gateway seam), and the card it
   * upserts carries the kind, so the run renders as a trace with the
   * never-promoted banner rather than as a second surface.
   *
   * No `prototype` flow ships yet, so the honest answer today is a refusal
   * naming the flow the workspace lacks, never a fake run. The workspace is
   * the only authority on which flows it has (`.smithers/factory.json` lists
   * rules, not flows, and the flow list is a gateway read), so the check
   * comes after provisioning and before anything is planned or approved: the
   * flow.list seam answers first, and a launch the workspace still refuses
   * with ControlError.FlowNotFound (which carries no message) is read off
   * that error's code, never off its prose.
   */
  const prototypeFeature: OnboardingController["prototypeFeature"] = async (request, explicit) => {
    const what = request.trim()
    if (what === "") return "feature.prototype needs what the feature should do"
    const gated = gate("feature.prototype", explicit === undefined ? what : `${what} ${explicit}`)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    const guard = deps.workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const balance = deps.workflows.workflowBalanceGuard()
    if (balance !== undefined) return balance
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const provisioned = await deps.workflows.provisionWorkspace(repo)
    if (provisioned !== true) return provisioned
    const missing = `${repo} has no ${PROTOTYPE_FLOW_ID} flow on its workspace yet, so there is nothing to run the prototype with.`
    const flows = await ctx.gateway.listFlows(repo)
    if (flows.status === "ok" && !flows.value.some((flow) => flow.flowId === PROTOTYPE_FLOW_ID)) return missing
    const launched = await deps.workflows.launchWorkflow({
      repo,
      workflow: PROTOTYPE_FLOW_ID,
      input: { goal: what },
      title: `${PROTOTYPE_RUN_KIND} · ${what.length > 80 ? `${what.slice(0, 79)}…` : what}`,
      kind: PROTOTYPE_RUN_KIND
    })
    // A workspace without the prototype flow says so; the refusal names the flow, never a guess at another.
    if ("message" in launched) return isFlowNotFound(launched.code) ? missing : launched.message
    // The same minimal acknowledgment flow.run answers: the card is the claim surface.
    return { value: `run-started workflow=${PROTOTYPE_FLOW_ID} run=${launched.runId} repo=${repo} kind=${PROTOTYPE_RUN_KIND}` }
  }

  return { welcomeRepo, maintainRepo, contributeRepo, exploreRepo, homeRepo, prototypeFeature }
}
