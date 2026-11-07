import type { Option } from "effect";
import type { StackVia } from "../../../../src/features/todos/contract.ts";
import { type Actor } from "../Actor.vibe";
/** Whether `actor` may read a repository's TODOs and their prompts: a Member or above, like a branch's live workspace. */
export declare const mayRead: (actor: Option.Option<Actor>) => boolean;
/**
 * Whether `actor` may commit a TODO to a stack or drop one: a Member or above, in person. The agent drafts; a person
 * commits and drops (decision 0016 §3). Who acts comes from the session, never from the request: an actor an agent,
 * flow or sandbox acts for (`act`, decision 0008 §1) is refused.
 */
export declare const mayChange: (actor: Actor) => boolean;
/** Who a change acts for, as the session says: the person, unless an agent, flow or sandbox acts for them. */
export declare const viaOf: (actor: Actor) => StackVia;
/** Least role for retry: Member for their own TODO; Maintainer for anyone's. Ownership stays under the writer lock. */
export declare const mayRetryAny: (actor: Actor) => boolean;
/**
 * Whether `actor` may change a stack's settings, its lanes, open limit and base (decision 0135): an Admin of the
 * repository, in person. Lanes are spend: each one is an agent run on a runner.
 */
export declare const mayConfigure: (actor: Actor) => boolean;
