import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "scalar",
  input: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.String)
} as const)
