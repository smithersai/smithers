/**
 * Carries environment operands before the command's stdin.
 *
 * @since 0.1.0
 */
import * as Stream from "effect/Stream";
/**
 * Reads exactly one line with the shell builtin so binary stdin remains untouched.
 * Operands must already be shell-quoted. The decoded operands set positional
 * parameters in the guest shell; their values never appear in local argv.
 * The temporary variable lives in a subshell, preserving inherited variables
 * even when the guest environment contains that same name.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const environmentInput: (operands: ReadonlyArray<string>, stdin: Uint8Array | undefined) => {
    script: string;
    prefix: string;
    stdin: Stream.Stream<Uint8Array<ArrayBufferLike>, never, never> | undefined;
};
