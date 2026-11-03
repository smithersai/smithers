/**
 * The sync read path's connection authentication: implementations of the
 * `SyncRpcs.SyncAuth` RPC middleware.
 *
 * A connection presents a {@link WorkspaceShare.WorkspaceCapability} in the
 * {@link capabilityHeader} request header. {@link layer} verifies it against
 * the workspace's {@link WorkspaceShare.WorkspaceShare} authority and runs
 * the handler as the workspace principal. A request with no header runs as
 * the anonymous principal — branch share capabilities carried in request
 * payloads still authorize branch reads — and the server refuses anonymous
 * access to every non-branch run. A request whose header is present but
 * malformed, forged, expired, or signed by an unknown key is refused
 * outright: presence of a credential is a claim, and a false claim is never
 * downgraded to anonymity.
 *
 * There is deliberately no trusted pass-through implementation here: the only
 * sanctioned bypass is an in-process caller providing `SyncPrincipal` itself,
 * never a transport.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { SyncError } from "../../../src/SyncError.ts";
import { SyncAuth } from "../../../src/SyncRpcs.ts";
import * as WorkspaceShare from "../../../src/WorkspaceShare.ts";
/**
 * The request header a connection presents its workspace capability in.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const capabilityHeader = "flows-sync-workspace";
/**
 * Renders a workspace capability as its header value: unpadded base64url of
 * the schema-encoded capability JSON.
 *
 * @category encoding
 * @since 0.1.0
 */
export declare const encodeCapability: (capability: WorkspaceShare.WorkspaceCapability) => Effect.Effect<string, SyncError>;
/**
 * Decodes a capability header value. Every malformation folds to the same
 * `unauthorized` refusal so the header is not a parsing oracle.
 *
 * @category encoding
 * @since 0.1.0
 */
export declare const decodeCapability: (value: string) => Effect.Effect<WorkspaceShare.WorkspaceCapability, SyncError>;
/**
 * Provides the workspace-capability authentication middleware: no header
 * runs the handler as anonymous, a verified header runs it as the workspace
 * principal, and anything else refuses the request. Verification faults
 * (Web Crypto failing) propagate as their own error rather than as a
 * refusal.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<SyncAuth, never, WorkspaceShare.WorkspaceShare>;
/**
 * Stamps every outgoing request from a generated RPC client with the given
 * workspace capability.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerClient: (capability: WorkspaceShare.WorkspaceCapability) => Layer.Layer<RpcMiddleware.ForClient<SyncAuth>, SyncError>;
