import type { ComposerAccess, OwnModel } from "../auth/contract"
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

/** Whether the person saved a model of their own, as `ComposerGate` reads it: `loading` until their rows are ready. */
export const ownOf = (saved: number, ready: boolean): OwnModel => (saved > 0 ? "saved" : ready ? "none" : "loading")

/** What the composer's place shows: the first run's row, without its key. */
export type FirstRun = Omit<FirstRunRow, "id">

/** Not a first run: the gate shows. */
export const HIDDEN: FirstRun = { show: "hidden", at: null, steps: [] }

/** Not known yet: nothing shows. */
export const WAITING: FirstRun = { show: "wait", at: null, steps: [] }

/**
 * The first run from:
 * - `access`: what `composerAccess` says stands where the composer goes (src/features/auth/contract.ts);
 * - `hostedModel`: whether the deployment's own model answers this person, as ChatApi said (`undefined` until it says);
 * - `own`: whether they saved a model of their own (`ownOf`);
 * - `conversations`: whether the person has a conversation of their own (`conversationsOf`);
 * - `composerOpen`: whether this tab's composer is open.
 *
 * Nothing while who they are isn't known. A person who may not ask in `/app`'s conversation, the deployment's own
 * repository's, is shown the way to their own (ruling AUTH-8), whatever conversations they have, since the composer's
 * place there is never theirs: Sign in done, Add your model, then Open your repository; nothing until their model's
 * rows are ready. Anyone else: hidden once they have had a conversation, or opened the composer to ask. While their
 * conversations aren't known, a person who may ask keeps the composer (it never waits on the network to show), and one
 * who must sign in sees the steps: a visitor's rows never sync. Else the steps: Sign in; Add your model, unless the
 * deployment's model answers; Ask Smithers. Those before the person's are done, theirs is next.
 */
export const firstRunOf = (input: {
  readonly access: ComposerAccess
  readonly hostedModel: boolean | undefined
  readonly own: OwnModel
  readonly conversations: Conversations
  readonly composerOpen: boolean
}): FirstRun => {
  if (input.access === "wait") return WAITING
  if (input.access === "members_only") {
    if (input.own === "loading") return WAITING
    const saved = input.own === "saved"
    return {
      show: "steps",
      at: saved ? REPOSITORY : "model",
      steps: [
        { id: "sign_in", state: "done" },
        { id: "model", state: saved ? "done" : "next" },
        { id: REPOSITORY, state: saved ? "next" : "later" },
      ],
    }
  }
  if (input.conversations === "some") return HIDDEN
  if (input.conversations === "loading" && input.access !== "sign_in") return input.access === "ask" ? HIDDEN : WAITING
  if (input.access === "ask" && input.composerOpen) return HIDDEN
  const order: ReadonlyArray<StepId> = input.hostedModel === true ? ["sign_in", "ask"] : ["sign_in", "model", "ask"]
  const at: StepId = input.access === "sign_in" ? "sign_in" : input.access === "add_model" ? "model" : "ask"
  const index = order.indexOf(at)
  const steps = order.map((id, position): Step => ({
    id,
    state: position < index ? "done" : position === index ? "next" : "later",
  }))
  return { show: "steps", at, steps }
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
