import { Metric } from "effect"

// The first run's usage metrics (docs/observability.md#browser): which step people are shown, so how many signed-in
// people the members step stops is a number, and which steps they press from the list.

/** Each time a tab's first run shows a step, by `step`: a step of `STEPS`, or `members`. */
export const steps = Metric.counter("smithers_web_first_run_steps", {
  description: "Times a tab's first run showed a step, by step",
  incremental: true,
})

/** Presses of the first run's own buttons, by `step`. */
export const presses = Metric.counter("smithers_web_first_run_presses", {
  description: "Presses of the first run's buttons, by step",
  incremental: true,
})
