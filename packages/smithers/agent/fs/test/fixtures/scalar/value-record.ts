import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "scalar",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String })
} as const)
