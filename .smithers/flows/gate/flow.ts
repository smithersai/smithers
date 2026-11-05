// The apps/mvp gate (decision 0145, ruling FLOW-14): Smithers' merge-queue check, run by the repository-flow spine on
// Cloudflare job machines (apps/mvp/docs/features/ci.md). 16 shards of the suite at once, each on its own `gate`
// machine at exactly the commit, then one job that merges their coverage under the suite's 100% thresholds. The steps
// are apps/mvp/ci/gate.sh's.
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const SHARDS = 16

const install = { name: "install", run: "sh apps/mvp/ci/gate.sh install" }

const shards = Array.from({ length: SHARDS }, (_, index) =>
  CiJob.make(`mvp-${index + 1}`, {
    machine: "gate",
    steps: [install, { name: "suite", run: `sh apps/mvp/ci/gate.sh shard ${index + 1} ${SHARDS}`, timeoutSeconds: 600 }]
  }))

const coverage = CiJob.make("mvp-coverage", {
  machine: "gate",
  needs: shards.map((shard) => shard.job.name),
  steps: [install, { name: "coverage", run: `sh apps/mvp/ci/gate.sh coverage ${SHARDS}`, timeoutSeconds: 600 }]
})

export default Flow.make("gate", {
  payload: { run: Schema.String, repo: Schema.String, sha: Schema.String, ref: Schema.String, event: Schema.String },
  success: Schema.Unknown,
  body: (run) =>
    Node.all({
      ...Object.fromEntries(shards.map((shard) => [shard.job.name, shard.call(run)])),
      coverage: coverage.call(run)
    })
})
