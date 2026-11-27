import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const score = CiJob.make("uphill", {
  steps: [
    { name: "check", run: "uphill check" },
    { name: "score", run: "uphill --compact" },
  ],
})

export default Flow.make("uphill", {
  description: "Run Uphill continuous metrics, verify metric lines, and score every category.",
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String,
  },
  success: Schema.Struct({ uphill: CiJob.Result }),
  body: (run) => Node.all({ uphill: score.call(run) }),
})
