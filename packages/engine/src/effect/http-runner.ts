import { HttpRunner } from "@effect/cluster";
import { Layer } from "effect";
import { SandboxEntityExecutor } from "@smithers/sandbox/effect/sandbox-entity";
export declare const DockerSandboxExecutorLive: Layer.Layer<SandboxEntityExecutor, never, never>;
export declare const CodeplaneSandboxExecutorLive: Layer.Layer<SandboxEntityExecutor, never, never>;
export declare const SandboxHttpRunner: typeof HttpRunner;
