import { Schema } from "effect"

// A boolean flag beside positionals: `deploy --force prod` must keep `prod`
// positional instead of taking it as the value of `--force`.
export default ({
  capabilities: [],
  effects: undefined,
  name: "deploy",
  description: "Boolean flag and positional command fixture.",
  input: Schema.Struct({
    args: Schema.Array(Schema.String),
    force: Schema.optionalKey(Schema.Boolean)
  }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
} as const)
