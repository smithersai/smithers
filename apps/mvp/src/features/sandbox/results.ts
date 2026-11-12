import { SandboxTools } from "@smthrs/sandbox"
import { Schema } from "effect"

// The sandbox tools' results as this app's machine answers them (docs/features/sandbox-tools.md#the-machine): the
// package's, with a write numbered in the order the machine wrote (worker/branch/Machine.ts).

/**
 * `sandbox/write`'s result, with the write's place in the machine's writes: a Save marks it (docs/features/coedit.md#saved).
 * A write a machine answered before writes were numbered has none.
 */
export const WriteResult = Schema.Struct({
  ...SandboxTools.WriteResult.fields,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

/** Any tool's result, a write's with its sequence. */
export const ToolResult = Schema.Union([
  SandboxTools.RunResult,
  SandboxTools.ReadResult,
  WriteResult,
  SandboxTools.ListResult,
  SandboxTools.StatusResult,
  SandboxTools.DiffResult,
])
export type ToolResult = typeof ToolResult.Type
