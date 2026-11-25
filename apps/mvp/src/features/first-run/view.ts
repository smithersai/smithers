import type { ComposerAccess } from "../auth/contract"
import type { Mine } from "../conversations/schema"
import { isRepository } from "../repo/contract"
import { REPOSITORY, type StepId } from "./contract"
import { FIRST_RUN, type FirstRunRow, type Step } from "./schema"

// What `/app` shows in the composer's place on a first run (decision 0121, docs/features/first-run.md), worked out
// from what the tab knows. Pure, so every frontend and test shares it.

/** Whether the person has had a conversation of their own: `some`, `none`, or not known yet (`loading`). */
export type Conversations = "none" | "some" | "loading"

/**
 * The person's conversations as the first run counts them: `some` once any row of theirs shows (from the device or
 * Electric), archived or not, since archiving one doesn't make them new; `none` once the device knows it has none
 * (`loaded`: restored, and the first sync answered); else `loading`.
 */
export const conversationsOf = (rows: ReadonlyArray<Mine>, loaded: boolean): Conversations =>
  rows.length > 0 ? "some" : loaded ? "none" : "loading"

/** What the composer's place shows: the first run's row, without its key. */
export type FirstRun = Omit<FirstRunRow, "id">

/** Not a first run: the gate shows. */
export const HIDDEN: FirstRun = { show: "hidden", at: null, steps: [] }

/** Not known yet: nothing shows. */
export const WAITING: FirstRun = { show: "wait", at: null, steps: [] }

/** The first-run steps for signing in and opening a conversation. */
export const firstRunOf = (input: {
  readonly access: ComposerAccess
  readonly conversations: Conversations
  readonly hasHistory?: boolean
  readonly composerOpen: boolean
}): FirstRun => {
  if (input.hasHistory === true) return HIDDEN
  if (input.access === "wait") return WAITING
  if (input.access === "members_only") {
    return {
      show: "steps",
      at: REPOSITORY,
      steps: [{ id: "sign_in", state: "done" }, { id: REPOSITORY, state: "next" }],
    }
  }
  if (input.conversations === "some") return HIDDEN
  if (input.access === "ask") {
    if (input.conversations === "loading" || input.composerOpen) return HIDDEN
    return { show: "steps", at: "ask", steps: [{ id: "sign_in", state: "done" }, { id: "ask", state: "next" }] }
  }
  return { show: "steps", at: "sign_in", steps: [{ id: "sign_in", state: "next" }, { id: "ask", state: "later" }] }
}

/**
 * The repository the repository step's field names, as the route's params: `owner/name`, or its GitHub URL
 * (`https://github.com/owner/name`, `.git` and a trailing slash allowed), trimmed; `undefined` for anything else.
 */
export const repositoryNamed = (text: string): { readonly owner: string; readonly repo: string } | undefined => {
  const named = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text.trim())
  if (named === null) return undefined
  const [, owner, repo] = named as unknown as [string, string, string]
  return isRepository(owner, repo) ? { owner, repo } : undefined
}

/** The row `firstRun` is stored as. */
export const rowOf = (firstRun: FirstRun): FirstRunRow => ({ id: FIRST_RUN, ...firstRun })

/** Whether two first runs show the same: the follower writes the row only when it changes. */
export const sameFirstRun = (left: FirstRun, right: FirstRun): boolean =>
  left.show === right.show && left.at === right.at && left.steps.length === right.steps.length &&
  left.steps.every((step, index) => step.id === right.steps[index]!.id && step.state === right.steps[index]!.state)

/**
 * Whether the composer's place shows the gate (and the composer behind it): when it isn't a first run, and at Ask,
 * where the composer's own Chat ⌘K is the step's button. Before Ask, the step's own button stands in its place.
 */
export const showsGate = (firstRun: FirstRun | undefined): boolean =>
  firstRun !== undefined && (firstRun.show === "hidden" || (firstRun.show === "steps" && firstRun.at === "ask"))

/** Whether the first run's list offers sign-in itself: then the header doesn't, so the page has one sign-in action. */
export const offersSignIn = (firstRun: FirstRun | undefined): boolean =>
  firstRun !== undefined && firstRun.show === "steps" && firstRun.at === "sign_in"
