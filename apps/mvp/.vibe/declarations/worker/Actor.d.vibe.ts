import { Context, Effect, Layer, Metric, type Option, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import type { Role } from "../../../src/features/auth/contract.ts";
import type { PersonOnlyFlow } from "../../../src/flows/personOnly.ts";
import type { registry } from "../../../src/flows/registry.ts";
export { PERSON_ONLY_FLOWS, type PersonOnlyEnforcement, type PersonOnlyFlow, refusesCredential, } from "../../../src/flows/personOnly.ts";
export type { Role };
/** A role's authority, from no role (0) through Admin (4). */
export declare const rankOf: (role: Role | null) => number;
/**
 * Who acts for a person (decision 0017 slice 0): an agent's run, a flow's own run, a frame's dispatch (`app`) or a
 * container's (`sandbox`).
 */
export type ActKind = "agent" | "flow" | "app" | "sandbox";
/**
 * The run acting for a person, as its server-minted run credential says (worker/RunCredentials.ts): never from a
 * request's body, so a route reads who acts from here alone.
 */
export interface Act {
    readonly kind: ActKind;
    /** The run acting: its execution id. */
    readonly id: string;
    /** The run its credential's chain started from: the run a run-bound route, its report or its answer, must be. */
    readonly root?: string;
    /** The flows from the chain's root to this run, root first. */
    readonly chain?: ReadonlyArray<string>;
    /** Its effective capability ceiling, narrowed at every hop, in transported form: `[]` is unrestricted. */
    readonly ceiling?: ReadonlyArray<ReadonlyArray<string>>;
}
/**
 * Who is acting: a signed-in person and their role on the repository (decision 0007), `null` when they have none,
 * and, when an agent, flow, frame or sandbox acts for them, which one (RFC 8693's `act`, decision 0008 §1). Only a
 * run credential sets `act`; the person's own session never does.
 */
export interface Actor {
    readonly subject: {
        readonly kind: "person";
        readonly id: string;
    };
    readonly role: Role | null;
    /** The person's GitHub login when sign-in knows it: a snapshot for what they author, such as a terminal's owner. */
    readonly login?: string;
    readonly act?: Act;
    /**
     * The sign-in session the request came with, when sign-in resolved one: a person's own GitHub write runs with that
     * session's GitHub token (decision 0012 §5). Absent for local development's developer and in tests that need none.
     */
    readonly session?: string;
    /**
     * The alias session the request came with at an alias host (decision 0130), when it did: `session` is then its home
     * session. Ending the alias ends what it admitted (worker/SocketAccess.ts, worker/runners/Fence.ts).
     */
    readonly alias?: string;
    /**
     * When the presented session ends (`at`) and the database's `clock_timestamp()` in the lookup that read it (`now`),
     * epoch milliseconds, so a deadline never mixes the Worker's clock with Postgres' (devpriv FINAL r13). Only
     * `Sessions.resolveCookie` sets it, for a read that answers with its own deadline (the first paint, §3.10). Never
     * stored with an actor.
     */
    readonly expiry?: {
        readonly at: number;
        readonly now: number;
    };
}
/**
 * Whether `actor` may ask Smithers (`repo:ask`, decision 0007 §2): Member, Maintainer or Admin. A Guest, or a person
 * with no role, may not. An agent acting for a person asks with that person's role.
 */
/** Whether `role` is a Member's or above (decision 0007 §1). */
export declare const memberOrAbove: (role: Role | null) => boolean;
export declare const canAsk: (actor: Actor) => boolean;
/**
 * Whether `actor` may clone a repository into Code Storage: Member, Maintainer or Admin, the tier of
 * `repo:branch-create` (decision 0007 §2), because a clone spends the deployment's Code Storage budget and takes one of
 * its repositories. A Guest, or a person with no role, may not.
 */
export declare const canClone: (actor: Actor) => boolean;
declare const SessionsUnavailable_base: Schema.Class<SessionsUnavailable, Schema.TaggedStruct<"@smthrs/mvp/auth/SessionsUnavailable", {}>, import("effect/Cause").YieldableError>;
/** Sessions couldn't be read, for example because Postgres is unreachable: neither signed in nor signed out. */
export declare class SessionsUnavailable extends SessionsUnavailable_base {
}
declare const Sessions_base: Context.ServiceClass<Sessions, "@smthrs/mvp/Sessions", {
    readonly resolve: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, HttpServerRequest.HttpServerRequest>;
    /**
     * The person behind the request's session cookie alone, never a run credential its `Authorization` carries, bound
     * by `x-smithers-device-person` as `resolve` binds it (`RunCredentials.resolveCookieWith`). For a read that must
     * answer for the browser's own session, such as the issue page's first paint. Absent: such a read is unavailable.
     */
    readonly resolveCookie?: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, HttpServerRequest.HttpServerRequest>;
}>;
/** Resolves the actor behind a request: `None` for a signed-out request. */
export declare class Sessions extends Sessions_base {
}
/** Every request signed out: what a deployment without sign-in configured resolves, and the tests' default. */
export declare const signedOut: Layer.Layer<Sessions>;
declare const CurrentActor_base: Context.ServiceClass<CurrentActor, "@smthrs/mvp/CurrentActor", Actor>;
/** The actor a flow step runs as. The host that starts the run provides it; a payload never names it. */
export declare class CurrentActor extends CurrentActor_base {
}
/** Whether a run-bound route may act on run `runId` for `actor`: the person may; a credential only on its own chain. */
export declare const boundTo: (actor: Actor, runId: string) => boolean;
type Registry = typeof registry;
type FlowName = keyof Registry & string;
/** The registry's agents: each entry marked `acts: "agent"`. Inside one, every run acts as the agent. */
export type AgentFlow = {
    [N in FlowName]: Registry[N] extends {
        readonly acts: "agent";
    } ? N : never;
}[FlowName];
/**
 * The server's own protected acts, which no flow of the registry names: each route refuses anyone acting for the
 * person. Merging, approving, pre-approving, members, roles and plugin grants join this list with their routes.
 */
export declare const PROTECTED_ACTS: {
    readonly secret: {
        readonly route: "PUT, DELETE /api/repos/<owner>/<name>/secrets/<name>";
    };
    readonly "pr/merge": {
        readonly route: "POST /api/repos/<owner>/<name>/writes";
    };
    readonly model: {
        readonly route: "PUT /api/me/model";
    };
    readonly "stack/configure": {
        readonly route: "POST /api/repos/<owner>/<name>/stack (configure)";
    };
    readonly runner: {
        readonly route: "PUT, DELETE /api/repos/<owner>/<name>/runners/<name>";
    };
    readonly agent: {
        readonly route: "PUT, DELETE /api/repos/<owner>/<name>/agents/<name>";
    };
};
/** A person-only act: a registry flow with a `userOnlyReason`, or a protected act. */
export type PersonOnlyAct = PersonOnlyFlow | keyof typeof PROTECTED_ACTS;
/**
 * The registry's agents, which the server reads when it mints a credential's `act`: each entry marked
 * `acts: "agent"`, and the compiler refuses one missing or one too many.
 */
export declare const AGENT_FLOWS: ReadonlySet<string>;
/** Person-only acts refused, by `act` and who tried (`by`: the act's kind). */
export declare const personOnlyRefusals: Metric.Counter<number>;
/**
 * Whether person-only `act` must refuse `actor`: anyone acts for the person. A refusal is a log line
 * `auth.person_only` and a count, by the act and who tried; neither carries content.
 */
export declare const refusesPersonOnly: (actor: Actor, act: PersonOnlyAct) => Effect.Effect<boolean>;
