import { names } from "../../flows/registry.vibe"

// Portable output-quality check for recorded and attached agent output.

/** The cell contract's names and the codes a failed call reads, which mean nothing to a person. */
const MACHINERY = [
  "ctx.call",
  "ctx.done",
  "ctx.flows",
  "ctx.park",
  "flow_failed",
  "invalid_input",
  "unknown_flow",
  "run_completed",
  "rate_limited",
  "model_error",
  "quota_exceeded",
  "viewId",
  "draftId",
  "flowId",
  "runId",
  "answerId",
  "executionId",
  "invocationId",
]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/**
 * A registered flow's name, or a machinery name, standing alone: not inside a path, a URL or a longer word, so
 * `octocat/Spoon-Knife` and `https://example.com/app/navigate` pass.
 */
const NAMED = new RegExp(
  `(?<![\\w./:-])(?:${[...names, ...MACHINERY].map(escape).join("|")})(?![\\w/-])`,
  "g",
)

/** A failure's kind as the agent's calls read it (`WebPageRefused`, `FlowNotFound`): a typed failure's tag. */
const FAILURE_TAG = /\b(?:[A-Z][a-z]+)+(?:Refused|Forbidden|Unavailable|NotFound|Denied|Taken|NotReady|OutOfTime|Approved)\b/g

/** An execution's, a view's or a draft's id. */
const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/**
 * A fenced code block, closed as Markdown closes it, by a fence of the same character at least as long, either one
 * indented up to three spaces: what a person
 * asked to see, such as their own flow's code, which may name the flows it calls. An unclosed fence hides nothing.
 */
const FENCED = /^ {0,3}(?:(`{3,})(?!`)[^`\n]*\n[\s\S]*?^ {0,3}\1`*|(~{3,})(?!~)[^\n]*\n[\s\S]*?^ {0,3}\2~*)[ \t]*$/gm

/** The internal names `text` shows a person, each once, in the order they first appear, past its fenced code. */
export const internalNames = (text: string): ReadonlyArray<string> => {
  const prose = text.replace(FENCED, (block) => " ".repeat(block.length))
  const found = [...prose.matchAll(NAMED), ...prose.matchAll(FAILURE_TAG), ...prose.matchAll(ID)]
    .sort((a, b) => a.index - b.index)
    .map((match) => match[0])
  return [...new Set(found)]
}

