import { type SandboxCommand, SandboxTools } from "@smthrs/sandbox";
import { Context, Effect, Schema } from "effect";
import { CheckoutFailed, type SandboxBranch, SandboxStartTimedOut, SandboxUnavailable } from "./Sandboxes.vibe";
/** How a tool call ended on the machine, as it crosses a Durable Object's RPC: plain data, no class. */
export declare const ToolOutcome: Schema.Union<readonly [Schema.Struct<{
    readonly _tag: Schema.Literal<"Done">;
    readonly result: Schema.Union<readonly [Schema.Struct<{
        readonly tool: Schema.Literal<"run">;
        readonly exitCode: Schema.Int;
        readonly timedOut: Schema.Boolean;
        readonly stdout: Schema.String;
        readonly stderr: Schema.String;
        readonly stdoutBytes: Schema.Int;
        readonly stderrBytes: Schema.Int;
        readonly truncated: Schema.Boolean;
    }>, Schema.Struct<{
        readonly tool: Schema.Literal<"read">;
        readonly path: Schema.String;
        readonly content: Schema.String;
        readonly bytes: Schema.Int;
        readonly truncated: Schema.Boolean;
    }>, Schema.Struct<{
        readonly tool: Schema.Literal<"write">;
        readonly path: Schema.String;
        readonly bytes: Schema.Int;
    }>, Schema.Struct<{
        readonly tool: Schema.Literal<"list">;
        readonly path: Schema.String;
        readonly entries: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly kind: Schema.Literals<readonly ["file", "directory", "symlink", "other"]>;
            readonly bytes: Schema.Int;
        }>>;
        readonly truncated: Schema.Boolean;
    }>, Schema.Struct<{
        readonly tool: Schema.Literal<"status">;
        readonly branch: Schema.NullOr<Schema.String>;
        readonly entries: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly index: Schema.String;
            readonly worktree: Schema.String;
            readonly from: Schema.optional<Schema.String>;
        }>>;
    }>, Schema.Struct<{
        readonly tool: Schema.Literal<"diff">;
        readonly diff: Schema.String;
        readonly bytes: Schema.Int;
        readonly truncated: Schema.Boolean;
    }>]>;
    readonly generation: Schema.Number;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Refused">;
    readonly reason: Schema.Literals<readonly ["path", "not_found", "not_a_file", "not_a_directory", "not_a_repository", "too_large"]>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Lost">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"CheckoutFailed">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Unavailable">;
    readonly reason: Schema.optional<Schema.Literal<"start_timeout">>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Waiting">;
}>]>;
export type ToolOutcome = typeof ToolOutcome.Type;
/**
 * One operation on a command started detached in a branch's machine (`SandboxTools.start`, `observe`, `collect`,
 * `cancel`), by its key, as it crosses a Durable Object's RPC. A start names the tool call it is for (`callId`) when it
 * has one, so the machine can tell a command that call already ran as a tool call.
 */
export declare const CommandRequest: Schema.Union<readonly [Schema.Struct<{
    readonly op: Schema.Literal<"start">;
    readonly key: Schema.String;
    readonly call: Schema.Struct<{
        readonly tool: Schema.Literal<"run">;
        readonly command: Schema.String;
        readonly cwd: Schema.optional<Schema.String>;
        readonly timeoutSeconds: Schema.optional<Schema.Int>;
    }>;
    readonly callId: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly op: Schema.Literal<"observe">;
    readonly key: Schema.String;
    readonly waitMs: Schema.optional<Schema.Number>;
}>, Schema.Struct<{
    readonly op: Schema.Literal<"collect">;
    readonly key: Schema.String;
}>, Schema.Struct<{
    readonly op: Schema.Literal<"cancel">;
    readonly key: Schema.String;
}>]>;
export type CommandRequest = typeof CommandRequest.Type;
/**
 * How a command operation ended on the machine, as plain data: the command `Started` on a generation of the machine,
 * what it is doing (`Observed`), its result (`Collected`), `Cancelled`, or why it couldn't (as `ToolOutcome` says).
 */
