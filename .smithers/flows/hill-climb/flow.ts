import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const measure = CiJob.make("measure", {
  steps: [
    { name: "rules", run: "uphill rules" },
    { name: "measure", run: "uphill --compact" },
  ],
})

export default Flow.make("hill-climb", {
  description: "Print Uphill rules and score the repository to rank the highest-leverage hill-climbing opportunities.",
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String,
  },
  success: Schema.Struct({ measure: CiJob.Result }),
  body: (run) => Node.all({ measure: measure.call(run) }),
})
