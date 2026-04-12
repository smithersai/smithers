import { Entity, ShardingConfig } from "@effect/cluster";
import * as Rpc from "@effect/rpc/Rpc";
import { Context, Effect, Layer, Schema } from "effect";
import type { SandboxTransportService } from "../transport";
export declare const SandboxEntity: Entity.Entity<"Sandbox", Rpc.Rpc<"create", Schema.Struct<{
    runId: typeof Schema.String;
    sandboxId: typeof Schema.String;
    runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
    rootDir: typeof Schema.String;
    image: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
    runId: typeof Schema.String;
    sandboxId: typeof Schema.String;
    sandboxRoot: typeof Schema.String;
    requestPath: typeof Schema.String;
    resultPath: typeof Schema.String;
    containerId: Schema.optional<typeof Schema.String>;
    workspaceId: Schema.optional<typeof Schema.String>;
}>, typeof Schema.Unknown, never> | Rpc.Rpc<"ship", Schema.Struct<{
    bundlePath: typeof Schema.String;
    handle: Schema.Struct<{
        runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
        runId: typeof Schema.String;
        sandboxId: typeof Schema.String;
        sandboxRoot: typeof Schema.String;
        requestPath: typeof Schema.String;
        resultPath: typeof Schema.String;
        containerId: Schema.optional<typeof Schema.String>;
        workspaceId: Schema.optional<typeof Schema.String>;
    }>;
}>, typeof Schema.Void, typeof Schema.Unknown, never> | Rpc.Rpc<"execute", Schema.Struct<{
    command: typeof Schema.String;
    handle: Schema.Struct<{
        runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
        runId: typeof Schema.String;
        sandboxId: typeof Schema.String;
        sandboxRoot: typeof Schema.String;
        requestPath: typeof Schema.String;
        resultPath: typeof Schema.String;
        containerId: Schema.optional<typeof Schema.String>;
        workspaceId: Schema.optional<typeof Schema.String>;
    }>;
}>, Schema.Struct<{
    exitCode: typeof Schema.Number;
}>, typeof Schema.Unknown, never> | Rpc.Rpc<"collect", Schema.Struct<{
    handle: Schema.Struct<{
        runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
        runId: typeof Schema.String;
        sandboxId: typeof Schema.String;
        sandboxRoot: typeof Schema.String;
        requestPath: typeof Schema.String;
        resultPath: typeof Schema.String;
        containerId: Schema.optional<typeof Schema.String>;
        workspaceId: Schema.optional<typeof Schema.String>;
    }>;
}>, Schema.Struct<{
    bundlePath: typeof Schema.String;
}>, typeof Schema.Unknown, never> | Rpc.Rpc<"cleanup", Schema.Struct<{
    handle: Schema.Struct<{
        runtime: Schema.Literal<["bubblewrap", "docker", "codeplane"]>;
        runId: typeof Schema.String;
        sandboxId: typeof Schema.String;
        sandboxRoot: typeof Schema.String;
        requestPath: typeof Schema.String;
        resultPath: typeof Schema.String;
        containerId: Schema.optional<typeof Schema.String>;
        workspaceId: Schema.optional<typeof Schema.String>;
    }>;
}>, typeof Schema.Void, typeof Schema.Unknown, never>>;
declare const SandboxEntityExecutor_base: Context.TagClass<SandboxEntityExecutor, "SandboxEntityExecutor", SandboxTransportService>;
export declare class SandboxEntityExecutor extends SandboxEntityExecutor_base {
}
export declare function makeSandboxEntityId(input: {
    runId: string;
    sandboxId: string;
}): string;
export declare const makeSandboxTransportServiceEffect: <R, E>(executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>) => Effect.Effect<SandboxTransportService, E, import("effect/Scope").Scope | Exclude<Exclude<R, import("@effect/cluster/Sharding").Sharding>, ShardingConfig.ShardingConfig>>;
export {};
