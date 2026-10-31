import type { Option } from "effect"
import type { StackVia } from "../../src/features/todos/contract.ts"
import { type Actor, canAsk } from "../Actor.ts"

// Who may read and change a repository's stack (decision 0016 §1 and its Consequences: 0007's catalog gains
// `repo:todo-commit` and `repo:todo-drop`, Member; agent never). Every route of the stack asks these functions, so a
// change of policy is a change here.

/** Whether `actor` may read a repository's TODOs and their prompts: a Member or above, like a branch's live workspace. */
export const mayRead = (actor: Option.Option<Actor>): boolean => actor._tag === "Some" && canAsk(actor.value)

/**
 * Whether `actor` may commit a TODO to a stack or drop one: a Member or above, in person. The agent drafts; a person
 * commits and drops (decision 0016 §3). Who acts comes from the session, never from the request: an actor an agent,
 * flow or sandbox acts for (`act`, decision 0008 §1) is refused.
 */
export const mayChange = (actor: Actor): boolean => canAsk(actor) && actor.act === undefined

/** Who a change acts for, as the session says: the person, unless an agent, flow or sandbox acts for them. */
export const viaOf = (actor: Actor): StackVia => (actor.act === undefined ? "person" : "agent")

/** Least role for retry: Member for their own TODO; Maintainer for anyone's. Ownership stays under the writer lock. */
export const mayRetryAny = (actor: Actor): boolean => actor.role === "maintainer" || actor.role === "admin"

/**
 * Whether `actor` may change a stack's settings, its lanes, open limit and base (decision 0132): an Admin of the
 * repository, in person. Lanes are spend: each one is an agent run on a runner.
 */
export const mayConfigure = (actor: Actor): boolean => actor.role === "admin" && actor.act === undefined
