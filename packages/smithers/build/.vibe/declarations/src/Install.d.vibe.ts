/**
 * The `install` flow: measure, fetch, link.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` gives two nouns. The atoms
 * here are Actions, because each carries an implementation that is
 * attached separately as a `Layer` and none of them is made of steps. The
 * composite is a Flow, because it has a pure plan-time body and no opaque
 * code of its own.
 *
 * The shape follows Bazel's fetch/build split and rules_js's `npm_translate_lock`
 * split, restated in this vocabulary:
 *
 * | step    | tier   | boundary | admitted to the cross-run cache |
 * | ------- | ------ | -------- | ------------------------------- |
 * | measure | sealed | expected | no                              |
 * | fetch/* | sealed | expected | no                              |
 * | link    | irreversible | expected | no                        |
 *
 * All effect tiers can be planned. Measure and fetch use `expected` boundaries,
 * which keep them out of the cross-run cache, because
 * `ActionPersistence` admits a result only when the tier is `sealed` AND the
 * boundary mode is `hard`. Link uses a run-local identity and cannot publish
 * a cache entry regardless of boundary mode. It is not compensable: ordinary
 * workspace snapshots omit ignored `node_modules` trees and cannot restore a
 * half-finished link. No automatic retry or blind crash recovery is promised.
 *
 * A `node_modules` tree is a graph of links into a local store, so
 * restoring one from another machine would produce a tree whose entries point
 * at nothing. Link is therefore never admitted, and measure is not admitted
 * either.
 *
 * ## What measure is, and what it is not
 *
 * Measure reports **content**: the lockfile, credential-free `.npmrc`,
 * and pnpm hook and workspace digests. It used to report an `Environment` struct that
 * also carried the manager name, the manager version, and the host platform,
 * and the flow ran in two trampoline rounds so a later round could select a
 * manager-specific fetch from a measured manager name.
 *
 * Those three fields were never content. They are the identity of two host
 * services, and they now come from those services:
 *
 * - Which manager, and which version it must be, is
 *   {@link PackageManager.Service}. The workspace declares the version and
 *   `PackageManager.Service.verify` holds the host to it.
 * - The platform is {@link Runtime.Service}. It describes the machine, so it
 *   belongs to the runtime rather than to a struct passed between steps.
 *
 * Two consequences follow. The flow no longer trampolines: the manager arrives
 * in the payload as a plan-time declaration from legacy declaration, so one round records
 * measure, exactly one fetch, and link. And the cross-round recheck is gone
 * with the second round, replaced by `verify`, which compares the host against
 * what the workspace declared rather than against an earlier measurement of the
 * same host.
 *
 * Measure still exists, and still runs in its own step, because the input digests
 * are step-key material: an install whose lockfile changed must not be answered
 * by the previous install's recorded result.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import { Action, Flow } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PackageManager from "../../../src/PackageManager.ts";
import * as Runtime from "../../../src/Runtime.ts";
/**
 * Schema for the content an install is keyed on.
 *
 * The fields contain file paths and digests. Nothing here names a host, a
 * manager, or a path into a store, because this value exists to make one install distinguishable from
 * another install of different dependencies.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Content: Schema.Struct<{
    /** The lockfile path and its measured digest. */
    readonly lockfile: Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>;
    /** The credential-free `.npmrc` and its digest, or `null` when absent. */
    readonly npmrc: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
    /** The project pnpm hook, or `null` when absent or not using pnpm. */
    readonly pnpmfile: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
    /** The pnpm workspace manifest, or `null` when absent or not using pnpm. */
    readonly workspace: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
}>;
/**
 * The content an install is keyed on.
 *
 * @category models
 * @since 0.1.0
 */
export type Content = typeof Content.Type;
/**
 * Schema for what a completed link reports.
 *
 * The digest describes the tree; the tree itself is never a value, never an
 * artifact, and never leaves the host.
 *
 * @category models
 * @since 0.1.0
 */
