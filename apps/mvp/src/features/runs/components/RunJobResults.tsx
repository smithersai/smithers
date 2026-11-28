import type { CiJob } from "@smthrs/sandbox"
import { StatusPill } from "@smthrs/ui"
import { checkoutForgeLabel, checkoutTransportLabel, pinnedCheckoutStage, type PinnedCheckoutStage } from "../checkoutStage"
import type { reportedJobs } from "../jobResults"

/** Checkout receipts contain these closed codes and an optional process exit code. */
const checkoutFailureWords: Readonly<Record<CiJob.CheckoutFailure | PinnedCheckoutStage, string>> = {
  forge: "Repository access", branch: "Branch setup", clone: "Checkout", verify: "Revision verification",
  init: "Initialize repository", remote: "Configure remote", fetch: "Fetch revision", worktree: "Write working copy",
  other: "Checkout", timed_out: "Timed out", tool_lost: "Tool unavailable", path: "Invalid path",
  not_found: "Not found", not_a_file: "Expected a file", not_a_directory: "Expected a directory",
  not_a_repository: "Expected a repository", too_large: "Too large",
}

export function RunJobResults({ jobs }: { readonly jobs: ReturnType<typeof reportedJobs> }) {
  return jobs.length > 0 ? (
    <section aria-label="Jobs" className="run-page-jobs">
      {jobs.map((job) => <section key={job.name} aria-label={job.name}>
        <h2>{job.name} <StatusPill status={job.outcome} /></h2>
        {job.steps.length > 0 ? <ul>{job.steps.map((step, index) => {
          const transport = checkoutTransportLabel(step.checkoutTransportCause, step.checkoutHttpStatus)
          const forge = checkoutForgeLabel(step.checkoutForge)
          return <li key={index}>
            {step.name} <StatusPill status={step.outcome} />
            {step.checkoutFailure !== undefined ? <span>{checkoutFailureWords[pinnedCheckoutStage(step.checkoutFailure, step.exitCode) ?? step.checkoutFailure]}</span> : null}
            {transport !== undefined ? <span>{transport}</span> : null}
            {forge !== undefined ? <span>{forge}</span> : null}
            {step.exitCode != null && step.exitCode !== 0 ? <span>Exit {step.exitCode}</span> : null}
          </li>
        })}</ul> : null}
      </section>)}
    </section>
  ) : null
}
