/**
 * Built-in flow declarations and their separately supplied handlers.
 *
 * @since 1.0.0
 */

import * as ApplyPatch from "./ApplyPatch.vibe"
import * as Bash from "./Bash.vibe"
import * as Edit from "./Edit.vibe"
import * as Explore from "./Explore.vibe"
import * as Fetch from "./Fetch.vibe"
import * as Glob from "./Glob.vibe"
import * as Grep from "./Grep.vibe"
import * as HttpPost from "./HttpPost.vibe"
import * as Ls from "./Ls.vibe"
import * as Lsp from "./Lsp.vibe"
import * as Read from "./Read.vibe"
import * as ShellCommand from "./ShellCommand.vibe"
import * as TestRun from "./TestRun.vibe"
import * as UpdatePlan from "./UpdatePlan.vibe"
import * as WebFetch from "./WebFetch.vibe"
import * as WebSearch from "./WebSearch.vibe"
import * as Write from "./Write.vibe"

/**
 * Frozen name-to-declaration registry for every standard flow.
 *
 * @category registries
 * @since 1.0.0
 */
export const flows = Object.freeze({
  [Read.name]: Read.flow,
  [Write.name]: Write.flow,
  [Edit.name]: Edit.flow,
  [Ls.name]: Ls.flow,
  [Glob.name]: Glob.flow,
  [Grep.name]: Grep.flow,
  [Bash.name]: Bash.flow,
  [TestRun.name]: TestRun.flow,
  [ShellCommand.name]: ShellCommand.flow,
  [ApplyPatch.name]: ApplyPatch.flow,
  [UpdatePlan.name]: UpdatePlan.flow,
  [Fetch.name]: Fetch.flow,
  [HttpPost.name]: HttpPost.flow,
  [Explore.name]: Explore.flow,
  [WebFetch.name]: WebFetch.flow,
  [WebSearch.name]: WebSearch.flow,
  [Lsp.name]: Lsp.flow
})

/**
 * Frozen name-to-handler registry for executable standard flows.
 *
 * Explore is dynamic and therefore has no handler entry.
 *
 * @category registries
 * @since 1.0.0
 */
export const handlers = Object.freeze({
  [Read.name]: Read.run,
  [Write.name]: Write.run,
  [Edit.name]: Edit.run,
  [Ls.name]: Ls.run,
  [Glob.name]: Glob.run,
  [Grep.name]: Grep.run,
  [Bash.name]: Bash.run,
  [TestRun.name]: TestRun.run,
  [ShellCommand.name]: ShellCommand.run,
  [ApplyPatch.name]: ApplyPatch.run,
  [UpdatePlan.name]: UpdatePlan.run,
  [Fetch.name]: Fetch.run,
  [HttpPost.name]: HttpPost.run,
  [WebFetch.name]: WebFetch.run,
  [WebSearch.name]: WebSearch.run,
  [Lsp.name]: Lsp.run
})

/**
 * Frozen name-to-narrowing registry: the entry point for `effectsFor`.
 *
 * Every flow declares a registry-time worst case in `flow.effects`, and every
 * module also narrows that declaration for one decoded input. Without this map
 * a host holding a flow name and a decoded input has no generic way to reach
 * the narrowing, so it would have to serialize conflicts against the worst case
 * for every call. Explore is included even though it has no handler entry: it
 * is a declaration a seat can be offered, and its envelope narrows the same way.
 *
 * @category registries
 * @since 1.0.0
 */
export const effectsFor = Object.freeze({
  [Read.name]: Read.effectsFor,
  [Write.name]: Write.effectsFor,
  [Edit.name]: Edit.effectsFor,
  [Ls.name]: Ls.effectsFor,
  [Glob.name]: Glob.effectsFor,
  [Grep.name]: Grep.effectsFor,
  [Bash.name]: Bash.effectsFor,
  [TestRun.name]: TestRun.effectsFor,
  [ShellCommand.name]: ShellCommand.effectsFor,
  [ApplyPatch.name]: ApplyPatch.effectsFor,
  [UpdatePlan.name]: UpdatePlan.effectsFor,
  [Fetch.name]: Fetch.effectsFor,
  [HttpPost.name]: HttpPost.effectsFor,
  [Explore.name]: Explore.effectsFor,
  [WebFetch.name]: WebFetch.effectsFor,
  [WebSearch.name]: WebSearch.effectsFor,
  [Lsp.name]: Lsp.effectsFor
})

/**
 * Frozen standard flow names in registry order.
 *
 * @category metadata
 * @since 1.0.0
 */
export const names = Object.freeze(
  [
    Read.name,
    Write.name,
    Edit.name,
    Ls.name,
    Glob.name,
    Grep.name,
    Bash.name,
    TestRun.name,
    ShellCommand.name,
    ApplyPatch.name,
    UpdatePlan.name,
    Fetch.name,
    HttpPost.name,
    Explore.name,
    WebFetch.name,
    WebSearch.name,
    Lsp.name
  ] as const
)

/**
 * Frozen names visible to a seat restricted to read-only flows.
 *
 * Seat policies consume this list instead of duplicating name checks.
 *
 * `websearch` is deliberately absent: its provider contract requires
 * `net:post` authority, which is mutating under the kernel capability
 * taxonomy, so it cannot ride in a read-only seat.
 *
 * @category visibility
 * @since 1.0.0
 */
export const readOnly = Object.freeze(
  [
    Read.name,
    Ls.name,
    Glob.name,
    Grep.name,
    Fetch.name,
    Explore.name,
    WebFetch.name,
    Lsp.name
  ] as const
)
