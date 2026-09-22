"use server"

import { Flow } from "@smthrs/core"
import { Schema } from "effect"

export default Flow.make({
  name: "orphan",
  description: "Delegates to a flow no host registers.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  flows: ["test/missing"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
})