export declare const CommandOutcome: Schema.Union<readonly [Schema.Struct<{
    readonly _tag: Schema.Literal<"Started">;
    readonly started: Schema.Struct<{
        readonly pid: Schema.Int;
        readonly startedAt: Schema.Int;
    }>;
    readonly generation: Schema.Number;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Observed">;
    readonly observed: Schema.Union<readonly [Schema.Struct<{
        readonly state: Schema.Literal<"running">;
        readonly pid: Schema.Int;
    }>, Schema.Struct<{
        readonly state: Schema.Literal<"finished">;
        readonly exitCode: Schema.Int;
        readonly timedOut: Schema.Boolean;
    }>, Schema.Struct<{
        readonly state: Schema.Literal<"lost">;
    }>]>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Collected">;
    readonly result: Schema.Struct<{
        readonly tool: Schema.Literal<"run">;
        readonly exitCode: Schema.Int;
        readonly timedOut: Schema.Boolean;
        readonly stdout: Schema.String;
        readonly stderr: Schema.String;
        readonly stdoutBytes: Schema.Int;
        readonly stderrBytes: Schema.Int;
        readonly truncated: Schema.Boolean;
    }>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Cancelled">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Refused">;
    readonly reason: Schema.Literals<readonly ["path", "not_found", "not_a_file", "not_a_directory", "not_a_repository", "too_large"]>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Lost">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"CheckoutFailed">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Unavailable">;
    readonly reason: Schema.optional<Schema.Literal<"start_timeout">>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Waiting">;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"ToolUnavailable">;
    readonly code: Schema.Literals<readonly ["aborted", "timeout", "unavailable", "not_found", "spawn_error", "unknown"]>;
    readonly exitCode: Schema.optional<Schema.Number>;
}>]>;
export type CommandOutcome = typeof CommandOutcome.Type;
/** How reaching a branch's machine for a command can fail, beside the tools' own failures. */
export declare const MachineFailure: Schema.Union<readonly [typeof SandboxUnavailable, typeof SandboxStartTimedOut, typeof CheckoutFailed]>;
export type MachineFailure = typeof MachineFailure.Type;
/** What a machine answers to `sleepIfIdle`: it `slept`, it is `busy`, or that generation is `gone` already. */
export declare const SLEEP_OUTCOMES: readonly ["slept", "busy", "gone"];
export type SleepOutcome = (typeof SLEEP_OUTCOMES)[number];
/** A tool call's success on the machine: the tool's result, and the machine generation it ran on. */
export interface Ran {
    readonly result: SandboxTools.Result;
    readonly generation: number;
}
declare const Machines_base: Context.ServiceClass<Machines, "@smthrs/mvp/branch/Machines", {
    /**
     * Runs `call` in the branch's machine as person `ownerId`'s own user, waking the machine first. A command runs at
     * most once per `callId`. A call that changes the working copy saves it (`SandboxTools.checkpoint`), so a machine
     * that stops loses none of it.
     */
    readonly tool: (branch: SandboxBranch, ownerId: string, callId: string, call: SandboxTools.Call) => Effect.Effect<Ran, SandboxTools.ToolRefused | SandboxTools.ToolLost | SandboxUnavailable | SandboxStartTimedOut | CheckoutFailed>;
    /**
     * The commands person `ownerId` starts detached in the branch's machine, as their own user
     * (`SandboxCommand.Commands`): what a `sandbox/Command` job runs a command with (worker/flows/SandboxCommand.ts).
     * Only `start` wakes the machine; the rest answer for the generation the command started on, so a command whose
     * machine stopped since observes `lost`. A command starts at most once per key, and never once tool call `callId`
     * ran it as a tool call.
     */
    readonly commands: (branch: SandboxBranch, ownerId: string, callId?: string) => SandboxCommand.Commands<MachineFailure>;
    /**
     * Puts generation `generation` of the branch's machine to sleep when nothing happened in it for `idleMs`: no call,
     * no terminal input, and no process but the shells. It saves the working copy first, and stays awake when it can't.
     * Never wakes a machine. `machine` is the branch's `SandboxBranch.machine`: the default machine when absent.
     */
    readonly sleepIfIdle: (branchId: string, generation: number, idleMs: number, machine?: string) => Effect.Effect<SleepOutcome, SandboxUnavailable>;
}>;
/** The branches' machines as the sandbox flows reach them, by branch id. */
export declare class Machines extends Machines_base {
}
/** A tool call's outcome on the machine as the tool's success, or its typed failure (`Machines.tool`). */
export declare const ranOf: (outcome: ToolOutcome) => Effect.Effect<Ran, SandboxTools.ToolRefused | SandboxTools.ToolLost | SandboxUnavailable | SandboxStartTimedOut | CheckoutFailed>;
/**
 * The commands (`SandboxCommand.Commands`) over `ask`, which runs one operation on a branch's machine and answers its
 * plain outcome (on Cloudflare, the branch's `SandboxObject`). `woken` hears the generation each start ran on, for that
 * generation's `sandbox/Keep`. `callId` is the tool call the commands are for, which each start names.
 */
export declare const commandsOver: <R>(ask: (request: CommandRequest) => Effect.Effect<CommandOutcome, never, R>, woken: (generation: number) => Effect.Effect<void, never, R>, callId?: string) => SandboxCommand.Commands<MachineFailure, R>;
/**
 * One branch's object as `routed` reaches it (on Cloudflare a `SandboxObject` or a job machine's own class,
 * worker/BranchSandboxes.ts): its answers as plain data, an object it couldn't reach already answered `Unavailable`.
 */
export interface MachineObject {
    readonly tool: (branch: SandboxBranch, ownerId: string, callId: string, call: SandboxTools.Call) => Effect.Effect<ToolOutcome>;
    readonly command: (branch: SandboxBranch, ownerId: string, request: CommandRequest) => Effect.Effect<CommandOutcome>;
    readonly sleepIfIdle: (generation: number, idleMs: number) => Effect.Effect<SleepOutcome | "unavailable">;
}
/**
 * Starts generation `generation`'s `sandbox/Keep` for the branch's machine (`machine` its `SandboxBranch.machine`), so
 * the keep asks the same machine; the same generation again is a no-op.
 */
export type Keep = (branchId: string, generation: number, machine?: string) => Effect.Effect<void>;
/**
 * `Machines` over the deployment's machines (docs/features/ci.md#machines): each call goes to the object of the
 * branch's machine, `objectOf(branchId, branch.machine)`, which answers none for a machine the deployment didn't
 * declare; such a call fails `SandboxUnavailable` `undeclared` and wakes nothing. A tool call that ran, and a
 * command's start, start their generation's `sandbox/Keep` through `keep`, with the machine.
 */
export declare const routed: (objectOf: (branchId: string, machine: string | undefined) => MachineObject | undefined, keep: Keep) => Machines["Service"];
export {};
