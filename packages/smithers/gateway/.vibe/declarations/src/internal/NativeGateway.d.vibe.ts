/**
 * Shared native gateway bind policy, credential policy,
 * and the one composition a `smithers serve` verb hosts.
 *
 * Two rules decide whether a bind is allowed, and both fail closed:
 *
 * 1. A non-loopback host requires an explicit `listen` opt-in. Binding
 *    `0.0.0.0` because a port was free is how a workspace gateway ends up on
 *    a shared network by accident.
 * 2. A non-loopback bind requires a bearer credential. The control plane can
 *    launch runs, cancel them, and approve capability grants; reachable from
 *    another machine, an unauthenticated one is a remote execution service.
 *
 * A loopback bind with no network credential allows anonymous reads; approval
 * decisions require the session operator token. Ingress still checks Host and
 * Origin so a web page cannot exercise the loopback endpoint.
 *
 * @since 1.0.0
 */
import { ControlRpcs } from "@smthrs/control";
import { Effect, Layer } from "effect";
import type { HttpServer } from "effect/http/HttpServer";
import type { ServeError } from "effect/http/HttpServerError";
import type { ListenOptions } from "node:net";
import { GatewayError } from "../GatewayError.vibe";
import * as GatewayServer from "../../../../src/GatewayServer.ts";
import type * as RuntimeBridge from "../RuntimeBridge.vibe";
/**
 * Where the gateway binds, and whether a non-loopback bind was asked for.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServerOptions extends ListenOptions {
    /** External scheme for browser Origin checks. Set `https:` behind a trusted TLS terminator. */
    readonly requestScheme?: "http:" | "https:" | undefined;
    /** Additional accepted Host header names (without ports), for network or proxy access. */
    readonly allowedHosts?: ReadonlyArray<string> | undefined;
    /** The `--listen` opt-in required for a non-loopback host. */
    readonly listen?: boolean | undefined;
    /** The shared bearer credential, required for a non-loopback bind. */
    readonly credential?: string | undefined;
    /** Per-session approval token on credential-free loopback. Read calls remain anonymous. */
    readonly operatorToken?: string | undefined;
    /**
     * How often an idle followed `Watch` on `/rpc/ws` and an idle followed
     * `Projection.Subscribe` on `/projections/ws` emit a keepalive frame. Unset,
     * both run at `Projections.heartbeatIntervalMillis` unless the supplied
     * `Projections` service was built with its own cadence. A relay with an idle
     * cut shorter than that one needs a shorter cadence here.
     */
    readonly heartbeatMillis?: number | undefined;
    /** Maximum bytes accepted on one HTTP RPC request. Default one MiB. */
    readonly maxRequestBodyBytes?: number | undefined;
    /** Immutable identity of an opt-in packaged Flow runtime bridge. */
    readonly runtimeBridge?: Omit<RuntimeBridge.Config, "authenticate"> | undefined;
}
/**
 * The default bind: loopback, port 7331, no credential.
 *
 * @since 1.0.0
 * @category models
 */
export declare const defaultServerOptions: ServerOptions;
/**
 * Whether a host names this machine only.
 *
 * @param host the host to classify
 * @since 1.0.0
 * @category predicates
 */
export declare const isLoopbackHost: (host: string) => boolean;
/**
 * The typed refusal a requested bind earns, or `undefined` when it is allowed.
 *
 * Every start-time rule this module enforces answers here as a `bind_failed`
 * `GatewayError`, so a host that wants to report a refusal rather than crash on
 * one asks this before it composes a layer. {@link listenOptions} and
 * {@link layer} fail with exactly what this returns.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export declare const bindRefusal: (options: ServerOptions) => GatewayError | undefined;
/**
 * Applies the bind policy, returning the admitted Node options or a typed
 * `bind_failed` refusal.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export declare const listenOptions: (options: ServerOptions) => Effect.Effect<ListenOptions, GatewayError>;
/**
 * The authentication both RPC mounts run under.
 *
 * A configured credential authenticates every request that presents it and
 * stamps the same server-owned principal. A scoped token minted under that
 * credential (`@smthrs/control` `ScopedToken`) authenticates only the
 * procedures, run, or flow it names, until it expires, and stamps
 * {@link scopedPrincipal}. With no credential the composition is
 * loopback-only (see {@link listenOptions}) and every request runs as the
 * anonymous read principal. A session operator token alone stamps the local
 * operator for approval decisions; without it approvals are unauthorized.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export declare const layerAuth: (options: ServerOptions) => Layer.Layer<ControlRpcs.ControlAuth>;
/**
 * The identity stamped only after this gateway verifies its configured token.
 * Hosts may explicitly delegate operator decisions to this exact identity.
 * @category constants
 * @since 1.0.0
 */
export declare const bearerPrincipal: Readonly<{
    id: "gateway";
    kind: "bearer";
}>;
/**
 * The protected mounts a scoped token may reach: those guarded in band by
 * `ControlAuth`, which checks each frame's procedure against the token, and
 * the ticket exchange that opens their sockets.
 * @category constants
 * @since 1.0.0
 */
export declare const scopedTokenPaths: ReadonlyArray<string>;
/**
 * The identity stamped after this gateway verifies a scoped token minted
 * under its configured credential. It is its own kind so that delegating
 * approval to {@link bearerPrincipal} does not delegate it to every token
 * minted from the bearer; a host that wants a scoped `approve:runs` token to
 * decide delegates to this identity explicitly.
 * @category constants
 * @since 1.0.0
 */
export declare const scopedPrincipal: Readonly<{
    id: "gateway";
    kind: "scoped";
}>;
/**
 * The ingress policy a requested bind runs behind.
 *
 * The accepted Host names are the loopback names, the operator's
 * `allowedHosts`, and the concrete bind host itself, so `--host 192.168.1.10`
 * is reachable at that address without naming it twice. A wildcard bind
 * (`0.0.0.0` or `::`) adds nothing: every interface is not a Host name, and
 * the operator names the reachable ones. Protected paths are authenticated
 * before any request body is read.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export declare const ingressOptions: (options: ServerOptions) => GatewayServer.IngressOptions;
/**
 * Hosts the assembled gateway on an injected native HTTP server.
 *
 * Supplies the bind policy, the shared-credential authentication both RPC
 * mounts run under, and newline-delimited JSON as the wire serialization. The
 * caller supplies what the mounts read through: `Control`, `Projections`,
 * `SyncServer`, and the `SyncAuth` middleware.
 *
 * The returned layer retains the concrete `HttpServer` service, so a caller
 * that bound port 0 can read the ephemeral address it got.
 *
 * Policy refusals and operating-system listen failures both fail the layer as
 * sanitized `bind_failed` `GatewayError` values.
 *
 * @param health the identity `GET /health` answers with
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export declare const makeLayer: (server: (options: ListenOptions) => Layer.Layer<HttpServer, ServeError | GatewayError>) => (health: GatewayServer.Health, options?: ServerOptions) => Layer.Layer<HttpServer, GatewayError | import("@smthrs/sync/SyncError").SyncError, import("@smthrs/control/Control").Control | import("../Projections.vibe").Projections | import("@smthrs/sync/SyncRpcs").SyncAuth | import("@smthrs/sync/SyncServer").SyncServer>;
