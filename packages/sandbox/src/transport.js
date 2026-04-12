// @smithers-type-exports-begin
/** @typedef {import("./transport.ts").SandboxBundleResult} SandboxBundleResult */
/** @typedef {import("./transport.ts").SandboxHandle} SandboxHandle */
/** @typedef {import("./transport.ts").SandboxTransportConfig} SandboxTransportConfig */
/** @typedef {import("./transport.ts").SandboxTransportService} SandboxTransportService */
// @smithers-type-exports-end

import { Context, Effect, Layer } from "effect";
import { CodeplaneSandboxExecutorLive, DockerSandboxExecutorLive, } from "./effect/http-runner.js";
import { SandboxEntityExecutor, makeSandboxTransportServiceEffect, } from "./effect/sandbox-entity.js";
import { BubblewrapSandboxExecutorLive } from "./effect/socket-runner.js";
import {} from "@smithers/errors/SmithersError";
/** @typedef {import("./transport.ts").transport} transport */

/** @typedef {import("./transport.ts").SandboxRuntime} SandboxRuntime */

export class SandboxTransport extends Context.Tag("SandboxTransport")() {
}
/**
 * @template R, E
 * @param {Layer.Layer<SandboxEntityExecutor, E, R>} executorLayer
 * @returns {Layer.Layer<SandboxTransport, E, R>}
 */
export function makeSandboxTransportLayer(executorLayer) {
    return Layer.scoped(SandboxTransport, makeSandboxTransportServiceEffect(executorLayer).pipe(Effect.map((service) => SandboxTransport.of(service))));
}
/**
 * @param {SandboxRuntime} runtime
 */
export function layerForSandboxRuntime(runtime) {
    switch (runtime) {
        case "docker":
            return makeSandboxTransportLayer(DockerSandboxExecutorLive);
        case "codeplane":
            return makeSandboxTransportLayer(CodeplaneSandboxExecutorLive);
        case "bubblewrap":
        default:
            return makeSandboxTransportLayer(BubblewrapSandboxExecutorLive);
    }
}
/**
 * @param {SandboxRuntime} requested
 * @returns {SandboxRuntime}
 */
export function resolveSandboxRuntime(requested) {
    if (requested !== "docker")
        return requested;
    const hasDocker = typeof Bun !== "undefined" ? Boolean(Bun.which("docker")) : false;
    return hasDocker ? "docker" : "bubblewrap";
}
