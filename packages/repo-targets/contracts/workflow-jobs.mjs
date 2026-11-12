/**
 * What makes a GitHub Actions job advisory.
 *
 * The parser returns a boolean for a literal and strings for expression and
 * quoted forms of `continue-on-error`. Checking only the boolean `true`
 * misses expressions such as `${{ matrix.advisory }}`. Required jobs carry
 * no `continue-on-error` key, on the job or any step.
 */

/** Where `job` sets `continue-on-error`, as `job` or `step <name or index>`; empty for a required job. */
export const advisoryFlags = (job) => [
  ...(job["continue-on-error"] === undefined ? [] : ["job"]),
  ...(job.steps ?? []).flatMap((step, index) =>
    step["continue-on-error"] === undefined ? [] : [`step ${step.name ?? step.id ?? index}`]
  )
]
