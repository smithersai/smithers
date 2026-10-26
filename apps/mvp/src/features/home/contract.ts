import { Home } from "@smthrs/views"
import type { Role } from "../auth/contract"
import { REPOS_ROUTE } from "../repo/contract"
import { encodePath } from "../repo/paths"

// A repository's own home (decision 0014 §4, docs/features/home.md): what it reads, where its tabs go, the words it
// shows and the records it keeps.

/** The file a repository declares its home in, read at its default branch's head. */
export const HOME_FILE = Home.path

/** The command an `action` block names for New branch: `branch/create`'s slash command. */
export const NEW_BRANCH = "branch.new"

/** The one line under an action that failed: a forge that can't make a branch, or anything else. */
export const ACTION_FAILED = "Couldn't make a branch"

/** The tab that shows the home, and the one that shows the code. */
export const HOME_TAB = "Home"
export const CODE_TAB = "Code"

/** The view switcher's name, and each view's word (SCOPE-14: "switch to contributor or user"). */
export const VIEW_AS = "View as"
export const VIEW_WORDS: Readonly<Record<Home.Audience, string>> = {
  maintainer: "Maintainer",
  contributor: "Contributor",
  everyone: "User",
}

/** The one line over the tree when a declared home can't show. */
export const HOME_INVALID = "Home is invalid"
export const HOME_UNREADABLE = "Couldn't read home"

/**
 * `GET <route>`: who the asker is on the repository (their audience) and Smithers' own curated home for it, `null`
 * when it has none, with only the sections that audience may see (worker/home/Api.ts). Never cached: the answer
 * depends on the session.
 */
export const homeRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/home`

/** The last segment of {@link homeRoute}. */
export const HOME_SEGMENT = "home"

/**
 * Who a person is to a home's sections (`Home.Audience`, decision 0007's roles): a Maintainer or an Admin sees every
 * section; anyone else signed in with a role on the repository, a Member or a Guest, is a contributor; a person with
 * no role, or someone signed out, sees everyone's sections, unless the home opens its contributors' to anyone
 * (`Home.widen`).
 */
export const audienceOf = (role: Role | null): Home.Audience =>
  role === "admin" || role === "maintainer" ? "maintainer" : role === null ? "everyone" : "contributor"

/** `/$owner/$repo/tree/<default branch>`: the code at the default branch, and its workspace with the composer. */
export const codeHref = (owner: string, name: string, defaultBranch: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree/${encodePath(defaultBranch)}`

/**
 * What the home records in the browser (docs/observability.md#a-repositorys-home): each resolve, each file a block
 * reads and each answer of {@link homeRoute}, by outcome. Never a block, a title, a text, a path or a link: only
 * outcomes, audiences, counts, statuses and durations.
 */
export const HOME_TELEMETRY = {
  records: [
    "home.resolve",
    "home.file.load",
    "home.answer",
    "home.action",
    "home.navigate",
    "smithers_web_home_resolves",
    "smithers_web_home_answers",
    "smithers_web_home_actions",
  ],
  fields: [
    "outcome",
    "blocks",
    "sections",
    "audience",
    "flow",
    "skipped",
    "reason",
    "status",
    "durationMs",
    "what",
    "errorCode",
    "smithers.home.outcome",
    "smithers.home.blocks",
    "smithers.home.skipped",
  ],
} as const
