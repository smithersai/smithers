import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "disabled",
  description: "A schema record its author disabled for models.",
  disableModelInvocation: true,
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ number: Schema.Number })
} as const)
