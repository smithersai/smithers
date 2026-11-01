/**
 * Maps signal names onto Linux signal numbers.
 *
 * @since 0.1.0
 */
import type { Signal } from "effect/process/ChildProcess";
/**
 * The Linux number of a signal name, or `undefined` for a name Linux does not
 * define (`SIGBREAK`, `SIGLOST`, `SIGINFO`).
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const linuxSignalNumber: (signal: Signal) => number | undefined;
