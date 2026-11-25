/**
 * Who an invocation acts for. Decision 0017 §9: an agent never acts as the person.
 *
 * `smthrs --mcp` and `smthrs --http` mark their process a delegate in the environment their children inherit. Every
 * entry point reads that one mark, and the person-only mutations themselves refuse a delegate, so no entry point can
 * reach one by skipping a middleware.
 *
 * @since 1.0.0
 */

import { Context } from "effect"
import { Refused } from "./CliError.ts"

/**
 * The environment variable that marks an invocation as made for an agent, never a person. No value turns a delegate
 * back into a person.
 *
 * @category constants
 * @since 1.0.0
 */
export const DELEGATE_ACT = "SMITHERS_DELEGATE_ACT"

/**
 * Who an invocation acts for.
 *
 * @category models
 * @since 1.0.0
 */
export type Principal = "person" | "agent"

/**
 * Whether an environment marks its process a delegate.
 *
 * @category getters
 * @since 1.0.0
 */
export const delegated = (environment: Readonly<Record<string, string | undefined>>): boolean =>
  environment[DELEGATE_ACT] === "agent"

/**
 * The principal of an invocation that runs with `environment` inside this process. The process's own mark always
 * counts, so a host-supplied environment cannot turn a delegate process back into a person.
 *
 * @category getters
 * @since 1.0.0
 */
export const principalOf = (environment: Readonly<Record<string, string | undefined>>): Principal =>
  delegated(environment) || delegated(process.env) ? "agent" : "person"

/**
 * The principal the current effect acts for. Unprovided, it is read from the process environment, which is what a
 * `smthrs` spawned by a served tool inherits.
 *
 * @category services
 * @since 1.0.0
 */
export const Principal: Context.Reference<Principal> = Context.Reference<Principal>("/cli/Delegate/Principal", {
  defaultValue: () => principalOf(process.env)
})

/**
 * The typed refusal of a person-only command to a delegate.
 *
 * @category constructors
 * @since 1.0.0
 */
export const personOnly = (command: string): Refused =>
  new Refused({
    fault: "policy",
    code: "person_only",
    message: `smthrs ${command} needs a person. An agent can propose it; a person runs it from their own terminal.`
  })