export declare const LinkManifest: Schema.Struct<{
    /** The store manifest digest this tree was linked from. */
    readonly store: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    /** Digest of the store, root package manifest, and manager tree evidence. */
    readonly manifest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    /**
     * Always `true`: link never trusts a freshness marker.
     *
     * Manager metadata describes the intended graph and cannot prove every
     * package file is still present and unmodified, so the manager runs every
     * time and no code path produces `false`. The field is reserved for an
     * implementation that can prove a tree intact. It stays on the schema
     * because `@smthrs/targets` declares this struct as the `Install` target's
     * public success type, so removing it is a coordinated change in both
     * packages rather than a rename here.
     */
    readonly linked: Schema.Boolean;
}>;
/**
 * What a completed link reports.
 *
 * @category models
 * @since 0.1.0
 */
export type LinkManifest = typeof LinkManifest.Type;
/**
 * Measures the content every later step keys on.
 *
 * Declared with an `expected` boundary so that no cross-run cache ever answers
 * it. Re-measuring costs a few file digests, and a restored measurement would
 * describe another machine's checkout.
 *
 * `manager` is in the payload as key material and for nothing else: the
 * implementation reads the manager from its layer, never from here. With an
 * empty payload a pnpm install and a Bun install of one workspace shared a
 * single measure key, which is inert only while the boundary stays `expected`
 * and becomes a hit on another manager's measurement the day it hardens. The
 * declared manager is not checked against the composed layer here: that check
 * belongs at the composition root that wires a layer against a declaration,
 * not inside a sealed action that receives only the layer.
 *
 * @category actions
 * @since 0.1.0
 */
export declare const Measure: Action.Declared<"smithers-build/install/measure", Schema.Struct<{
    manager: Schema.Literals<readonly ["pnpm", "bun"]>;
}>, Schema.Struct<{
    /** The lockfile path and its measured digest. */
    readonly lockfile: Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>;
    /** The credential-free `.npmrc` and its digest, or `null` when absent. */
    readonly npmrc: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
    /** The project pnpm hook, or `null` when absent or not using pnpm. */
    readonly pnpmfile: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
    /** The pnpm workspace manifest, or `null` when absent or not using pnpm. */
    readonly workspace: Schema.NullOr<Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>>;
}>, typeof PackageManager.PackageManagerError, Action.Requirement<"smithers-build/install/measure">>;
/**
 * Fetches pnpm packages from `pnpm-lock.yaml`.
 *
 * @category actions
 * @since 0.1.0
 */
