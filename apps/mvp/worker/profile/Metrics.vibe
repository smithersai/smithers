import { Metric } from "effect"

/** GitHub profile reads made by ChatApi, by token source and outcome. */
export const profileReads = Metric.counter("smithers_profile_reads", {
  description: "GitHub owner profile reads by token source and outcome",
  incremental: true,
})

/** Profile route answers, by cache outcome (`hit`, `miss`, `refusal`, `wait`). */
export const profileAnswers = Metric.counter("smithers_profile_answers", {
  description: "Profile API answers by cache outcome",
  incremental: true,
})
