import { digestSync } from "@smthrs/crypto"
import type { CiJob } from "@smthrs/sandbox"
import type { SandboxBranch } from "../branch/Sandboxes.vibe"

/**
 * The machine job `job` of `target`'s run runs on: one per run and job name, named by a digest of the two, of the kind
 * the job's `machine` names (the deployment's default when absent).
 */
export const machineOf = (target: CiJob.Target, job: CiJob.JobRef): SandboxBranch => {
  const [owner = "", name = ""] = target.repo.split("/")
  return {
    branchId: `job-${digestSync(`job:${target.run}:${job.name}`).slice(0, 40)}`,
    owner,
    name,
    branch: target.sha,
    forge: "github",
    kind: "job",
    ...(job.machine === undefined ? {} : { machine: job.machine }),
    // Every job of the run shares its artifacts (worker/branch/Artifacts.ts); no other run's box can name them.
    artifacts: digestSync(`run:${target.run}`).slice(0, 40),
  }
}
