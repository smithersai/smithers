/**
 * Alchemy 2 stack for bug.smithers.sh. Importing it deploys nothing.
 *
 * One Cloudflare Worker (entry: src/worker.ts), a rate-limit Durable Object
 * (one atomic counter per bucket), and one KV namespace for bug reports.
 * The smithers.sh zone lives on
 * this Cloudflare account (migrated from Vercel DNS 2026-06-25), so the
 * Worker serves bug.smithers.sh as a custom domain directly.
 *
 * Plan:     pnpm -C apps/bug-worker run plan
 * Deploy:   qualified Cloud rollout only; see docs/deployment.md
 * Destroy:  pnpm -C apps/bug-worker run destroy
 * Provider operations pin `--stage prod`; state lives in the account's shared
 * `alchemy-state-store` Worker, so every machine plans against one record.
 * The physical names are the ones Alchemy 1 derived for the live resources;
 * the first Alchemy 2 plan and deploy add `--adopt` to take them over.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD and BUG_ADMIN_TOKEN.
 * A deploy without one fails instead of removing the live binding.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
export declare const bugReportsProps: {
    title: string;
};
export declare const workerProps: {
    name: string;
    main: string;
    compatibility: {
        date: string;
    };
    workersDev: false;
    observability: {
        enabled: true;
        logs: {
            enabled: true;
            invocationLogs: true;
            persist: true;
        };
    };
    env: {
        BUGS: import("effect/Effect").Effect<Cloudflare.KV.Namespace, never, Cloudflare.Providers>;
        RATE_LIMITS: Cloudflare.DurableObjectLike<unknown>;
        BUG_ADMIN_TOKEN: Config.Config<Redacted.Redacted<string>>;
        PUBLIC_BASE_URL: string;
    };
    domain: {
        name: string;
        aliases: string[];
        zoneId: string;
    };
};
export declare const worker: import("effect/Effect").Effect<import("effect/Pipeable").Pipeable & Alchemy.ResourceLike<"Cloudflare.Worker", Cloudflare.WorkerProps<{
    BUGS: Cloudflare.KV.Namespace;
    RATE_LIMITS: Cloudflare.DurableObjectLike<unknown>;
    BUG_ADMIN_TOKEN: Redacted.Redacted<string>;
    PUBLIC_BASE_URL: string;
}, Cloudflare.WorkerAssetsConfig | undefined>, {
    workerId: string;
    workerName: string;
    namespace: string | undefined;
    logpush: boolean | undefined;
    url: string | undefined;
    urls: string[];
    domain: {
        name: string;
        aliases: string[];
        redirects: string[];
        zone?: Cloudflare.Zone.Reference;
        previews?: boolean;
    } | undefined;
    tags: string[] | undefined;
    durableObjectNamespaces: Record<string, string>;
    accountId: string;
    routes: {
        id: string;
        pattern: string;
        zoneId: string;
        url?: string;
    }[];
    crons: string[];
    tailConsumers?: {
        service: string;
    }[] | undefined;
    streamingTailConsumers?: {
        service: string;
    }[] | undefined;
    versionOf?: string | undefined;
    previewOf?: string | undefined;
    previewId?: string | undefined;
    previewName?: string | undefined;
    previewSlug?: string | undefined;
    previewDoClasses?: string[] | undefined;
    versionId?: string | undefined;
    versionAlias?: string | undefined;
    deploymentId?: string | undefined;
    affinityZoneIds?: string[] | undefined;
    hash?: {
        assets: string | undefined;
        bundle: string | undefined;
        input: string | undefined;
        additionalWorkspaces: string[] | undefined;
        metadata?: string | undefined;
    };
}, {
    bindings?: Cloudflare.WorkerBinding[];
    env?: Record<string, any>;
    cache?: Cloudflare.WorkerCache;
    observability?: Pick<Cloudflare.WorkerObservability, "traces">;
    containers?: {
        className: string;
        attachedBy?: "binding";
        name?: string;
        images?: Record<string, string>;
        devImages?: Record<string, Cloudflare.DevContainerImage>;
        dev: Cloudflare.DevContainerImage | undefined;
        hash: string | undefined;
    }[];
    crons?: string[];
    hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
    devRemote?: Record<string, boolean>;
}, Cloudflare.Providers> & {
    bind(sid: Alchemy.Input<string>, binding: Alchemy.Input<{
        bindings?: Cloudflare.WorkerBinding[];
        env?: Record<string, any>;
        cache?: Cloudflare.WorkerCache;
        observability?: Pick<Cloudflare.WorkerObservability, "traces">;
        containers?: {
            className: string;
            attachedBy?: "binding";
            name?: string;
            images?: Record<string, string>;
            devImages?: Record<string, Cloudflare.DevContainerImage>;
            dev: Cloudflare.DevContainerImage | undefined;
            hash: string | undefined;
        }[];
        crons?: string[];
        hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
        devRemote?: Record<string, boolean>;
    }>): import("effect/Effect").Effect<void>;
    bind(template: TemplateStringsArray, ...args: any[]): (binding: Alchemy.Input<{
        bindings?: Cloudflare.WorkerBinding[];
        env?: Record<string, any>;
        cache?: Cloudflare.WorkerCache;
        observability?: Pick<Cloudflare.WorkerObservability, "traces">;
        containers?: {
            className: string;
            attachedBy?: "binding";
            name?: string;
            images?: Record<string, string>;
            devImages?: Record<string, Cloudflare.DevContainerImage>;
            dev: Cloudflare.DevContainerImage | undefined;
            hash: string | undefined;
        }[];
        crons?: string[];
        hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
        devRemote?: Record<string, boolean>;
    }>) => import("effect/Effect").Effect<void>;
} & {
    workerId: Alchemy.Output<string, never>;
    workerName: Alchemy.Output<string, never>;
    namespace: Alchemy.Output<string | undefined, never>;
    logpush: Alchemy.Output<boolean | undefined, never>;
    url: Alchemy.Output<string | undefined, never>;
    urls: Alchemy.Output<string[], never>;
    domain: Alchemy.Output<{
        name: string;
        aliases: string[];
        redirects: string[];
        zone?: Cloudflare.Zone.Reference;
        previews?: boolean;
    } | undefined, never>;
    tags: Alchemy.Output<string[] | undefined, never>;
    durableObjectNamespaces: import("alchemy/Output").ObjectExpr<Record<string, string>, never>;
    accountId: Alchemy.Output<string, never>;
    routes: Alchemy.Output<{
        id: string;
        pattern: string;
        zoneId: string;
        url?: string;
    }[], never>;
    crons: Alchemy.Output<string[], never>;
    tailConsumers: Alchemy.Output<{
        service: string;
    }[] | undefined, never>;
    streamingTailConsumers: Alchemy.Output<{
        service: string;
    }[] | undefined, never>;
    versionOf: Alchemy.Output<string | undefined, never>;
    previewOf: Alchemy.Output<string | undefined, never>;
    previewId: Alchemy.Output<string | undefined, never>;
    previewName: Alchemy.Output<string | undefined, never>;
    previewSlug: Alchemy.Output<string | undefined, never>;
    previewDoClasses: Alchemy.Output<string[] | undefined, never>;
    versionId: Alchemy.Output<string | undefined, never>;
    versionAlias: Alchemy.Output<string | undefined, never>;
    deploymentId: Alchemy.Output<string | undefined, never>;
    affinityZoneIds: Alchemy.Output<string[] | undefined, never>;
    hash: Alchemy.Output<{
        assets: string | undefined;
        bundle: string | undefined;
        input: string | undefined;
        additionalWorkspaces: string[] | undefined;
        metadata?: string | undefined;
    } | undefined, never>;
} & {
    readonly env: Cloudflare.WorkerEnvBindings<{
        BUGS: Cloudflare.KV.Namespace;
        RATE_LIMITS: Cloudflare.DurableObjectLike<unknown>;
        BUG_ADMIN_TOKEN: Redacted.Redacted<string>;
        PUBLIC_BASE_URL: string;
    }>;
} & Alchemy.Rpc<{}>, never, Cloudflare.Providers> & Alchemy.PlatformIdentity<"smithers-bug-worker">;
declare const _default: import("effect/Effect").Effect<Alchemy.CompiledStack<import("effect/Pipeable").Pipeable & Alchemy.ResourceLike<"Cloudflare.Worker", Cloudflare.WorkerProps<{
    BUGS: Cloudflare.KV.Namespace;
    RATE_LIMITS: Cloudflare.DurableObjectLike<unknown>;
    BUG_ADMIN_TOKEN: Redacted.Redacted<string>;
    PUBLIC_BASE_URL: string;
}, Cloudflare.WorkerAssetsConfig | undefined>, {
    workerId: string;
    workerName: string;
    namespace: string | undefined;
    logpush: boolean | undefined;
    url: string | undefined;
    urls: string[];
    domain: {
        name: string;
        aliases: string[];
        redirects: string[];
        zone?: Cloudflare.Zone.Reference;
        previews?: boolean;
    } | undefined;
    tags: string[] | undefined;
    durableObjectNamespaces: Record<string, string>;
    accountId: string;
    routes: {
        id: string;
        pattern: string;
        zoneId: string;
        url?: string;
    }[];
    crons: string[];
    tailConsumers?: {
        service: string;
    }[] | undefined;
    streamingTailConsumers?: {
        service: string;
    }[] | undefined;
    versionOf?: string | undefined;
    previewOf?: string | undefined;
    previewId?: string | undefined;
    previewName?: string | undefined;
    previewSlug?: string | undefined;
    previewDoClasses?: string[] | undefined;
    versionId?: string | undefined;
    versionAlias?: string | undefined;
    deploymentId?: string | undefined;
    affinityZoneIds?: string[] | undefined;
    hash?: {
        assets: string | undefined;
        bundle: string | undefined;
        input: string | undefined;
        additionalWorkspaces: string[] | undefined;
        metadata?: string | undefined;
    };
}, {
    bindings?: Cloudflare.WorkerBinding[];
    env?: Record<string, any>;
    cache?: Cloudflare.WorkerCache;
    observability?: Pick<Cloudflare.WorkerObservability, "traces">;
    containers?: {
        className: string;
        attachedBy?: "binding";
        name?: string;
        images?: Record<string, string>;
        devImages?: Record<string, Cloudflare.DevContainerImage>;
        dev: Cloudflare.DevContainerImage | undefined;
        hash: string | undefined;
    }[];
    crons?: string[];
    hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
    devRemote?: Record<string, boolean>;
}, Cloudflare.Providers> & {
    bind(sid: Alchemy.Input<string>, binding: Alchemy.Input<{
        bindings?: Cloudflare.WorkerBinding[];
        env?: Record<string, any>;
        cache?: Cloudflare.WorkerCache;
        observability?: Pick<Cloudflare.WorkerObservability, "traces">;
        containers?: {
            className: string;
            attachedBy?: "binding";
            name?: string;
            images?: Record<string, string>;
            devImages?: Record<string, Cloudflare.DevContainerImage>;
            dev: Cloudflare.DevContainerImage | undefined;
            hash: string | undefined;
        }[];
        crons?: string[];
        hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
        devRemote?: Record<string, boolean>;
    }>): import("effect/Effect").Effect<void>;
    bind(template: TemplateStringsArray, ...args: any[]): (binding: Alchemy.Input<{
        bindings?: Cloudflare.WorkerBinding[];
        env?: Record<string, any>;
        cache?: Cloudflare.WorkerCache;
        observability?: Pick<Cloudflare.WorkerObservability, "traces">;
        containers?: {
            className: string;
            attachedBy?: "binding";
            name?: string;
            images?: Record<string, string>;
            devImages?: Record<string, Cloudflare.DevContainerImage>;
            dev: Cloudflare.DevContainerImage | undefined;
            hash: string | undefined;
        }[];
        crons?: string[];
        hyperdrives?: Record<string, Required<Cloudflare.Hyperdrive.DevOrigin>>;
        devRemote?: Record<string, boolean>;
    }>) => import("effect/Effect").Effect<void>;
} & {
    workerId: Alchemy.Output<string, never>;
    workerName: Alchemy.Output<string, never>;
    namespace: Alchemy.Output<string | undefined, never>;
    logpush: Alchemy.Output<boolean | undefined, never>;
    url: Alchemy.Output<string | undefined, never>;
    urls: Alchemy.Output<string[], never>;
    domain: Alchemy.Output<{
        name: string;
        aliases: string[];
        redirects: string[];
        zone?: Cloudflare.Zone.Reference;
        previews?: boolean;
    } | undefined, never>;
    tags: Alchemy.Output<string[] | undefined, never>;
    durableObjectNamespaces: import("alchemy/Output").ObjectExpr<Record<string, string>, never>;
    accountId: Alchemy.Output<string, never>;
    routes: Alchemy.Output<{
        id: string;
        pattern: string;
        zoneId: string;
        url?: string;
    }[], never>;
    crons: Alchemy.Output<string[], never>;
    tailConsumers: Alchemy.Output<{
        service: string;
    }[] | undefined, never>;
    streamingTailConsumers: Alchemy.Output<{
        service: string;
    }[] | undefined, never>;
    versionOf: Alchemy.Output<string | undefined, never>;
    previewOf: Alchemy.Output<string | undefined, never>;
    previewId: Alchemy.Output<string | undefined, never>;
    previewName: Alchemy.Output<string | undefined, never>;
    previewSlug: Alchemy.Output<string | undefined, never>;
    previewDoClasses: Alchemy.Output<string[] | undefined, never>;
    versionId: Alchemy.Output<string | undefined, never>;
    versionAlias: Alchemy.Output<string | undefined, never>;
    deploymentId: Alchemy.Output<string | undefined, never>;
    affinityZoneIds: Alchemy.Output<string[] | undefined, never>;
    hash: Alchemy.Output<{
        assets: string | undefined;
        bundle: string | undefined;
        input: string | undefined;
        additionalWorkspaces: string[] | undefined;
        metadata?: string | undefined;
    } | undefined, never>;
} & {
    readonly env: Cloudflare.WorkerEnvBindings<{
        BUGS: Cloudflare.KV.Namespace;
        RATE_LIMITS: Cloudflare.DurableObjectLike<unknown>;
        BUG_ADMIN_TOKEN: Redacted.Redacted<string>;
        PUBLIC_BASE_URL: string;
    }>;
} & Alchemy.Rpc<{}>, any>, Config.ConfigError, never> & {
    readonly stackName: string;
} & Alchemy.StackProps<NoInfer<Cloudflare.Providers>>;
export default _default;
