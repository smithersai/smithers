import { Context, type Effect, Schema } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Admission } from "../../../../worker/SocketAccess.ts";
import type { Role } from "../Actor.vibe";
import type { Policy } from "../../../../worker/branch/Access.ts";
/**
 * The branch a sandbox serves: its id, its repository on GitHub, the branch name or commit its checkout follows, and
 * where it lives when it isn't the deployment's forge: `github` for a TODO's attempt, whose machine checks out its base
 * commit from GitHub (worker/flows/TodoMachine.ts, worker/branch/Forge.ts `forgeOf`). `kind: "job"` is a throwaway machine a head's
 * checks run on, whose box never holds a secret. Every box reaches the package registries (worker/branch/RegistryEgress.ts).
 * `machine` names a job machine the deployment declared (worker/branch/JobMachines.ts), else the default one. `artifacts`
 * is the run's artifacts scope a job box reads and writes (worker/branch/Artifacts.ts); a box without one has none.
 */
export declare const SandboxBranch: Schema.Struct<{
    readonly branchId: Schema.String;
    readonly owner: Schema.String;
    readonly name: Schema.String;
    readonly branch: Schema.String;
    readonly forge: Schema.optional<Schema.Literal<"github">>;
    readonly namespace: Schema.optional<Schema.Literals<readonly ["default", "ephemeral"]>>;
    readonly kind: Schema.optional<Schema.Literal<"job">>;
    /** A job machine's kind, by the name the deployment declared it under; the default job machine when absent. */
    readonly machine: Schema.optional<Schema.String>;
    readonly artifacts: Schema.optional<Schema.String>;
}>;
export type SandboxBranch = typeof SandboxBranch.Type;
declare const SandboxUnavailable_base: Schema.Class<SandboxUnavailable, Schema.TaggedStruct<"@smthrs/mvp/branch/SandboxUnavailable", {
    readonly reason: Schema.Literals<readonly ["start", "exec", "waiting", "undeclared"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * The machine couldn't start or answer: the platform failed (`start`, `exec`), the sandbox limits leave no machine
 * free (`waiting`, worker/branch/Budget.ts), or the branch names a machine this deployment didn't declare
 * (`undeclared`, worker/branch/JobMachines.ts), which nothing wakes. A step tries again.
 */
export declare class SandboxUnavailable extends SandboxUnavailable_base {
}
declare const SandboxStartTimedOut_base: Schema.Class<SandboxStartTimedOut, Schema.TaggedStruct<"@smthrs/mvp/branch/SandboxStartTimedOut", {}>, import("effect/Cause").YieldableError>;
/**
 * The branch's machine didn't finish starting within SANDBOX_START_TIMEOUT_SECONDS. A call settles `start_timeout`
 * rather than waiting on a start that may never end; not retried, since the start was just given its whole time.
 */
export declare class SandboxStartTimedOut extends SandboxStartTimedOut_base {
}
declare const CheckoutFailed_base: Schema.Class<CheckoutFailed, Schema.TaggedStruct<"@smthrs/mvp/branch/CheckoutFailed", {}>, import("effect/Cause").YieldableError>;
/** The branch couldn't be checked out in the machine: its forge refused the clone. Not retried. */
export declare class CheckoutFailed extends CheckoutFailed_base {
}
/**
 * Who a socket attaches as: anyone who may edit the branch types (`write`), the terminal's owner and the people it is
 * shared with to edit alike; anyone who may only view it watches (`read`). Every shell runs as its owner's own user in
 * the machine, so `ownerId` says whose tmux server the terminal is on. `principal` and `role` are the viewer's, so a
 * change of the branch's sharing can be applied to the socket while it is open (`enforce`).
 */
export interface Attachment {
    readonly terminalId: string;
    readonly ownerId: string;
    readonly access: "write" | "read";
    readonly principal: string;
    readonly role: Role | null;
    /** Who ChatApi admitted, which the machine rechecks while the socket stays open (worker/SocketAccess.ts). */
    readonly admission: Admission;
}
/** A terminal whose owner lost the branch: it ends, and its shell with it. */
export interface Revoked {
    readonly terminalId: string;
    readonly ownerId: string;
}
declare const Sandboxes_base: Context.ServiceClass<Sandboxes, "@smthrs/mvp/branch/Sandboxes", {
    /**
     * Wakes the branch's machine: starts it unless it runs, routes its forge requests to the read-only proxy, and
     * checks the branch out in /workspace unless it is there. Answers the machine's generation, which a restart
     * advances. Doing it again on a running machine changes nothing. A stopped machine starts only once the sandbox
     * limits admit it for `ownerId` (worker/branch/Budget.ts); else it fails `SandboxUnavailable` `waiting`.
     */
    readonly wake: (branch: SandboxBranch, ownerId?: string) => Effect.Effect<{
        readonly generation: number;
    }, SandboxUnavailable | CheckoutFailed>;
    /**
     * Starts terminal `terminalId`'s shell session in the branch's machine unless it is there, as its owner's own user,
     * made on first use, so one person's shell can't reach another's.
     */
    readonly session: (branchId: string, terminalId: string, ownerId: string) => Effect.Effect<void, SandboxUnavailable>;
}>;
/** The sandboxes of every branch, by branch id. */
export declare class Sandboxes extends Sandboxes_base {
}
declare const TerminalSockets_base: Context.ServiceClass<TerminalSockets, "@smthrs/mvp/branch/TerminalSockets", {
    /** Attaches the request's socket to the terminal's session: the host's answer to the upgrade. */
    readonly attach: (branchId: string, attachment: Attachment) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>;
    /**
     * Whether the terminal's session is alive in the branch's machine: the machine runs and the session is there. A
     * machine that slept or was lost has no sessions. Never wakes a machine.
     */
    readonly alive: (branchId: string, terminalId: string, ownerId: string) => Effect.Effect<boolean>;
    /**
     * Applies the branch's permission list to every socket attached on its machine: a viewer who may no longer view
     * the branch is detached for good (close 1008), one whose access changed reconnects to get the new one, and each
     * `revoked` terminal's shell ends. Never wakes a machine; doing it again changes nothing.
     */
    readonly enforce: (branchId: string, policy: Policy, revoked: ReadonlyArray<Revoked>) => Effect.Effect<void, SandboxUnavailable>;
}>;
/** A browser's terminal socket as the routes reach a branch's machine. */
export declare class TerminalSockets extends TerminalSockets_base {
}
export {};
