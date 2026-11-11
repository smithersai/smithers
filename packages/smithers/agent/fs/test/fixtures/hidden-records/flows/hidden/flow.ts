import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "hidden",
  description: "A schema record its author hid from models.",
  modelInvocable: false,
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ number: Schema.Number })
} as const)
