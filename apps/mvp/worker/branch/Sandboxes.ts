import { Fault } from "@smthrs/flow"
import { Context, type Effect, Schema } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Role } from "../Actor.ts"
import type { Policy } from "./Access.ts"

// A branch's machine as the flows and routes reach it (decision 0013 §2-§3, decision 0005 §2): one sandbox per branch,
// which the host provides. On Cloudflare it is the branch's `SandboxObject` Durable Object and its container
// (worker/BranchSandboxes.ts); a test provides its own. Nothing here names a host.

/**
 * The branch a sandbox serves: its id, its repository on GitHub, the branch name or commit its checkout follows, and
 * where it lives when it isn't the deployment's forge: `github` for a TODO's attempt, whose machine checks out its base
 * commit from GitHub (worker/flows/TodoMachine.ts, worker/branch/Forge.ts `forgeOf`). `kind: "job"` is a throwaway machine a head's
 * checks run on, whose box never holds a secret. Every box reaches the package registries (worker/branch/RegistryEgress.ts).
 */
export const SandboxBranch = Schema.Struct({
  branchId: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  branch: Schema.String,
  forge: Schema.optional(Schema.Literal("github")),
  namespace: Schema.optional(Schema.Literals(["default", "ephemeral"])),
  kind: Schema.optional(Schema.Literal("job")),
})
export type SandboxBranch = typeof SandboxBranch.Type

/**
 * The machine couldn't start or answer: the platform failed (`start`, `exec`), or the sandbox limits leave no machine
 * free (`waiting`, worker/branch/Budget.ts). A step tries again.
 */
export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  "@smthrs/mvp/branch/SandboxUnavailable",
  { reason: Schema.Literals(["start", "exec", "waiting"]) },
) {}

/**
 * The branch's machine didn't finish starting within SANDBOX_START_TIMEOUT_SECONDS. A call settles `start_timeout`
 * rather than waiting on a start that may never end; not retried, since the start was just given its whole time.
 */
export class SandboxStartTimedOut extends Schema.TaggedError<SandboxStartTimedOut>()(
  "@smthrs/mvp/branch/SandboxStartTimedOut",
  {},
) {}

/** The branch couldn't be checked out in the machine: its forge refused the clone. Not retried. */
export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("@smthrs/mvp/branch/CheckoutFailed", {}) {}

// What each failure is to the flow engine: a machine that couldn't answer is retried, as infrastructure; a start that ran
// out of time or a refused checkout isn't, as the steps above say (`Fault`, the engine's default retry of a keyed step).
Fault.register("@smthrs/mvp/branch/SandboxUnavailable", "infra")
Fault.register("@smthrs/mvp/branch/SandboxStartTimedOut", "dependency")
Fault.register("@smthrs/mvp/branch/CheckoutFailed", "dependency")

/**
 * Who a socket attaches as: anyone who may edit the branch types (`write`), the terminal's owner and the people it is
 * shared with to edit alike; anyone who may only view it watches (`read`). Every shell runs as its owner's own user in
 * the machine, so `ownerId` says whose tmux server the terminal is on. `principal` and `role` are the viewer's, so a
 * change of the branch's sharing can be applied to the socket while it is open (`enforce`).
 */
export interface Attachment {
  readonly terminalId: string
  readonly ownerId: string
  readonly access: "write" | "read"
  readonly principal: string
  readonly role: Role | null
}

/** A terminal whose owner lost the branch: it ends, and its shell with it. */
export interface Revoked {
  readonly terminalId: string
  readonly ownerId: string
}

/** The sandboxes of every branch, by branch id. */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Wakes the branch's machine: starts it unless it runs, routes its forge requests to the read-only proxy, and
     * checks the branch out in /workspace unless it is there. Answers the machine's generation, which a restart
     * advances. Doing it again on a running machine changes nothing. A stopped machine starts only once the sandbox
     * limits admit it for `ownerId` (worker/branch/Budget.ts); else it fails `SandboxUnavailable` `waiting`.
     */
    readonly wake: (
      branch: SandboxBranch,
      ownerId?: string,
    ) => Effect.Effect<{ readonly generation: number }, SandboxUnavailable | CheckoutFailed>
    /**
     * Starts terminal `terminalId`'s shell session in the branch's machine unless it is there, as its owner's own user,
     * made on first use, so one person's shell can't reach another's.
     */
    readonly session: (branchId: string, terminalId: string, ownerId: string) => Effect.Effect<void, SandboxUnavailable>
  }
>()("@smthrs/mvp/branch/Sandboxes") {}

/** A browser's terminal socket as the routes reach a branch's machine. */
export class TerminalSockets extends Context.Service<
  TerminalSockets,
  {
    /** Attaches the request's socket to the terminal's session: the host's answer to the upgrade. */
    readonly attach: (
      branchId: string,
      attachment: Attachment,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
    /**
     * Whether the terminal's session is alive in the branch's machine: the machine runs and the session is there. A
     * machine that slept or was lost has no sessions. Never wakes a machine.
     */
    readonly alive: (branchId: string, terminalId: string, ownerId: string) => Effect.Effect<boolean>
    /**
     * Applies the branch's permission list to every socket attached on its machine: a viewer who may no longer view
     * the branch is detached for good (close 1008), one whose access changed reconnects to get the new one, and each
     * `revoked` terminal's shell ends. Never wakes a machine; doing it again changes nothing.
     */
    readonly enforce: (
      branchId: string,
      policy: Policy,
      revoked: ReadonlyArray<Revoked>,
    ) => Effect.Effect<void, SandboxUnavailable>
  }
>()("@smthrs/mvp/branch/TerminalSockets") {}