export declare const FetchPnpm: Action.Declared<"smithers-build/install/fetch/pnpm", Schema.Struct<{
    content: Schema.Struct<{
        /** The lockfile path and its measured digest. */
        readonly lockfile: Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>;
        /** The credential-free `.npmrc` and its digest, or `null` when absent. */
        readonly npmrc: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
        /** The project pnpm hook, or `null` when absent or not using pnpm. */
        readonly pnpmfile: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
        /** The pnpm workspace manifest, or `null` when absent or not using pnpm. */
        readonly workspace: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly manager: Schema.Literals<readonly ["pnpm", "bun"]>;
    readonly managerVersion: Schema.NonEmptyString;
    readonly platform: Schema.NullOr<Schema.Struct<{
        readonly os: Schema.NonEmptyString;
        readonly arch: Schema.NonEmptyString;
        readonly libc: Schema.NullOr<Schema.NonEmptyString>;
    }>>;
    readonly digest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
}>, typeof PackageManager.PackageManagerError, Action.Requirement<"smithers-build/install/fetch/pnpm">>;
/**
 * Materializes `node_modules` from the already-populated store.
 *
 * Its `irreversible` tier keeps it out of the cross-run cache. Here the
 * boundary is the restorable workspace, not the physical project directory:
 * ignored dependency trees are outside a normal snapshot. A completed attempt
 * replays within its run; a new run reconciles the tree again. An uncertain
 * interrupted attempt requires operator reconciliation, not a blind retry.
 * Its expected write set names root and nested dependency trees for conflict
 * ordering. A non-sealed write declaration does not publish file artifacts,
 * so the planner can see these mutations without caching the installed tree.
 *
 * @category actions
 * @since 0.1.0
 */
export declare const Link: Action.Declared<"smithers-build/install/link", Schema.Struct<{
    content: Schema.Struct<{
        /** The lockfile path and its measured digest. */
        readonly lockfile: Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>;
        /** The credential-free `.npmrc` and its digest, or `null` when absent. */
        readonly npmrc: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
        /** The project pnpm hook, or `null` when absent or not using pnpm. */
        readonly pnpmfile: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
        /** The pnpm workspace manifest, or `null` when absent or not using pnpm. */
        readonly workspace: Schema.NullOr<Schema.Struct<{
            readonly path: Schema.NonEmptyString;
            readonly digest: Schema.NonEmptyString;
        }>>;
    }>;
    store: Schema.Struct<{
        readonly manager: Schema.Literals<readonly ["pnpm", "bun"]>;
        readonly managerVersion: Schema.NonEmptyString;
        readonly platform: Schema.NullOr<Schema.Struct<{
            readonly os: Schema.NonEmptyString;
            readonly arch: Schema.NonEmptyString;
            readonly libc: Schema.NullOr<Schema.NonEmptyString>;
        }>>;
        readonly digest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    }>;
}>, Schema.Struct<{
    /** The store manifest digest this tree was linked from. */
    readonly store: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    /** Digest of the store, root package manifest, and manager tree evidence. */
    readonly manifest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    /**
     * Always `true`: link never trusts a freshness marker.
     *
     * Manager metadata describes the intended graph and cannot prove every
     * package file is still present and unmodified, so the manager runs every
     * time and no code path produces `false`. The field is reserved for an
     * implementation that can prove a tree intact. It stays on the schema
     * because `@smthrs/targets` declares this struct as the `Install` target's
     * public success type, so removing it is a coordinated change in both
     * packages rather than a rename here.
     */
    readonly linked: Schema.Boolean;
}>, typeof PackageManager.PackageManagerError, Action.Requirement<"smithers-build/install/link">>;
/**
 * The install payload.
 *
 * `manager` is the manager the workspace declares. It is a
 * plan-time value, which is what lets one round select exactly one fetch
 * action; the previous design had to measure the manager first and hand off to
 * a second round to do the same job. The project root is the engine's working
 * directory, so it does not enter a content key.
 *
 * Only pnpm is admitted. A Bun payload used to plan a `FetchBun` action whose
 * manager refused every operation, so the install always failed at run time;
 * the payload now refuses it when the flow is called (see
 * {@link PackageManager.bunInstallUnsupportedMessage}).
 *
 * @category models
 * @since 0.1.0
 */
export declare const payloadFields: {
    manager: Schema.Literal<"pnpm">;
};
/**
 * The implementations the body names.
 *
 * @category models
 * @since 0.1.0
 */
export type Requires = Action.Requirement<"smithers-build/install/measure"> | Action.Requirement<"smithers-build/install/fetch/pnpm"> | Action.Requirement<"smithers-build/install/link">;
/**
 * The declaration shape the flow is named under.
 *
 * @category models
 * @since 0.1.0
 */
export type InstallFlow = Flow.Flow<"smithers-build/install", Schema.Struct<typeof payloadFields>, typeof LinkManifest, typeof PackageManager.PackageManagerError, Requires>;
/**
 * Installs a project's dependencies.
 *
 * The body is pure: it records nodes and executes nothing. It runs in one
 * round. The manager is a declaration in the payload, so the body selects one
 * manager-specific fetch statically, and measure feeds it as an ordinary
 * settled upstream reference rather than as a second round's payload.
 *
 * The capability ceiling is declared here rather than per action because
 * `Graph.build` reads it from the flow and copies it onto every node it
 * records; an `Action` declaration's own `Flow.Capabilities` annotation is
 * never read. DESIGN.md records that discrepancy against
 * `docs/specs/Concepts/Step Keys.md`, which describes capabilities as
 * per-step key material.
 *
 * @category flows
 * @since 0.1.0
 */
export declare const Install: InstallFlow;
/**
 * The implementation of {@link Measure}.
 *
 * It reads the manager inputs and digests them. It measures no manager version and no
 * platform, because neither is content and both now have a service that
 * answers for them.
 *
 * Exported for the same reason {@link executeFetch} and {@link executeLink}
 * are: a test that drives the layer's body has to be able to name it, and a
 * body reachable only through `MeasureLive` is a body a test re-implements
 * inline and then asserts against its own copy.
 *
 * Fails with `environment_mismatch` when the manager layer's lockfile name or
 * store directory is not the one its manager name requires,
 * `lockfile_unreadable` or `manifest_unreadable` when an input cannot be read
 * as a regular file inside the project, and `unsafe_configuration` when the
 * project `.npmrc` embeds a credential or a misplaced environment placeholder.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const executeMeasure: () => Effect.Effect<Content, PackageManager.PackageManagerError, PackageManager.PackageManager | FileSystem.FileSystem | Crypto.Crypto>;
/**
 * Implements {@link Measure}.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const MeasureLive: Layer.Layer<Action.Requirement<"smithers-build/install/measure">, never, Crypto.Crypto | FileSystem.FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | PackageManager.PackageManager>;
/**
 * The implementation shared by the manager-specific fetch declarations.
 *
 * It holds the layer, the host manager, and the host runtime to the
 * declaration before the manager writes anything, then reports the store
 * manifest the measured content produces.
 *
 * Fails with `environment_mismatch` when the layer is inconsistent or the
 * host runtime or manager does not satisfy its declared version, with
 * `input_drift` when a measured input differs before or after the manager
 * runs, and with the manager's own error when `fetch` fails.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const executeFetch: ({ content }: {
    readonly content: Content;
}) => Effect.Effect<{
    readonly manager: "bun" | "pnpm";
    readonly managerVersion: string;
    readonly platform: {
        readonly os: string;
        readonly arch: string;
        readonly libc: string | null;
    } | null;
    readonly digest: string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">;
}, PackageManager.PackageManagerError, Crypto.Crypto | FileSystem.FileSystem | PackageManager.PackageManager | Runtime.Runtime>;
/**
 * Implements {@link FetchPnpm}.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const FetchPnpmLive: Layer.Layer<Action.Requirement<"smithers-build/install/fetch/pnpm">, never, Crypto.Crypto | FileSystem.FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | PackageManager.PackageManager | Runtime.Runtime>;
/**
 * The implementation of {@link Link}.
 *
 * Link always asks the selected package manager to reconcile `node_modules`.
 * Manager metadata such as npm's hidden lockfile or pnpm's modules manifest
 * describes the intended graph, but cannot prove that every package file is
 * still present and unmodified. Treating that metadata as a freshness proof
 * would silently accept a deleted or corrupted package. The expected boundary
 * keeps this work local and out of the shared action cache.
 *
 * Fails with `environment_mismatch` when the host does not satisfy the
 * declarations or `store` was fetched by another manager, manager version,
 * platform, or measured content; with `input_drift` when a measured input or
 * the root `package.json` changes before or during the link; and with the
 * manager's own error when `link` fails.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const executeLink: ({ content, store }: {
    readonly content: Content;
    readonly store: PackageManager.StoreManifest;
}) => Effect.Effect<{
    store: string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">;
    manifest: string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">;
    linked: boolean;
}, PackageManager.PackageManagerError, Crypto.Crypto | FileSystem.FileSystem | PackageManager.PackageManager | Runtime.Runtime>;
/**
 * Implements {@link Link}.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const LinkLive: Layer.Layer<Action.Requirement<"smithers-build/install/link">, never, Crypto.Crypto | FileSystem.FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | PackageManager.PackageManager | Runtime.Runtime>;
/**
 * Every implementation the {@link Install} flow needs.
 *
 * Compose it over a `PackageManager` layer, a `Runtime` layer, a
 * `FlowRuntime`, and the host services those need. Selecting the manager and
 * the runtime is the only choice a consumer makes.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<Action.Requirement<"smithers-build/install/fetch/pnpm"> | Action.Requirement<"smithers-build/install/link"> | Action.Requirement<"smithers-build/install/measure">, never, Crypto.Crypto | FileSystem.FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | PackageManager.PackageManager | Runtime.Runtime>;
