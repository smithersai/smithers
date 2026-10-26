import type {
  RepositoryHomeEntry,
  RepositoryHomeFlow,
  RepositoryHomeIssues,
  RepositoryHomeList,
  RepositoryHomeNotice,
  RepositoryHomeRuns,
} from "@smthrs/ui"
import { Home } from "@smthrs/views"
import { COMMANDS } from "../commands/catalog"
import type { FlowRow } from "../flows-ui/schema"
import { issuePath, issuesPath } from "../issues/contract"
import type { ItemSummary } from "../issues/schema"
import { pullPath } from "../pulls/contract"
import type { Run } from "../status/schema"
import { stackPath, TODO_STATE_WORDS, type TodoState, todoPath } from "../todos/contract"
import type { Access, Todo } from "../todos/schema"
import { isoOf } from "../todos/view"
import { codeHref, HOME_INVALID, HOME_UNREADABLE } from "./contract"
import type { CuratedRow, CurrentRow, HomeRow } from "./rows"

// What the page shows of a repository's home, worked out from the rows. Pure: React renders what these answer.

/**
 * The routed repository's page: a home, the repository's own (`declared`) or Smithers' (`curated`), with only the
 * sections the person may see; nothing while it is read; or the tree, with one line when a declared home can't show.
 */
export type HomePage =
  | {
    readonly kind: "home"
    readonly source: "declared" | "curated"
    readonly sections: ReadonlyArray<Home.Section>
    readonly audience: Home.Audience
    /** The views the person may switch to, their own first (SCOPE-14); none when there is only one. */
    readonly views: ReadonlyArray<Home.Audience>
    readonly defaultBranch: string
    readonly askHref: string
    /**
     * The docs index the repository names: its own home's, else Smithers' curated home's; `null` when neither names
     * one. The Docs tab shows only then (docs/features/docs.md).
     */
    readonly docs: string | null
  }
  | { readonly kind: "loading" }
  | { readonly kind: "tree"; readonly notice: string | null }

/** The sections `audience` may see that hold a block. */
const shownTo = (sections: ReadonlyArray<Home.Section>, audience: Home.Audience) =>
  Home.visible(sections, audience).filter((section) => section.blocks.length > 0)

/**
 * The views a person whose own is `own` may switch to on `sections`, their own first: theirs and each lower one that
 * shows something (SCOPE-14). None when that is one view: one view is no choice. A view above their own never shows.
 */
const viewsOf = (sections: ReadonlyArray<Home.Section>, own: Home.Audience): ReadonlyArray<Home.Audience> => {
  const views = [...Home.audiences].reverse().filter((view) => Home.sees(own, view) && shownTo(sections, view).length > 0)
  return views.length > 1 ? views : []
}

/**
 * The page, from the current row and the repository's two homes. The repository's own home wins: once the repository
 * is ready on this device, nothing shows while its home is read; a declared home the person may see shows; a broken
 * one shows the tree under its line. Without one, Smithers' curated home shows, nothing while ChatApi is first asked
 * or the repository's own home is read from what GitHub says, and else the tree. Until ChatApi says who the person is, they see only everyone's sections, or a contributor's on a
 * home open to anyone. A person who switched to a lower view they may see sees its sections instead (SCOPE-14).
 */
