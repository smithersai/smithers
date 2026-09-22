/**
 * The release gate, as a project declares it on disk.
 *
 * `16-fan-out-fan-in.ts` names its gate in code. A project names it here, in
 * `flows/<name>/flow.ts`, and the registry name is the directory: `gate`.
 * Discovery reads this file's metadata without evaluating it, so what an
 * operator sees in `smthrs ls` costs one file read.
 *
 * The module IS the flow. Its body is the gate's own graph, so the descriptor
 * names no `flows` and the bridge runs this file's plan rather than looking a
 * delegate up on the host. The topology lives in `16-gate-topology.ts` because
 * the example beside this one declares the same gate, and a flow file that
 * discovery imports cannot sit in a module cycle.
 *
 * `Annotations.Priority` is the same annotation `Node.priority` writes inside a
 * body, which is the point: priority is a property of a declaration, and it
 * does not matter whether the declaration was typed into a flow body or found
 * in a file. Markdown frontmatter has no spelling for it, so a gate that wants
 * to be scheduled ahead of ordinary work is a module flow.
 */
import { Annotations } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Context, Schema } from "effect"
import { gateBody } from "../../../16-gate-topology.ts"

/** The discovered descriptor: the gate's declaration, its graph, and its priority. */
export default Flow.make("examples/ProjectGate", {
  description: "Runs the release gate's checks, urgent ones first.",
  payload: { target: Schema.String },
  success: Schema.String,
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  annotations: Context.make(Annotations.Priority, 7),
  body: ({ target }: { readonly target: string }) => gateBody(target)
})
