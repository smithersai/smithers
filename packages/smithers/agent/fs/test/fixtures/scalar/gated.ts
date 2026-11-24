import { Schema } from "effect"

// Evaluation reports that it started and then waits for the test to release
// it, so a test can act while the import of this module is still pending.
const gate = (globalThis as { fsScalarGate?: { started: () => void; released: Promise<void> } }).fsScalarGate
gate?.started()
await gate?.released

export default ({
  capabilities: [],
  effects: undefined,
  name: "scalar",
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Number
} as const)
