/**
 * Trusted composition metadata shared by contained and permission-aware spawners.
 * @since 1.0.0
 */
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
/**
 * Reads only an own data property, without invoking an accessor.
 * @private
 * @since 1.0.0
 */
export declare const isContained: (spawner: ChildProcessSpawner["Service"]) => boolean;
/**
 * Marks a newly constructed service without copying through object spreads.
 * @private
 * @since 1.0.0
 */
export declare const mark: (spawner: ChildProcessSpawner["Service"]) => ChildProcessSpawner["Service"];
/**
 * Preserves the declaration on a wrapper that delegates its process lifetime.
 * @private
 * @since 1.0.0
 */
export declare const inherit: (source: ChildProcessSpawner["Service"], wrapper: ChildProcessSpawner["Service"]) => ChildProcessSpawner["Service"];
