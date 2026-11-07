/**
 * Mount declarations: an overlay repository that automates an upstream one.
 *
 * An overlay repository holds a `.smithers/` directory and nothing it would
 * otherwise have to fork. Its `.smithers/config.ts` default-exports
 * {@link Mounts}, naming each upstream repository it mounts onto: the pinned
 * commit, the branch drift is measured against, the drift policy, and the
 * explicit patches applied to the upstream source. The build CLI clones the
 * pin, applies the patches, and lays the overlay's `.smithers/` over the
 * checkout, so the overlay's targets run as if they lived upstream.
 *
 * Construction validates and freezes data and performs no I/O, like every
 * other workspace declaration. Materialization belongs to
 * `@smthrs/build-cli/Mount`.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * What a mount does when the tracked branch has moved past its pin.
 *
 * `warn` materializes the pin and reports the newer commit. `refuse` fails
 * before any target runs, so CI keeps the pin current. `follow` materializes
 * the tracked branch's tip instead of the pin and still applies every patch.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const DriftPolicy: Schema.Literals<readonly ["warn", "refuse", "follow"]>;
/**
 * A drift policy.
 *
 * @category models
 * @since 1.0.0
 */
export type DriftPolicy = typeof DriftPolicy.Type;
/**
 * Schema for one mount.
 *
 * `ref` is the pin: a full lowercase commit id, because a branch or tag can
 * move under a pin. `patches` are paths relative to `.smithers/`, applied in
 * order. `overlay` is the directory under `.smithers/` laid over the
 * checkout's `.smithers/`; `"."` lays the whole directory except
 * `config.ts`, the declared patches, and other mounts' overlay directories.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Declaration: Schema.TaggedStruct<"Mount", {
    readonly repository: Schema.NonEmptyString;
    readonly ref: Schema.String;
    readonly track: Schema.optional<Schema.NonEmptyString>;
    readonly drift: Schema.withConstructorDefault<Schema.Literals<readonly ["warn", "refuse", "follow"]>>;
    readonly patches: Schema.withConstructorDefault<Schema.$Array<Schema.NonEmptyString>>;
    readonly overlay: Schema.withConstructorDefault<Schema.NonEmptyString>;
}>;
/**
 * One validated mount.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type;
/**
 * The options {@link Mount} accepts.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    /** A git URL or path the checkout fetches from. */
    readonly repository: string;
    /** The pinned commit: a full lowercase commit id. */
    readonly ref: string;
    /** The branch drift is measured against. Required by `refuse` and `follow`. */
    readonly track?: string | undefined;
    /** @default "warn" */
    readonly drift?: DriftPolicy | undefined;
    /** Patch files relative to `.smithers/`, applied in order. @default [] */
    readonly patches?: ReadonlyArray<string> | undefined;
    /** The directory under `.smithers/` laid over the checkout. @default "." */
    readonly overlay?: string | undefined;
}
/**
 * Declares one upstream repository an overlay mounts onto.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export default S.Mounts({
 *   effect: S.Mount({
 *     repository: "https://github.com/Effect-TS/effect.git",
 *     ref: "b04191b2941534754282c51ef2df2f965ac43a5c",
 *     track: "main",
 *     drift: "warn"
 *   })
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Mount: (options: Options) => Declaration;
/**
 * Runtime marker for {@link Mounts}.
 *
 * @category type ids
 * @since 1.0.0
 */
export declare const TypeId: unique symbol;
/**
 * Every mount an overlay declares, by name.
 *
 * @category models
 * @since 1.0.0
 */
export interface Mounts {
    readonly [TypeId]: typeof TypeId;
    readonly mounts: Readonly<Record<string, Declaration>>;
}
/**
 * Declares the mounts an overlay's `.smithers/config.ts` default-exports.
 *
 * A name is lowercase letters, digits, and dashes. It names the checkout
 * directory, `.mounts/<name>`, at the overlay root.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const Mounts: (mounts: Readonly<Record<string, Declaration>>) => Mounts;
/**
 * Checks whether a value is a {@link Mounts} declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isMounts: (value: unknown) => value is Mounts;
