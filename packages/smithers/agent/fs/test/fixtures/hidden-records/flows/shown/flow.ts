import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "shown",
  description: "A boolean modelInvocable outranks disableModelInvocation.",
  modelInvocable: true,
  disableModelInvocation: true,
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ number: Schema.Number })
} as const)
