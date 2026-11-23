import { Metric } from "effect"

/** Count of profile page navigations, by outcome. */
export const profileOpens = Metric.counter("smithers_web_profile_opens", {
  description: "Profile pages opened in the browser",
  incremental: true,
})

/** Duration of profile reads in milliseconds. */
export const profileLoadMs = Metric.histogram("smithers_web_profile_load_ms", {
  description: "Milliseconds to load an owner profile",
  boundaries: Metric.exponentialBoundaries({ start: 25, factor: 2, count: 10 }),
})
