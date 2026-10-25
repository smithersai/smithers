// A person's flow is flow source (decision 0014 §1, as Will ruled on 2026-10-20: "prompt flows are just a type of code
// flow"): one `flow.ts` module whose default export is `Flow.make("<name>", { ... })` from @smthrs/flow, the shape a
// repository's `.smithers/flows/<name>/flow.ts` has. Drafting from a prompt writes one with `renderSource`: a typed
// module whose body is one agent step that follows the drafted instructions. A person may edit it like any code.
// Nothing here imports a library, so the tab, the engine and ChatApi all can.
//
// Where a revision runs is its placement, read from its source, never stored apart from it (ruling FLOW-2's addendum,
// Will, 2026-10-20: "quickjs is a sandbox"):
// - `client`: the person's own engine runs it, drafted or edited, in a fresh QuickJS realm (`RealmFlow`,
//   src/features/flows-ui/flows.ts `flow/run/code`), which gives code nothing but the flow libraries.
// - `sandbox`: code that needs a machine: it imports a module only a machine provides, or declares a capability only a
//   machine grants. It runs only on a host that runs a person's code on a machine (decision 0005), and none does yet,
//   so a run is refused with that reason (`FlowNeedsSandbox`).

/** A flow's one file. */
export const SOURCE_PATH = "flow.ts"

/** Where a revision runs. */
export const PLACEMENTS = ["client", "sandbox"] as const
export type Placement = (typeof PLACEMENTS)[number]

/** What a drafted flow is made of: everything `renderSource` writes that isn't the system's own code. */
export interface Generated {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly flows: ReadonlyArray<string>
}

/** The name of a drafted flow's one step: `<name>/agent`. */
export const stepName = (name: string): string => `${name}/agent`

/** A string as a TypeScript literal: JSON's, which TypeScript reads as the same string. */
const literal = (text: string): string => JSON.stringify(text)

/** The module a drafted flow is: a typed `Flow.make` whose body is one agent step. */
export const renderSource = (flow: Generated): string =>
  [
    "// Drafted by Smithers from a prompt.",
    `import { AgentAction } from "@smthrs/agent"`,
    `import { Flow } from "@smthrs/flow"`,
    `import { Schema } from "effect"`,
    "",
    "/** What the agent does each time the flow runs. */",
    "const instructions = [",
    ...flow.instructions.split("\n").map((line) => `  ${literal(line)},`),
    `].join("\\n")`,
    "",
    "/** The flow's one step: the agent follows the instructions with the run's input. */",
    `const Agent = AgentAction.make(${literal(stepName(flow.name))}, {`,
    "  payload: { input: Schema.String },",
    "  output: Schema.String,",
    `  seat: "agent",`,
    "  prompt: ({ input }) => (input === \"\" ? instructions : `${instructions}\\n\\nInput: ${input}`),",
    "})",
    "",
    `export default Flow.make(${literal(flow.name)}, {`,
    `  description: ${literal(flow.description)},`,
    "  capabilities: [],",
    `  flows: [${flow.flows.map(literal).join(", ")}],`,
    "  payload: { input: Schema.String },",
    "  success: Schema.String,",
    "  error: Agent.errorSchema,",
    "  body: ({ input }) => Agent.call({ input }),",
    "})",
    "",
  ].join("\n")

/**
 * Modules only a machine provides: Node's and Bun's own, and the Smithers packages that reach a host or a sandbox.
 * Any other module the realm doesn't provide can't run anywhere: the realm refuses it (`forbidden_import`).
 */
const MACHINE_MODULE = /^(?:node:|bun:|bun$|@smthrs\/(?:platform-node|platform-bun|sandbox)(?:\/|$))/

/** Capabilities only a machine grants: its files, processes, network and repository, or every capability. */
const MACHINE_CAPABILITY = /^(?:\*$|fs:|proc:|net:|jj:)/

/**
 * Every module a static `import` or `export … from` statement at the start of a line names. A string or comment that
 * only looks like one never starts a line in a module `renderSource` writes, whose instructions are indented literals.
 */
const IMPORT = /^[ \t]*(?:import[ \t]*["'`]([^"'`\n]+)["'`]|(?:import|export)\b[^"'`;]*?\bfrom[ \t]*["'`]([^"'`\n]+)["'`])/gm

/** Every string a `capabilities: [ … ]` list that starts a line names, as `Flow.make`'s options are written. */
const CAPABILITIES = /^[ \t]*capabilities\s*:\s*\[([^\]]*)\]/gm
const STRING = /["'`]([^"'`]*)["'`]/g

/** The modules `source` imports statically. */
export const importsOf = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(IMPORT)].map((match) => (match[1] ?? match[2])!)

/** The capabilities `source` declares in a literal list at the start of a line. */
export const capabilitiesOf = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(CAPABILITIES)].flatMap((list) => [...list[1]!.matchAll(STRING)].map((match) => match[1]!))

/**
 * Whether `source` needs a machine: it imports a module only a machine provides, or declares a capability only a
 * machine grants. Everything else runs in the QuickJS realm, which enforces what it gives code whatever this says.
 */
export const needsMachine = (source: string): boolean =>
  importsOf(source).some((module) => MACHINE_MODULE.test(module)) ||
  capabilitiesOf(source).some((capability) => MACHINE_CAPABILITY.test(capability))

/** Where `source` runs: on the person's device, in the QuickJS realm, unless it needs a machine. */
export const placementOf = (source: string): Placement => needsMachine(source) ? "sandbox" : "client"