export const homePageOf = (current: CurrentRow, home: HomeRow | undefined, curated: CuratedRow | undefined): HomePage => {
  if (current.repoId === null) return { kind: "tree", notice: null }
  const audience = current.audience ?? "everyone"
  const docs = current.docs ?? current.curatedDocs
  const page = (
    source: "declared" | "curated",
    all: ReadonlyArray<Home.Section>,
    defaultBranch: string,
    own: Home.Audience = audience,
  ): HomePage => {
    // Switching follows who the person is, never the home's word: a visitor on a home open to anyone sees its
    // contributors' sections, but has no view to switch to (SCOPE-14).
    const views = viewsOf(all, audience)
    const seen = current.viewing !== null && views.includes(current.viewing) ? current.viewing : own
    return {
      kind: "home",
      source,
      sections: shownTo(all, seen),
      audience: seen,
      views,
      defaultBranch,
      askHref: codeHref(current.owner, current.name, defaultBranch),
      docs,
    }
  }
  if (current.key !== null && current.defaultBranch !== null) {
    if (home === undefined) return { kind: "loading" }
    // The repository's own file is public: opening its contributors' sections to anyone only widens what it shows.
    const widened = Home.widen(audience, home.contributors)
    const sections = home.state === "declared" ? shownTo(home.sections, widened) : []
    if (sections.length > 0) return page("declared", home.sections, current.defaultBranch, widened)
    if (home.state === "invalid") return { kind: "tree", notice: HOME_INVALID }
    if (home.state === "unreadable") return { kind: "tree", notice: HOME_UNREADABLE }
  }
  if (curated?.state === "declared" && curated.defaultBranch !== null) {
    if (shownTo(curated.sections, audience).length > 0) return page("curated", curated.sections, curated.defaultBranch)
  }
  if ((curated === undefined && current.answering) || current.previewing) return { kind: "loading" }
  return { kind: "tree", notice: null }
}

/**
 * The Home and Code tabs' route params once the default branch is known. Code is the tree route at
 * the default branch, whose name may hold a `/`: its first segment is `$ref`, the rest the splat.
 */
export const tabsOf = (page: HomePage, current: CurrentRow) => {
  const branch = page.kind === "home" ? page.defaultBranch : current.defaultBranch
  if (branch === null) return undefined
  const [ref, ...rest] = branch.split("/")
  return { owner: current.owner, repo: current.name, ref: ref!, _splat: rest.join("/"), docs: page.kind === "home" ? page.docs !== null : (current.docs ?? current.curatedDocs) !== null }
}

/** Whether the composer has a slash command for an app block's flow: the button shows only then. */
export const offered = (flow: string): boolean => COMMANDS.some((command) => command.name === flow)

/**
 * What the composer starts with when a prompt, app or flow button names a command line whose command it has, such as
 * `flow.new` or `flow.run release-notes`: `/<line> `; else nothing.
 */
export const draftFor = (flow: string | undefined): string | undefined =>
  flow !== undefined && offered(flow.split(" ")[0]!) ? `/${flow} ` : undefined

/** A file a Markdown block reads, as the home view takes it. */
export type HomeFile =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "failed" }

/** The files the shown home's Markdown blocks read, by path. */
export const filesOf = (
  rows: ReadonlyArray<{ readonly path: string; readonly state: "loading" | "text" | "failed"; readonly text: string | null }>,
): Readonly<Record<string, HomeFile>> =>
  Object.fromEntries(
    rows.map((row) => [row.path, row.state === "text" ? { state: "text", text: row.text ?? "" } : { state: row.state }]),
  )

/** The kinds of live block the shown home holds, so a page reads only the rows it draws. */
export const liveKindsOf = (page: HomePage): ReadonlySet<string> =>
  new Set(page.kind === "home" ? page.sections.flatMap((section) => section.blocks.map((block) => block.type)) : [])

/** How many rows a live block lists before its link to the rest. */
export const LIVE_ROWS = 5

/** Postgres's time, or an ISO one, in ms since the epoch. */
const msOf = (at: string): number => Date.parse(isoOf(at))

const newestFirst = <A extends { readonly updatedAt: string }>(rows: ReadonlyArray<A>) =>
  [...rows].sort((left, right) => msOf(right.updatedAt) - msOf(left.updatedAt))

const listOf = (entries: ReadonlyArray<RepositoryHomeEntry>, href?: string): RepositoryHomeList => ({
  entries: entries.slice(0, LIVE_ROWS),
  total: entries.length,
  ...(href === undefined ? {} : { href }),
})

/**
 * The `issues` block's rows from the synced items: the repository's open issues counted by triage state (a conflict
 * counts as proposed: it needs a person), the proposed ones newest first, and its open pull requests. A repository
 * this deployment doesn't sync says so instead.
 */
