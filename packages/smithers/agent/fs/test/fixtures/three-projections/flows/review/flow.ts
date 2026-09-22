import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"

export default Flow.make({
  name: "review",
  input: Schema.Struct({
    number: Schema.Number
  }),
  output: Schema.Struct({
    accepted: Schema.Boolean,
    number: Schema.Number
  }),
  body: ({ number }) =>
    Node.succeed({
      accepted: true,
      number
    })
})
