/**
 * File-system routing over metadata-only registry discovery.
 *
 * @since 0.1.0
 */
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, FileSystem, Path } from "effect"
import { FsError } from "./FsError.vibe"
import * as Route from "./Route.vibe"
/**
 * Configuration for one bounded file-router scan.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScanConfig {
  root: string
}
/**
 * A non-fatal diagnostic emitted by registry discovery.
 *
 * @category models
 * @since 0.1.0
 */
export type Warning = Descriptor.DiscoveryWarning
/**
 * The immutable metadata-only result of scanning a flows tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScanResult {
  routes: ReadonlyArray<Route.Route>
  warnings: ReadonlyArray<Warning>
}
/**
 * Scans a flows root without importing or evaluating any flow module.
 *
 * The registry owns entry precedence, metadata parsing, directive detection,
 * and bounded reads. This adapter projects descriptors into absolute,
 * immutable path-derived routes.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function scan(config: ScanConfig): Effect.Effect<ScanResult, FsError, FileSystem.FileSystem | Path.Path>
