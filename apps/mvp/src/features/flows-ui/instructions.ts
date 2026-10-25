import { AgentInstructions } from "@smthrs/rpc"
import { MAX_CALLS, MAX_QUESTIONS } from "./contract"

// What the agent is told when it drafts a person's flow (`flow/new/draft`) and when an agent step of one asks it
// (`flow/run/agent`), ahead of the cell contract (decision 0014 §2). The prompt the step's code rendered reaches the agent
// as the task, never as system teaching, so a flow can't rewrite the rules it runs under.

/** The drafting agent's system teaching. */
export const AUTHOR_SYSTEM: ReadonlyArray<string> = [
  AgentInstructions.AGENT_NAME_LINE,
  "You draft a person's own flow: instructions another agent follows each time the flow runs, and the app flows it " +
  "may call while it does.",
  "Write the instructions to that agent, in the second person. Never write steps for the person to follow.",
  `List in flows only names from the catalog you are given, at most ${MAX_CALLS}; list none when it needs none.`,
  `Ask at most ${MAX_QUESTIONS} questions, and only ones whose answer changes the flow. Give each the default you ` +
  "assumed, and mark it blocking only when no default works.",
  "You may read a repository to learn its layout. Finish with ctx.done and the object the schema asks for.",
]

/** What one catalog entry reads as in the drafting prompt. */
export interface CatalogEntry {
  readonly name: string
  readonly description: string
}

/**
 * The drafting task: the flow's name, what the person asked, the flow so far (its code, when it has one) and their
 * answers, and the catalog.
 */
export const authorPrompt = (task: {
  readonly name: string
  readonly request: string
  readonly previous: string | null
  readonly answers: ReadonlyArray<{ readonly question: string; readonly answer: string }>
  readonly catalog: ReadonlyArray<CatalogEntry>
}): string =>
  [
    `The flow's name: ${task.name}`,
    `What it should do: ${task.request}`,
    ...(task.previous === null ? [] : ["", "The flow so far:", task.previous]),
    ...(task.answers.length === 0
      ? []
      : ["", "The person answered:", ...task.answers.map(({ question, answer }) => `- ${question} ${answer}`)]),
    "",
    "The catalog it may call from:",
    ...task.catalog.map((entry) => `- ${entry.name}: ${entry.description}`),
  ].join("\n")

/** The system teaching of an agent running a person's flow. */
export const FLOW_SYSTEM: ReadonlyArray<string> = [
  AgentInstructions.AGENT_NAME_LINE,
  "You run one of the person's own flows. Follow its instructions with the input you are given.",
  "Call only the flows it lists; a call to any other is refused. Finish with ctx.done and your answer's text.",
]
