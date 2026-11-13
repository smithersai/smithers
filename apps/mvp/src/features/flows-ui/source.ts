import { parse } from "@babel/parser"
import type { Node } from "@babel/types"

// A person's flow is flow source (decision 0014 §1, as Will ruled on 2026-10-20: "prompt flows are just a type of code
// flow"): one `flow.ts` module whose default export is `Flow.make("<name>", { ... })` from @smthrs/flow, the shape a
// repository's `.smithers/flows/<name>/flow.ts` has. Drafting from a prompt writes one with `renderSource`: a typed
// module whose body is one agent step that follows the drafted instructions. A person may edit it like any code.
// Source is parsed without evaluation, on the tab, the engine and ChatApi alike.
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

/** Removes TypeScript annotations that leave an expression's runtime value unchanged. */
const expressionOf = (node: Node | null | undefined): Node | null | undefined => {
  while (
    node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSTypeAssertion" || node?.type === "TSNonNullExpression" ||
    node?.type === "ParenthesizedExpression"
  ) node = node.expression
  return node
}

/** A string's decoded value, without evaluating expressions or template substitutions. */
const stringOf = (node: Node | null | undefined): string | undefined => {
  node = expressionOf(node)
  if (node?.type === "StringLiteral") return node.value
  return node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0]!.value.cooked ?? undefined : undefined
}

/** Source syntax, without evaluation. The source checks and realm report invalid code; an editor may be incomplete. */
const requirementsOf = (source: string): { imports: Array<string>; capabilities: Array<string> } => {
  const requirements = { imports: [] as Array<string>, capabilities: [] as Array<string> }
  let file
  try {
    file = parse(source, { sourceType: "module", plugins: ["typescript"], createParenthesizedExpressions: true, errorRecovery: true })
  } catch {
    // expected: an unfinished editor buffer is valid UI state; source checks and the realm diagnose invalid runs.
    return requirements
  }
  for (const statement of file.program.body) {
    if (
      statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      if (statement.source) requirements.imports.push(statement.source.value)
    }
  }
  // Walk only parser-created child nodes, without loading Babel's Node-dependent runtime helpers.
  const isNode = (value: unknown): value is Node => value !== null && typeof value === "object" && "type" in value
  const pending: Array<Node> = [file.program]
  while (pending.length > 0) {
    const node = pending.pop()!
    const children: Array<Node> = []
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) children.push(child)
      }
    }
    // Parser nodes have source offsets; visit them in source order, including template substitution expressions.
    for (const child of children.sort((a, b) => b.start! - a.start!)) pending.push(child)
    if (node.type !== "ObjectProperty") continue
    const key = !node.computed && node.key.type === "Identifier" ? node.key.name : stringOf(node.key)
    const value = expressionOf(node.value)!
    if (key !== "capabilities" || value.type !== "ArrayExpression") continue
    for (const element of value.elements) {
      const capability = stringOf(element)
      if (capability !== undefined) requirements.capabilities.push(capability)
    }
  }
  return requirements
}

/** The modules static import and re-export declarations name, in source order. */
export const importsOf = (source: string): ReadonlyArray<string> => requirementsOf(source).imports

/** The literal strings in capability array properties, wherever the properties appear in code. */
export const capabilitiesOf = (source: string): ReadonlyArray<string> => requirementsOf(source).capabilities

/**
 * Whether source needs a machine. The realm enforces what code may do independently of this placement hint.
 */
export const needsMachine = (source: string): boolean => {
  const { imports, capabilities } = requirementsOf(source)
  return imports.some((module) => MACHINE_MODULE.test(module)) ||
    capabilities.some((capability) => MACHINE_CAPABILITY.test(capability))
}

/** Where `source` runs: on the person's device, in the QuickJS realm, unless it needs a machine. */
export const placementOf = (source: string): Placement => needsMachine(source) ? "sandbox" : "client"
