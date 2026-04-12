import { SocketRunner } from "@effect/cluster";
import { Layer } from "effect";
import { SandboxEntityExecutor } from "./sandbox-entity";
export declare const BubblewrapSandboxExecutorLive: Layer.Layer<SandboxEntityExecutor, never, never>;
export declare const SandboxSocketRunner: typeof SocketRunner;
