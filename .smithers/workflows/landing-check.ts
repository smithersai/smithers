import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const check = CiJob.make("landing-readiness", {
  steps: [{
    name: "check-numbers",
    run: "node apps/mvp/ci/landing-check.mjs",
    timeoutSeconds: 30
  }]
})

export default Flow.make("landing-check", {
  description: "Check decision and migration numbering and verify that every migration is registered.",
  modelInvocable: false,
  payload: { run: Schema.String, repo: Schema.String, sha: Schema.String, ref: Schema.String, event: Schema.String },
  success: Schema.Unknown,
  body: (run) => check.call(run)
})
