import { Schema } from "effect"
import { REPOSITORY, STEP_STATES, STEPS } from "./contract"

// The first run's one row on a tab (docs/features/first-run.md): what `/app` shows in the composer's place. In memory
// only: it is worked out again from the rows it reads whenever one changes.

/** The key of the one row. */
export const FIRST_RUN = "first-run"

/** A step as the list shows it: which one, and where it stands. */
export const Step = Schema.Struct({
  id: Schema.Literals([...STEPS, REPOSITORY]),
  state: Schema.Literals(STEP_STATES),
})
export type Step = typeof Step.Type

/**
 * What the composer's place shows on `/app`:
 * - `hidden`: not a first run (the person has a conversation of their own, or opened the composer to ask): the gate;
 * - `wait`: not known yet (who is signed in, their model or their conversations): nothing;
 * - `steps`: the list, with `at` the step the person is on.
 */
export const FirstRunRow = Schema.Struct({
  id: Schema.Literal(FIRST_RUN),
  show: Schema.Literals(["hidden", "wait", "steps"]),
  at: Schema.NullOr(Schema.Literals([...STEPS, REPOSITORY])),
  steps: Schema.Array(Step),
})
export type FirstRunRow = typeof FirstRunRow.Type
