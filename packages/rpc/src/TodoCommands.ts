/**
 * The TODO commands shared by every host that runs them (mvp.md Appendix A): `/stack`, `/todo` and `/todo.new`,
 * with their catalog copy, agent rule, input and TODO card.
 * @since 1.0.0
 */

import { z } from "zod"
import type { AgentCommand } from "./AgentCommands.ts"
import type { Card } from "./Cards.ts"
import type { TodoCard } from "./TodoCard.ts"

/**
 * `/stack`: the stack and its background runs. The agent reads it at once.
 * @since 1.0.0
 * @category constants
 */
export const STACK_COMMAND = {
  name: "stack",
  summary: "Show the stack and background runs",
  agent: "run"
} as const satisfies AgentCommand

/**
 * `/todo Tn`: one TODO. The agent reads it at once.
 * @since 1.0.0
 * @category constants
 */
export const TODO_COMMAND = {
  name: "todo",
  summary: "Open a TODO",
  args: "<Tn>",
  agent: "run"
} as const satisfies AgentCommand

/**
 * `/todo.new`: writes a TODO. The agent only drafts it: committing a TODO is the person's press (mvp.md Appendix B
 * A✓), so its rule is `confirm`.
 * @since 1.0.0
 * @category constants
 */
export const TODO_NEW_COMMAND = {
  name: "todo.new",
  summary: "Write and place a TODO",
  args: "[text]",
  agent: "confirm"
} as const satisfies AgentCommand

/**
 * Stack placement for scratch adoption: choose `after` or `before`, or let the stack choose the default.
 * TODO creation uses only `before` and otherwise appends.
 * @since 1.0.0
 * @category schemas
 */
export const TodoPlacementSchema = z.object({
  after: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).refine((input) => input.after === undefined || input.before === undefined, {
  message: "Choose after or before"
})

/**
 * `/todo.new`'s declared input. Without `cardId` it opens a Draft with the TODO's text, title, acceptance and place
 * (`before` a TODO, else appended); with a Draft's `cardId` it commits that Draft. `idempotencyKey` is the Commit's.
 * @since 1.0.0
 * @category schemas
 */
export const TodoNewInputSchema = z.object({
  text: z.string().optional(),
  title: z.string().min(1).optional(),
  acceptance: z.array(z.string()).optional(),
  before: TodoPlacementSchema.shape.before,
  cardId: z.string().optional(),
  idempotencyKey: z.string().min(1).optional()
})

/**
 * A TODO card.
 * @since 1.0.0
 * @category models
 */
export type TodoEntry = Extract<Card, { readonly kind: "todo" }>

/**
 * The TODO card for TODO `n`: its model once read, else a card titled by its number until the model arrives.
 * @since 1.0.0
 * @category constructors
 */
export const todoCard = (n: number, model: TodoCard | undefined, ordinal: number, createdAt: number): TodoEntry => ({
  id: `todo:${n}`,
  kind: "todo",
  title: model?.title ?? `T${n}`,
  status: "active",
  createdAt,
  ordinal,
  payload: { n, ...(model === undefined ? {} : { model }), requests: [] }
})