export const issuesOf = (
  items: ReadonlyArray<ItemSummary>,
  owner: string,
  name: string,
  repoId: string,
  synced: boolean,
): RepositoryHomeIssues | RepositoryHomeNotice => {
  if (!synced) return { notice: NOT_SYNCED }
  const open = items.filter((item) => item.repoId === repoId && item.state === "open" && item.deletedAt === null)
  const issues = open.filter((item) => item.kind === "issue")
  const entry = (item: ItemSummary): RepositoryHomeEntry => ({
    key: item.id,
    label: `#${item.number}`,
    title: item.title,
    href: item.kind === "pull" ? pullPath(owner, name, item.number) : issuePath(owner, name, item.number),
    at: msOf(item.updatedAt),
  })
  const proposed = issues.filter((item) => item.triage === "proposed" || item.triage === "conflict")
  return {
    proposed: proposed.length,
    accepted: issues.filter((item) => item.triage === "accepted").length,
    notAccepted: issues.filter((item) => item.triage === "not_accepted").length,
    triage: listOf(newestFirst(proposed).map(entry), issuesPath(owner, name)),
    pulls: listOf(newestFirst(open.filter((item) => item.kind === "pull")).map(entry)),
    href: issuesPath(owner, name),
  }
}

/** What an `issues` block says for a repository whose issues this deployment doesn't sync. */
export const NOT_SYNCED = "Not synced"

/** A TODO's state as a status pill's: running while it works, waiting on a person's review, done once merged. */
const TODO_STATUS: Readonly<Record<TodoState, string>> = {
  queued: "queued",
  working: "running",
  in_review: "waiting",
  merged: "done",
  dropped: "cancelled",
  failed: "failed",
}

/** The `stack` block's rows: the TODOs still on the stack, in their order. A person who may not read it sees why. */
export const stackOf = (
  todos: ReadonlyArray<Todo>,
  owner: string,
  name: string,
  access: Access["status"] | undefined,
): RepositoryHomeList | RepositoryHomeNotice => {
  if (access === "sign_in") return { notice: SIGN_IN }
  if (access === "forbidden") return { notice: MEMBERS_ONLY }
  const onStack = todos
    .filter((todo) => todo.position !== null)
    .sort((left, right) => left.position! - right.position!)
    .map((todo): RepositoryHomeEntry => ({
      key: todo.id,
      label: `T${todo.number}`,
      title: todo.title,
      href: todoPath(owner, name, todo.number),
      status: { status: TODO_STATUS[todo.state], label: TODO_STATE_WORDS[todo.state] },
      at: msOf(todo.updatedAt),
    }))
  return listOf(onStack, stackPath(owner, name))
}

/** What a `stack` block says to a person signed out, and to one who isn't a Member. */
export const SIGN_IN = "Sign in"
export const MEMBERS_ONLY = "Members only"

/** A run's state as a status pill's, and its word. */
const RUN_STATUS: Readonly<Record<Run["status"], readonly [string, string]>> = {
  working: ["running", "Working"],
  waiting: ["waiting", "Waiting"],
  needs_you: ["waiting", "Needs you"],
  failed: ["failed", "Failed"],
  done: ["done", "Done"],
}

/** The `runs` block's rows: this person's runs, newest first, and how many of them failed. */
export const runsOf = (runs: ReadonlyArray<Run>): RepositoryHomeRuns => {
  const entries = newestFirst(runs).map((run): RepositoryHomeEntry => {
    const [status, label] = RUN_STATUS[run.status]
    return { key: run.id, title: run.flow, href: `/app/runs/${encodeURIComponent(run.id)}`, status: { status, label }, at: msOf(run.updatedAt) }
  })
  return { ...listOf(entries, "/app/runs"), failed: runs.filter((run) => run.status === "failed").length }
}

/** The `flows` block's buttons: this person's own flows, newest first, each run with `/flow.run <name>`. */
export const flowsOf = (flows: ReadonlyArray<FlowRow>): ReadonlyArray<RepositoryHomeFlow> =>
  newestFirst(flows).map((flow) => ({ flow: `flow.run ${flow.name}`, name: flow.name, title: flow.description }))
