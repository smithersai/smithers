// The first run's contract between the browser and the tests (decision 0121, docs/features/first-run.md): the steps a
// person goes through before their first conversation, their words, and the first run's records. Nothing here imports
// a library, so every side can.

/**
 * The first run's steps for a person who may ask in `/app`'s conversation, in order: signing in, adding their own model,
 * and asking.
 */
export const STEPS = ["sign_in", "model", "ask"] as const

/** One of {@link STEPS}. */
export type StepId = (typeof STEPS)[number]

/**
 * The last step for a person who may not ask in `/app`'s conversation, the deployment's own repository's (ruling
 * AUTH-8): opening a repository of their own, where they ask instead of {@link STEPS}' `ask`.
 */
export const REPOSITORY = "repository"

/** A step the list shows: one of {@link STEPS}, or {@link REPOSITORY}. */
export type ShownStep = StepId | typeof REPOSITORY

/** Where a step stands: `done`, `next` (the one to do now, with its button) or `later`. */
export const STEP_STATES = ["done", "next", "later"] as const
export type StepState = (typeof STEP_STATES)[number]

// The first run's copy. Open settings is the gate's button (OPEN_SETTINGS, src/features/auth/contract.ts); Install is
// the repository page's (INSTALL, src/features/repo/contract.ts).

/** The list's name, for assistive technology. */
export const GET_STARTED = "Get started"

/** Each step's title. */
export const STEP_TITLES: Readonly<Record<ShownStep, string>> = {
  sign_in: "Sign in",
  model: "Add your model",
  ask: "Ask Smithers",
  repository: "Open your repository",
}

/** The repository step's field, for assistive technology, and what it holds. */
export const REPOSITORY_FIELD = "Repository"
export const REPOSITORY_PLACEHOLDER = "owner/name"

/** The repository step's button: opens the repository named in its field. */
export const OPEN = "Open"

/** What a done step's mark says to assistive technology; the mark itself is ✓. */
export const DONE = "Done"

/**
 * What the first run records in the browser (docs/observability.md#browser), by name, and the attributes they carry.
 * None carries a login, a repository's name or anything typed.
 */
export const FIRST_RUN_TELEMETRY = {
  records: ["first_run.step", "first_run.press", "smithers_web_first_run_steps", "smithers_web_first_run_presses"],
  fields: ["step", "steps"],
} as const
