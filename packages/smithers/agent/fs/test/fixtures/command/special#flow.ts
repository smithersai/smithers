import { Flow } from "@smthrs/core"
import { Schema } from "effect"

export default Flow.make({
  name: "special",
  description: "Special path fixture.",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String
})
