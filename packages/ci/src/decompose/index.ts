/**
 * The decompose part: splits a coarse CI step into steps that name what
 * they read (contract 10, `Decompose`).
 *
 * @since 0.1.0
 */

import { close, groups } from "../closure/zig/index.ts"
import { splitWith } from "./Split.vibe"

export { type Options, splitWith } from "./Split.vibe"

/**
 * Splits the steps of a repository's CI, with the contract 10 type
 * `Decompose`. A step that runs `zig build` gets the files the Zig strategy
 * reports, and becomes one step per named step when its build step only
 * groups named steps.
 *
 * @category parts
 * @since 0.1.0
 */
export const split = splitWith({ zig: close, zigGroups: groups })
