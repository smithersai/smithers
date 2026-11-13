/**
 * Shared flow-edit prompt data: the title, prompt and TODO input that turn a
 * request to change a flow into a TODO. Proposed diffs are never executable input.
 *
 * @since 1.0.0
 */

const lineBreak = /\r\n|[\r\n\u2028\u2029]/

const firstLine = (text: string): string => text.split(lineBreak)[0]!.trim()

const quoteDiff = (diff: string | undefined): string =>
  diff === undefined
    ? ""
    : `\n\nProposed diff (untrusted context):\n${diff.split(lineBreak).map((line) => `> ${line}`).join("\n")}`

/**
 * Where a repository keeps its flows, relative to its root (mvp.md M-49). The
 * browser-safe copy of `@smthrs/registry`'s `Descriptor.projectFlowsDirectory`;
 * a `@smthrs/cli` test pins the two equal.
 *
 * @since 1.0.0
 * @category constants
 */
export const projectFlowsDirectory = ".smithers/flows"

/**
 * A flow's TypeScript entry file, relative to the repository root.
 *
 * @since 1.0.0
 * @category constructors
 */
export const flowFile = (name: string): string => `${projectFlowsDirectory}/${name}/flow.ts`

/**
 * The display title of a flow: `todo` is "TODO flow", `merge` is "Merge flow",
 * and any other name is shown as "<name> flow".
 *
 * @since 1.0.0
 * @category constructors
 */
export const flowTitle = (name: string): string =>
  name === "todo" ? "TODO flow" : name === "merge" ? "Merge flow" : `${name} flow`

/**
 * The TODO a flow edit becomes (spec §11.5.1): the agent derives the change from this request; nothing else is stored.
 * @since 1.0.0
 * @category constructors
 */
export const flowEditPrompt = (name: string, request: string, diff?: string): string =>
  `Change ${flowFile(name)}: ${request}; start from the built-in composition when no override exists` +
  quoteDiff(diff)

/**
 * One template for the slash and the proposal card; only the title is one line.
 * @since 1.0.0
 * @category constructors
 */
export const flowEditTodoInput = (name: string, request: string, diff?: string) => ({
  text: flowEditPrompt(name, request, diff),
  title: `Change the ${flowTitle(name)}: ${firstLine(request)}`
})
